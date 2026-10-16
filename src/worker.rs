use std::{
    path::PathBuf,
    sync::{Arc, atomic::AtomicBool, mpsc},
    thread,
    time::{Duration, Instant},
};

use crate::notify::Notifier;
use anyhow::{Context, Result};

use crate::{
    api::{PlayerAction, Spotify},
    auth::{self, Tokens},
    lyrics::{self, Lyrics},
    model::{BrowseInfo, Device, Playback, PlayingDetails, Playlist, Profile, Track},
    native::{NativeControls, NativeMessage, NativePlayer},
};

pub enum Command {
    Restore(String),
    Login(String, Arc<AtomicBool>),
    LoginResult {
        client_id: String,
        cancelled: Arc<AtomicBool>,
        result: std::result::Result<Box<Tokens>, String>,
    },
    Logout,
    Refresh,
    Library,
    Tracks {
        key: String,
        offset: usize,
        generation: u64,
    },
    Player {
        action: PlayerAction,
        device: Option<String>,
    },
    Add {
        playlist: Playlist,
        tracks: Vec<Track>,
    },
    SaveTrack(String),
    FetchLyrics(Track),
    RetryAudio,
    BrowseInfo {
        key: String,
        generation: u64,
    },
    PlayingDetails(Track),
    ArtistTracks {
        generation: u64,
        info: Box<BrowseInfo>,
    },
    TrackInfo(String),
    SetSaved {
        uri: String,
        saved: bool,
    },
    Shutdown,
}

pub enum Event {
    Canvas {
        uri: String,
        url: Option<String>,
    },
    ArtistStats {
        uri: String,
        artist_id: String,
        listeners: u64,
    },
    TrackInfo {
        uri: String,
        track: Box<Track>,
    },
    BrowseInfo {
        generation: u64,
        info: Box<BrowseInfo>,
    },
    PlayingDetails {
        uri: String,
        details: Box<PlayingDetails>,
    },
    Saved {
        uri: String,
        saved: bool,
    },
    Session(Profile),
    SignedOut,
    LoginFinished,
    NativeStarting(u64),
    Library(Vec<Playlist>),
    Tracks {
        key: String,
        offset: usize,
        generation: u64,
        tracks: Vec<Track>,
    },
    TracksFailed {
        generation: u64,
        message: String,
    },
    Playback(Box<Playback>, Instant),
    Devices(Vec<Device>),
    Notice(String),
    Error(String),
}

pub struct Worker {
    pub native_controls: NativeControls,
    pub commands: mpsc::Sender<Command>,
    pub events: mpsc::Receiver<Event>,
    pub native_events: mpsc::Receiver<NativeMessage>,
    pub lyrics: mpsc::Sender<LyricCommand>,
    pub lyric_events: mpsc::Receiver<LyricEvent>,
}

pub enum LyricCommand {
    ImportText {
        track: Track,
        filename: String,
        contents: String,
    },
    Fetch(Track, String),
    Import(Track, PathBuf),
    /// Drop lyrics imported for a track; a following fetch uses the provider.
    Forget(Track),
    Configure {
        host: String,
        consent: bool,
    },
    ConfigureSpicy {
        key: String,
        consent: bool,
    },
}

pub struct LyricEvent {
    pub uri: String,
    pub result: Result<Lyrics, String>,
}

impl Worker {
    pub fn start(context: Notifier) -> Self {
        let native_controls = NativeControls::default();
        let backend_controls = native_controls.clone();
        let (commands, receive_commands) = mpsc::channel();
        let login_results = commands.clone();
        let (send_events, events) = mpsc::channel();
        let (send_native, native_events) = mpsc::channel();
        let (lyrics, receive_lyrics) = mpsc::channel();
        let (send_lyrics, lyric_events) = mpsc::channel();
        let lyric_context = context.clone();
        let backend_lyrics = lyrics.clone();
        thread::spawn(move || {
            let client = match auth::http_client() {
                Ok(client) => client,
                Err(error) => {
                    let _ = send_events.send(Event::Error(error.to_string()));
                    context.request_repaint();
                    return;
                }
            };
            let mut backend = Backend {
                spotify: None,
                native: None,
                native_controls: backend_controls,
                native_generation: 0,
                client_id: String::new(),
                profile: Profile::default(),
                client,
                events: send_events,
                native_events: send_native,
                lyrics: backend_lyrics,
                context,
            };
            let mut next_poll = Instant::now() + Duration::from_secs(4);
            loop {
                match receive_commands.recv_timeout(Duration::from_millis(250)) {
                    Ok(Command::Shutdown) | Err(mpsc::RecvTimeoutError::Disconnected) => break,
                    Ok(command) => {
                        if let Command::Login(client_id, cancelled) = command {
                            let client = backend.client.clone();
                            let reply = login_results.clone();
                            thread::spawn(move || {
                                let result = auth::login(&client, &client_id, &cancelled)
                                    .map(Box::new)
                                    .map_err(|error| error.to_string());
                                let _ = reply.send(Command::LoginResult {
                                    client_id,
                                    cancelled,
                                    result,
                                });
                            });
                            continue;
                        }
                        if let Command::LoginResult { ref cancelled, .. } = command
                            && cancelled.load(std::sync::atomic::Ordering::Relaxed)
                        {
                            continue;
                        }
                        let login =
                            matches!(command, Command::LoginResult { .. } | Command::Restore(..));
                        if let Err(error) = backend.handle(command) {
                            backend.emit(Event::Error(error.to_string()));
                        }
                        if login {
                            backend.emit(Event::LoginFinished);
                        }
                    }
                    Err(mpsc::RecvTimeoutError::Timeout) => {}
                }
                if backend.spotify.is_some() && Instant::now() >= next_poll {
                    if let Err(error) = backend.poll() {
                        backend.emit(Event::Error(error.to_string()));
                    }
                    next_poll = Instant::now() + Duration::from_secs(4);
                }
            }
        });
        thread::spawn(move || {
            let Ok(client) = auth::http_client() else {
                return;
            };
            while let Ok(command) = receive_lyrics.recv() {
                let (track, result) = match command {
                    LyricCommand::ImportText {
                        track,
                        filename,
                        contents,
                    } => {
                        let result = lyrics::import_text(&filename, &contents, &track);
                        (track, result)
                    }
                    LyricCommand::Fetch(track, token) => {
                        let result = lyrics::fetch(&client, &track, &token);
                        (track, result)
                    }
                    LyricCommand::Import(track, path) => {
                        let result = lyrics::import_file(&path, &track);
                        (track, result)
                    }
                    LyricCommand::Forget(track) => {
                        let _ = lyrics::forget_local(&track);
                        continue;
                    }
                    LyricCommand::Configure { host, consent } => {
                        let result = crate::provider::configure(&host, consent)
                            .map(|_| Lyrics::default())
                            .map_err(|error| error.to_string());
                        let _ = send_lyrics.send(LyricEvent {
                            uri: String::new(),
                            result,
                        });
                        lyric_context.request_repaint();
                        continue;
                    }
                    LyricCommand::ConfigureSpicy { key, consent } => {
                        let result = crate::provider::configure_spicy(&key, consent)
                            .map(|_| Lyrics::default())
                            .map_err(|error| error.to_string());
                        let _ = send_lyrics.send(LyricEvent {
                            uri: String::new(),
                            result,
                        });
                        lyric_context.request_repaint();
                        continue;
                    }
                };
                let _ = send_lyrics.send(LyricEvent {
                    uri: track.uri,
                    result: result.map_err(|error| error.to_string()),
                });
                lyric_context.request_repaint();
            }
        });
        Self {
            native_controls,
            commands,
            events,
            native_events,
            lyrics,
            lyric_events,
        }
    }
}

impl Drop for Worker {
    fn drop(&mut self) {
        let _ = self.commands.send(Command::Shutdown);
    }
}

struct Backend {
    native_controls: NativeControls,
    spotify: Option<Spotify>,
    native: Option<NativePlayer>,
    native_generation: u64,
    client_id: String,
    profile: Profile,
    client: reqwest::blocking::Client,
    events: mpsc::Sender<Event>,
    native_events: mpsc::Sender<NativeMessage>,
    lyrics: mpsc::Sender<LyricCommand>,
    context: Notifier,
}

impl Backend {
    fn emit(&self, event: Event) {
        let _ = self.events.send(event);
        self.context.request_repaint();
    }

    fn establish(&mut self, mut tokens: Tokens, client_id: String) -> Result<()> {
        tokens.refresh_if_needed(&self.client, &client_id)?;
        let mut spotify = Spotify::new(self.client.clone(), client_id.clone(), tokens);
        self.profile = spotify.profile()?;
        spotify.tokens.save(&client_id)?;
        self.client_id = client_id;
        self.spotify = Some(spotify);
        self.emit(Event::Session(self.profile.clone()));
        if let Err(error) = self.start_audio() {
            self.emit(Event::Error(error.to_string()));
        }
        let playlists = self.api()?.playlists();
        match playlists {
            Ok(playlists) => self.emit(Event::Library(playlists)),
            Err(error) => self.emit(Event::Error(error.to_string())),
        }
        self.poll()
    }

    fn api(&mut self) -> Result<&mut Spotify> {
        self.spotify.as_mut().context("Sign in to Spotify first")
    }

    fn start_audio(&mut self) -> Result<()> {
        self.native.take();
        self.native_generation = self.native_generation.wrapping_add(1);
        self.emit(Event::NativeStarting(self.native_generation));
        self.native = Some(NativePlayer::start(
            self.profile.id.clone(),
            self.native_generation,
            self.native_events.clone(),
            self.context.clone(),
            self.native_controls.clone(),
        ));
        self.emit(Event::Notice("Connecting native audio…".into()));
        Ok(())
    }

    /// Send a player command, resolving the device through Spotify's device
    /// list. This computer's player can take a few seconds to appear there
    /// after it connects, so look again briefly before giving up.
    fn player(&mut self, action: PlayerAction, device: Option<String>) -> Result<()> {
        let own = crate::native::device_name();
        let requested = match &action {
            PlayerAction::Transfer(id) => Some(id.clone()),
            _ => device,
        };
        for attempt in 0..4 {
            let devices = self.api()?.devices()?;
            let _ = self.events.send(Event::Devices(devices.clone()));
            if let Some(id) = crate::model::resolve_device(&devices, requested.as_deref(), &own) {
                return match action {
                    PlayerAction::Transfer(_) => {
                        self.api()?.player_action(PlayerAction::Transfer(id), None)
                    }
                    action => self.api()?.player_action(action, Some(&id)),
                };
            }
            if self.native.is_none() || attempt == 3 {
                break;
            }
            thread::sleep(Duration::from_millis(1200));
        }
        anyhow::bail!(if self.native.is_some() {
            "This computer is not ready for playback yet. Wait a moment, or reconnect native audio in Settings."
        } else {
            "No playback device. Reconnect native audio in Settings, or open Spotify on another device."
        })
    }

    fn poll(&mut self) -> Result<()> {
        let observed = Instant::now();
        let playback = self.api()?.playback()?;
        self.emit(Event::Playback(Box::new(playback), observed));
        Ok(())
    }

    fn handle(&mut self, command: Command) -> Result<()> {
        match command {
            Command::Restore(client_id) => {
                self.client_id = client_id.clone();
                if let Some(tokens) = Tokens::load(&client_id)? {
                    self.establish(tokens, client_id)?;
                } else {
                    self.emit(Event::SignedOut);
                }
            }
            Command::Login(client_id, cancelled) => {
                let _ = (client_id, cancelled);
                unreachable!("Login must run outside the API worker");
            }
            Command::LoginResult {
                client_id,
                cancelled,
                result,
            } => {
                if !cancelled.load(std::sync::atomic::Ordering::Relaxed) {
                    self.establish(*result.map_err(anyhow::Error::msg)?, client_id)?;
                }
            }
            Command::Logout => {
                self.native.take();
                let audio_deleted = crate::native::forget_credentials(&self.profile.id);
                self.spotify.take();
                let deleted = Tokens::delete(&self.client_id);
                self.emit(Event::SignedOut);
                audio_deleted?;
                deleted?;
            }
            Command::Refresh => {
                self.poll()?;
                let devices = self.api()?.devices()?;
                self.emit(Event::Devices(devices));
            }
            Command::TrackInfo(uri) => {
                let track = self.api()?.track(&uri)?;
                self.emit(Event::TrackInfo {
                    uri,
                    track: Box::new(track),
                });
            }
            Command::Library => {
                let playlists = self.api()?.playlists()?;
                self.emit(Event::Library(playlists));
            }
            Command::Tracks {
                key,
                offset,
                generation,
            } => {
                let result = self.fetch_tracks(&key, offset);
                match result {
                    Ok(tracks) => self.emit(Event::Tracks {
                        key,
                        offset,
                        generation,
                        tracks,
                    }),
                    Err(error) => self.emit(Event::TracksFailed {
                        generation,
                        message: error.to_string(),
                    }),
                }
            }
            Command::Player { action, device } => {
                let queued = matches!(action, PlayerAction::Enqueue(_));
                self.player(action, device)?;
                if queued {
                    self.emit(Event::Notice("Added to queue".into()));
                }
                let _ = self.poll();
            }
            Command::Add { playlist, tracks } => {
                anyhow::ensure!(
                    playlist.editable_by(&self.profile.id),
                    "This playlist cannot be edited by your account"
                );
                let count = self.api()?.add_to_playlist(&playlist.id, &tracks)?;
                self.emit(Event::Notice(format!(
                    "Added {count} tracks to {}. Existing tracks skipped.",
                    playlist.name
                )));
            }
            Command::SaveTrack(uri) => {
                self.api()?.save_track(&uri)?;
                self.emit(Event::Notice("Saved to Liked Songs".into()));
            }
            Command::FetchLyrics(track) => {
                let api = self.api()?;
                let token = if crate::provider::requires_spotify_token() {
                    api.tokens.refresh_if_needed(&api.client, &api.client_id)?;
                    api.tokens.access_token.clone()
                } else {
                    String::new()
                };
                let _ = self.lyrics.send(LyricCommand::Fetch(track, token));
            }
            Command::RetryAudio => self.start_audio()?,
            Command::BrowseInfo { key, generation } => {
                let info = self.api()?.browse_info(&key)?;
                self.emit(Event::BrowseInfo {
                    generation,
                    info: Box::new(info.clone()),
                });
                if let Some(id) = key.strip_prefix("artist:") {
                    let id = id.to_owned();
                    let client = self.client.clone();
                    let events = self.events.clone();
                    let context = self.context.clone();
                    thread::spawn(move || {
                        if let Ok(overview) = crate::artist::fetch(&client, &id) {
                            let mut info = info;
                            info.overview = Some(overview);
                            let _ = events.send(Event::BrowseInfo {
                                generation,
                                info: Box::new(info),
                            });
                            context.request_repaint();
                        }
                    });
                }
            }
            Command::ArtistTracks {
                generation,
                mut info,
            } => {
                if let Some(overview) = info.overview.as_mut() {
                    let mut statuses = Vec::new();
                    {
                        let api = self.api()?;
                        for item in &mut overview.popular {
                            if let Ok(track) = api.track(&item.track.uri) {
                                item.track = track;
                            }
                        }
                        let uris: Vec<_> = overview
                            .popular
                            .iter()
                            .map(|item| item.track.uri.clone())
                            .collect();
                        if !uris.is_empty()
                            && let Ok(saved) = api.saved_items(&uris)
                        {
                            statuses = uris.into_iter().zip(saved).collect();
                        }
                    }
                    for (uri, saved) in statuses {
                        self.emit(Event::Saved { uri, saved });
                    }
                    overview.details_loaded = true;
                }
                self.emit(Event::BrowseInfo { generation, info });
            }
            Command::PlayingDetails(track) => {
                let canvas_track = track.uri.clone();
                let native = self.native_controls.clone();
                let events = self.events.clone();
                let context = self.context.clone();
                thread::spawn(move || {
                    let url = native
                        .metadata(
                            &canvas_track,
                            librespot_protocol::extension_kind::ExtensionKind::CANVAS_V1,
                        )
                        .ok()
                        .and_then(|bytes| {
                            crate::canvas::video_url(&bytes, &canvas_track)
                                .ok()
                                .flatten()
                        });
                    let _ = events.send(Event::Canvas {
                        uri: canvas_track,
                        url,
                    });
                    context.request_repaint();
                });
                let mut artists = Vec::new();
                for artist in &track.artists {
                    if let Some(id) = &artist.id
                        && let Ok(artist) = self.api()?.artist(id)
                    {
                        artists.push(artist);
                    }
                }
                let queue = self.api()?.queue().unwrap_or_default();
                self.emit(Event::PlayingDetails {
                    uri: track.uri.clone(),
                    details: Box::new(PlayingDetails { artists, queue }),
                });
                if let Some(artist_id) = track.artists.first().and_then(|artist| artist.id.clone())
                {
                    let client = self.client.clone();
                    let events = self.events.clone();
                    let context = self.context.clone();
                    let uri = track.uri;
                    thread::spawn(move || {
                        if let Ok(overview) = crate::artist::fetch(&client, &artist_id)
                            && let Some(listeners) = overview.monthly_listeners
                        {
                            let _ = events.send(Event::ArtistStats {
                                uri,
                                artist_id,
                                listeners,
                            });
                            context.request_repaint();
                        }
                    });
                }
            }
            Command::SetSaved { uri, saved } => {
                self.api()?.set_saved_item(&uri, saved)?;
                self.emit(Event::Saved { uri, saved });
            }
            Command::Shutdown => {}
        }
        Ok(())
    }

    fn fetch_tracks(&mut self, key: &str, offset: usize) -> Result<Vec<Track>> {
        let api = self.api()?;
        if let Some(query) = key.strip_prefix("search:") {
            api.search(query)
        } else if let Some(id) = key.strip_prefix("playlist:") {
            match api.playlist_tracks(id, offset) {
                Ok(tracks) => Ok(tracks),
                Err(_) => self.native_controls.playlist_tracks(id, offset),
            }
        } else if let Some(id) = key.strip_prefix("album:") {
            api.album_tracks(id, offset)
        } else if key.starts_with("artist:") {
            Ok(Vec::new())
        } else {
            match key {
                "liked" => api.saved_tracks(offset),
                "queue" => api.queue(),
                _ => api.recent(),
            }
        }
    }
}
