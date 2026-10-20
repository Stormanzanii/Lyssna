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
    PrefetchPage(String),
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
    EnsureAudio,
    BrowseInfo {
        key: String,
        generation: u64,
    },
    PlayingDetails(Track),
    /// Resolve Canvas videos ahead of playback (hovered rows, upcoming queue).
    PrefetchCanvas(Vec<String>),
    ArtistTracks {
        account: String,
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
    TrackFacts(std::collections::HashMap<String, crate::track_facts::Facts>),
    LastPlayed {
        account: String,
        value: Box<crate::resume::LastPlayed>,
    },
    PagePrefetched {
        account: String,
        key: String,
        tracks: Vec<Track>,
        info: Option<Box<BrowseInfo>>,
    },
    Canvas {
        uri: String,
        url: Option<String>,
    },
    CanvasPrefetched {
        uri: String,
        url: String,
    },
    ArtistStats {
        uri: String,
        artist_id: String,
        listeners: Option<u64>,
        /// Header photo or avatar, used when the artist has no other picture.
        image: Option<String>,
        verified: Option<bool>,
        biography: String,
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
    LoginFailed(auth::LoginIssue),
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
        let (facts, fact_requests) = mpsc::sync_channel::<FactsRequest>(32);
        let fact_events = send_events.clone();
        let fact_context = context.clone();
        thread::spawn(move || {
            let mut catalogue = crate::track_facts::Catalogue::default();
            while let Ok(mut request) = fact_requests.recv() {
                let values =
                    catalogue.enrich(&request.native, &mut request.spotify, request.tracks);
                let _ = fact_events.send(Event::TrackFacts(values));
                fact_context.request_repaint();
            }
        });
        let (prefetch, requests) = mpsc::sync_channel::<PrefetchRequest>(1);
        let prefetch_events = send_events.clone();
        let prefetch_context = context.clone();
        thread::spawn(move || {
            while let Ok(mut request) = requests.recv() {
                let mut info = request
                    .key
                    .split_once(':')
                    .filter(|(kind, _)| matches!(*kind, "album" | "artist"))
                    .and_then(|(kind, id)| {
                        request
                            .native
                            .catalogue(kind, id, 0)
                            .ok()
                            .and_then(|entity| {
                                let mut info =
                                    crate::catalogue::base_info(&entity, kind, id).ok()?;
                                if kind == "artist" {
                                    info.overview = crate::artist::from_entity(&entity, id).ok();
                                } else {
                                    info.album_details = Some(crate::album::parse(&entity));
                                }
                                Some(info)
                            })
                    })
                    .or_else(|| crate::library_cache::info(&request.account, &request.key))
                    .or_else(|| {
                        if request.key.starts_with("artist:") || request.key.starts_with("album:") {
                            request.spotify.browse_info(&request.key).ok()
                        } else {
                            None
                        }
                    });
                if let Some(info) = info.as_mut() {
                    if let Some(id) = request.key.strip_prefix("artist:")
                        && info.overview.is_none()
                    {
                        info.overview = request
                            .native
                            .catalogue("artist", id, 0)
                            .and_then(|entity| crate::artist::from_entity(&entity, id))
                            .or_else(|_| crate::artist::fetch(&request.spotify.client, id))
                            .ok();
                    }
                    if let Some(id) = request.key.strip_prefix("album:")
                        && info.album_details.is_none()
                    {
                        info.album_details = request
                            .native
                            .catalogue("album", id, 0)
                            .map(|entity| crate::album::parse(&entity))
                            .or_else(|_| crate::album::fetch(&request.spotify.client, id))
                            .ok();
                    }
                }
                info = info.map(|info| crate::library_cache::save_info(&request.account, info));
                if let Ok(tracks) =
                    fetch_tracks(&mut request.spotify, &request.native, &request.key, 0)
                {
                    let _ = prefetch_events.send(Event::PagePrefetched {
                        account: request.account,
                        key: request.key,
                        tracks,
                        info: info.map(Box::new),
                    });
                    prefetch_context.request_repaint();
                }
            }
        });
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
                facts,
                prefetch,
                spotify: None,
                native: None,
                native_controls: backend_controls,
                native_generation: 0,
                library_refresh: LibraryRefresh::default(),
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
                        let restoring = matches!(command, Command::Restore(..));
                        let login =
                            matches!(command, Command::LoginResult { .. } | Command::Restore(..));
                        match backend.handle(command) {
                            Err(error) if login => {
                                backend.emit(Event::LoginFailed(auth::LoginIssue::from_error(
                                    &error, restoring,
                                )));
                            }
                            Err(error) => backend.emit(Event::Error(error.to_string())),
                            Ok(()) if login => backend.emit(Event::LoginFinished),
                            Ok(()) => {}
                        }
                    }
                    Err(mpsc::RecvTimeoutError::Timeout) => {}
                }
                if backend
                    .spotify
                    .as_ref()
                    .is_some_and(|api| !api.cooling_down())
                    && backend.library_refresh.due(Instant::now())
                    && let Err(error) = backend.refresh_library()
                {
                    backend.emit(Event::Error(error.to_string()));
                }
                if backend
                    .spotify
                    .as_ref()
                    .is_some_and(|api| !api.cooling_down())
                    && Instant::now() >= next_poll
                {
                    if let Err(error) = backend.poll() {
                        backend.emit(Event::Error(error.to_string()));
                    }
                    next_poll = Instant::now()
                        + Duration::from_secs(if backend.native.is_some() { 60 } else { 12 });
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
    library_refresh: LibraryRefresh,
    facts: mpsc::SyncSender<FactsRequest>,
    prefetch: mpsc::SyncSender<PrefetchRequest>,
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

#[derive(Default)]
struct LibraryRefresh {
    next: Option<Instant>,
}
impl LibraryRefresh {
    fn due(&self, now: Instant) -> bool {
        self.next.is_some_and(|next| now >= next)
    }
    fn fetch<T>(&mut self, now: Instant, fetch: impl FnOnce() -> Result<T>) -> Result<T> {
        let result = fetch();
        self.next = result.as_ref().err().map(|_| now + Duration::from_secs(30));
        result
    }
}

fn profile_for_session(
    remote: Result<Profile>,
    cached: Option<Profile>,
    restoring: bool,
) -> Result<Profile> {
    match remote {
        Ok(profile) => Ok(profile),
        Err(error) => {
            if restoring
                && error
                    .downcast_ref::<crate::api_backoff::CoolingDown>()
                    .is_some()
                && let Some(profile) = cached
            {
                return Ok(profile);
            }
            Err(error)
        }
    }
}
impl Drop for Backend {
    fn drop(&mut self) {
        if let Some(spotify) = &self.spotify {
            spotify.cancel_background();
        }
    }
}
impl Backend {
    fn emit(&self, event: Event) {
        let _ = self.events.send(event);
        self.context.request_repaint();
    }

    fn establish(&mut self, tokens: Tokens, client_id: String, restoring: bool) -> Result<()> {
        // Audio login is slow and needs only the account, so start it from the
        // stored profile while the Web API session is still being verified.
        let early_audio = restoring
            .then(|| tokens.profile.clone())
            .flatten()
            .map(|profile| {
                self.profile = profile;
                let _ = self.start_audio();
                self.profile.id.clone()
            });
        let result = self.establish_session(tokens, client_id, restoring, early_audio.as_deref());
        if result.is_err() && early_audio.is_some() {
            self.native.take();
        }
        result
    }

    fn establish_session(
        &mut self,
        mut tokens: Tokens,
        client_id: String,
        restoring: bool,
        early_audio: Option<&str>,
    ) -> Result<()> {
        tokens.refresh_if_needed(&self.client, &client_id)?;
        let cached = tokens.profile.clone();
        let mut spotify = Spotify::new(self.client.clone(), client_id.clone(), tokens);
        self.profile = profile_for_session(spotify.profile(), cached, restoring)?;
        spotify.tokens.profile = Some(self.profile.clone());
        spotify.tokens.save(&client_id)?;
        self.client_id = client_id;
        if let Some(previous) = self.spotify.as_ref() {
            previous.cancel_background();
        }
        self.spotify = Some(spotify);
        self.emit(Event::Session(self.profile.clone()));
        if let Some(playlists) = crate::library_cache::load(&self.profile.id) {
            self.emit(Event::Library(playlists));
        }
        if early_audio != Some(self.profile.id.as_str())
            && let Err(error) = self.start_audio()
        {
            self.emit(Event::Error(error.to_string()));
        }
        if let Err(error) = self.refresh_library() {
            self.emit(Event::Error(error.to_string()));
        }
        if let Err(error) = self.poll() {
            self.emit(Event::Error(error.to_string()));
        }
        if let Ok(Some(value)) = self.api()?.last_played() {
            self.emit(Event::LastPlayed {
                account: self.profile.id.clone(),
                value: Box::new(value),
            });
        }
        Ok(())
    }

    fn api(&mut self) -> Result<&mut Spotify> {
        self.spotify.as_mut().context("Sign in to Spotify first")
    }

    fn refresh_library(&mut self) -> Result<()> {
        let api = self.spotify.as_mut().context("Sign in to Spotify first")?;
        if api.cooling_down()
            && let Some(playlists) = crate::library_cache::load(&self.profile.id)
        {
            self.library_refresh.next = Some(Instant::now() + Duration::from_secs(30));
            self.emit(Event::Library(playlists));
            return Ok(());
        }
        let playlists = self
            .library_refresh
            .fetch(Instant::now(), || api.playlists())?;
        crate::library_cache::save(&self.profile.id, &playlists);
        self.emit(Event::Library(playlists));
        Ok(())
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
        if let PlayerAction::Transfer(id) = &action
            && matches!(
                self.native_controls
                    .connection_event(Some(&self.profile.id)),
                Some(crate::native::NativeEvent::Ready(_))
            )
        {
            return self.native_controls.transfer(id);
        }
        if action.supports_native()
            && let Some(crate::native::NativeEvent::Ready(id)) = self
                .native_controls
                .connection_event(Some(&self.profile.id))
            && requested
                .as_deref()
                .is_none_or(|requested| requested == id || requested == "native")
        {
            let queued = matches!(action, PlayerAction::Enqueue(_));
            return self.native_controls.send(action).map_err(|_| {
                anyhow::anyhow!(if queued {
                    "Play a song on this computer before adding to its queue."
                } else {
                    "Native audio disconnected. Press Play to reconnect."
                })
            });
        }
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
        if self.native_controls.has_track() || self.api()?.cooling_down() {
            return Ok(());
        }
        let observed = Instant::now();
        let playback = self.api()?.playback()?;
        self.emit(Event::Playback(Box::new(playback), observed));
        Ok(())
    }

    fn handle(&mut self, command: Command) -> Result<()> {
        match command {
            Command::PrefetchPage(key) => {
                let request = PrefetchRequest {
                    spotify: self.api()?.background(),
                    native: self.native_controls.clone(),
                    account: self.profile.id.clone(),
                    key,
                };
                let _ = self.prefetch.try_send(request);
            }
            Command::Restore(client_id) => {
                self.client_id = client_id.clone();
                if let Some(tokens) = Tokens::load(&client_id)? {
                    self.establish(tokens, client_id, true)?;
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
                    self.establish(*result.map_err(anyhow::Error::msg)?, client_id, false)?;
                }
            }
            Command::Logout => {
                self.library_refresh = LibraryRefresh::default();
                self.native.take();
                let audio_deleted = crate::native::forget_credentials(&self.profile.id);
                if let Some(previous) = self.spotify.take() {
                    previous.cancel_background();
                }
                let deleted = Tokens::delete(&self.client_id);
                self.emit(Event::SignedOut);
                audio_deleted?;
                deleted?;
            }
            Command::Refresh => match self.native_controls.devices() {
                Ok(devices) => self.emit(Event::Devices(devices)),
                Err(_) if self.api()?.cooling_down() => {}
                Err(_) => {
                    self.poll()?;
                    let devices = self.api()?.devices()?;
                    self.emit(Event::Devices(devices));
                }
            },
            Command::TrackInfo(uri) => {
                if let Ok(track) = self
                    .native_controls
                    .track(&uri)
                    .or_else(|_| self.api()?.track(&uri))
                {
                    self.emit(Event::TrackInfo {
                        uri,
                        track: Box::new(track),
                    });
                }
            }
            Command::Library => {
                self.refresh_library()?;
            }
            Command::Tracks {
                key,
                offset,
                generation,
            } => {
                let result = self.fetch_tracks(&key, offset);
                match result {
                    Ok(tracks) => {
                        if (key == "liked" || key.starts_with("playlist:"))
                            && let Some(spotify) = self.spotify.as_ref()
                        {
                            let _ = self.facts.try_send(FactsRequest {
                                spotify: spotify.background(),
                                native: self.native_controls.clone(),
                                tracks: tracks.clone(),
                            });
                        }
                        self.emit(Event::Tracks {
                            key,
                            offset,
                            generation,
                            tracks,
                        });
                    }
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
            Command::EnsureAudio => {
                if !self
                    .native_controls
                    .connected_or_connecting(&self.profile.id)
                {
                    self.start_audio()?;
                }
            }
            Command::BrowseInfo { key, generation } => {
                let account = self.profile.id.clone();
                let mut info =
                    crate::library_cache::info(&account, &key).unwrap_or_else(|| BrowseInfo {
                        key: key.clone(),
                        ..BrowseInfo::default()
                    });
                self.emit(Event::BrowseInfo {
                    generation,
                    info: Box::new(info.clone()),
                });
                if let Some(id) = key.strip_prefix("artist:") {
                    let mut api = self.api()?.background();
                    let id = id.to_owned();
                    let native = self.native_controls.clone();
                    let client = self.client.clone();
                    let events = self.events.clone();
                    let context = self.context.clone();
                    thread::spawn(move || {
                        if let Ok(overview) = native
                            .catalogue("artist", &id, 0)
                            .and_then(|entity| {
                                if let Ok(base) =
                                    crate::catalogue::base_info(&entity, "artist", &id)
                                {
                                    info = base;
                                    publish_browse_info(
                                        &events,
                                        &context,
                                        &account,
                                        generation,
                                        info.clone(),
                                    );
                                }
                                crate::artist::from_entity(&entity, &id)
                            })
                            .or_else(|_| {
                                if info.title.is_empty()
                                    && let Ok(base) = api.browse_info(&info.key)
                                {
                                    info = base;
                                    publish_browse_info(
                                        &events,
                                        &context,
                                        &account,
                                        generation,
                                        info.clone(),
                                    );
                                }
                                crate::artist::fetch(&client, &id)
                            })
                        {
                            let mut info = info;
                            info.overview = Some(overview);
                            publish_browse_info(&events, &context, &account, generation, info);
                        }
                    });
                } else if let Some(id) = key.strip_prefix("playlist:") {
                    let id = id.to_owned();
                    let native = self.native_controls.clone();
                    let events = self.events.clone();
                    let context = self.context.clone();
                    thread::spawn(move || {
                        if let Ok(info) = native.playlist_info(&id) {
                            publish_browse_info(&events, &context, &account, generation, info);
                        }
                    });
                } else if let Some(id) = key.strip_prefix("album:") {
                    let mut api = self.api()?.background();
                    let id = id.to_owned();
                    let native = self.native_controls.clone();
                    let client = self.client.clone();
                    let events = self.events.clone();
                    let context = self.context.clone();
                    thread::spawn(move || {
                        let desktop = native.catalogue("album", &id, 0).map(|entity| {
                            if let Ok(base) = crate::catalogue::base_info(&entity, "album", &id) {
                                info = base;
                            }
                            let mut details = crate::album::parse(&entity);
                            let total = entity["tracksV2"]["totalCount"]
                                .as_u64()
                                .unwrap_or_default()
                                as usize;
                            let mut offset =
                                entity["tracksV2"]["items"].as_array().map_or(0, Vec::len);
                            let mut preview = info.clone();
                            preview.album_details = Some(details.clone());
                            publish_browse_info(&events, &context, &account, generation, preview);
                            while offset > 0 && offset < total && offset < 5000 {
                                let Ok(page) = native.catalogue("album", &id, offset) else {
                                    break;
                                };
                                let count =
                                    page["tracksV2"]["items"].as_array().map_or(0, Vec::len);
                                if count == 0 {
                                    break;
                                }
                                let next = crate::album::parse(&page);
                                let before = details.streams.len();
                                details.streams.extend(next.streams);
                                if before == details.streams.len() {
                                    break;
                                }
                                details.duration_ms += next.duration_ms;
                                offset += count;
                            }
                            details.complete_duration = offset >= total;
                            details
                        });
                        if let Ok(mut details) = desktop.or_else(|_| {
                            if info.title.is_empty()
                                && let Ok(base) = api.browse_info(&info.key)
                            {
                                info = base;
                                publish_browse_info(
                                    &events,
                                    &context,
                                    &account,
                                    generation,
                                    info.clone(),
                                );
                            }
                            crate::album::fetch(&client, &id)
                        }) {
                            let mut preview = info.clone();
                            preview.album_details = Some(details.clone());
                            publish_browse_info(&events, &context, &account, generation, preview);
                            if let Some(artist_id) = info
                                .album
                                .as_ref()
                                .and_then(|album| album.artists.first())
                                .and_then(|artist| artist.id.as_deref())
                                && let Ok(artist) = crate::artist::fetch(&client, artist_id)
                            {
                                for popular in artist.popular {
                                    if let Some(streams) = popular.streams {
                                        details.streams.entry(popular.track.uri).or_insert(streams);
                                    }
                                }
                            }
                            let mut info = info;
                            info.album_details = Some(details);
                            publish_browse_info(&events, &context, &account, generation, info);
                        }
                    });
                }
            }
            Command::ArtistTracks {
                account,
                generation,
                mut info,
            } => {
                if self.profile.id != account {
                    return Ok(());
                }
                if let Some(overview) = info.overview.as_mut() {
                    let mut statuses = Vec::new();
                    {
                        let api = self.api()?;
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
            Command::PrefetchCanvas(uris) => {
                let native = self.native_controls.clone();
                let events = self.events.clone();
                thread::spawn(move || {
                    for uri in uris.into_iter().take(8) {
                        if let Some(url) = canvas_url(&native, &uri) {
                            let _ = events.send(Event::CanvasPrefetched { uri, url });
                        }
                    }
                });
            }
            Command::PlayingDetails(track) => {
                let canvas_track = track.uri.clone();
                let native = self.native_controls.clone();
                let events = self.events.clone();
                let context = self.context.clone();
                thread::spawn(move || {
                    let url = canvas_url(&native, &canvas_track);
                    let _ = events.send(Event::Canvas {
                        uri: canvas_track,
                        url,
                    });
                    context.request_repaint();
                });
                let local = self.native_controls.has_track();
                let artists = if local {
                    track
                        .artists
                        .iter()
                        .map(|artist| {
                            artist
                                .id
                                .as_ref()
                                .and_then(|id| {
                                    crate::library_cache::info(
                                        &self.profile.id,
                                        &format!("artist:{id}"),
                                    )
                                })
                                .and_then(|info| info.artist)
                                .unwrap_or_else(|| artist.clone())
                        })
                        .collect()
                } else {
                    let mut artists = Vec::new();
                    for artist in &track.artists {
                        if let Some(id) = &artist.id
                            && let Ok(artist) = self.api()?.artist(id)
                        {
                            artists.push(artist);
                        }
                    }
                    artists
                };
                let queue = if local {
                    self.native_controls.queue().unwrap_or_default()
                } else {
                    self.api()?.queue().unwrap_or_default()
                };
                {
                    // Warm the next tracks' Canvas so skipping shows video at once.
                    let upcoming: Vec<String> = queue
                        .iter()
                        .take(3)
                        .map(|track| track.uri.clone())
                        .collect();
                    let native = self.native_controls.clone();
                    let events = self.events.clone();
                    thread::spawn(move || {
                        for uri in upcoming {
                            if let Some(url) = canvas_url(&native, &uri) {
                                let _ = events.send(Event::CanvasPrefetched { uri, url });
                            }
                        }
                    });
                }
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
                        if let Ok(overview) = crate::artist::fetch(&client, &artist_id) {
                            let _ = events.send(Event::ArtistStats {
                                uri,
                                artist_id,
                                listeners: overview.monthly_listeners,
                                image: overview.header_image.or(overview.avatar_image),
                                verified: overview.verified,
                                biography: overview.biography,
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
        let native = self.native_controls.clone();
        fetch_tracks(self.api()?, &native, key, offset)
    }
}
struct PrefetchRequest {
    spotify: Spotify,
    native: NativeControls,
    account: String,
    key: String,
}
fn publish_browse_info(
    events: &mpsc::Sender<Event>,
    context: &Notifier,
    account: &str,
    generation: u64,
    info: BrowseInfo,
) {
    let info = crate::library_cache::save_info(account, info);
    let _ = events.send(Event::BrowseInfo {
        generation,
        info: Box::new(info),
    });
    context.request_repaint();
}
struct FactsRequest {
    spotify: Spotify,
    native: NativeControls,
    tracks: Vec<Track>,
}
fn fetch_tracks(
    api: &mut Spotify,
    native: &NativeControls,
    key: &str,
    offset: usize,
) -> Result<Vec<Track>> {
    let account = api
        .tokens
        .profile
        .as_ref()
        .map(|profile| profile.id.clone());
    let result = fetch_live_tracks(api, native, key, offset);
    match result {
        Ok(tracks) => {
            if let Some(account) = account {
                crate::library_cache::save_tracks(&account, key, offset, &tracks);
            }
            Ok(tracks)
        }
        Err(error) => {
            if let Some(account) = account
                && let Some(tracks) = crate::library_cache::tracks(&account, key, offset)
            {
                return Ok(tracks);
            }
            Err(error)
        }
    }
}
fn fetch_live_tracks(
    api: &mut Spotify,
    native: &NativeControls,
    key: &str,
    offset: usize,
) -> Result<Vec<Track>> {
    if let Some(query) = key.strip_prefix("search:") {
        native.playlist_tracks(key, offset).or_else(|_| {
            if offset == 0 {
                api.search(query)
            } else {
                Ok(Vec::new())
            }
        })
    } else if let Some(id) = key.strip_prefix("playlist:") {
        match native.playlist_tracks(id, offset) {
            Ok(tracks) => Ok(tracks),
            Err(_) => api.playlist_tracks(id, offset),
        }
    } else if let Some(id) = key.strip_prefix("album:") {
        native
            .playlist_tracks(key, offset)
            .or_else(|_| api.album_tracks(id, offset))
    } else if key.starts_with("artist:") {
        Ok(Vec::new())
    } else {
        match key {
            "liked" => native
                .playlist_tracks("liked", offset)
                .or_else(|_| api.saved_tracks(offset)),
            "queue" if native.has_track() => native.queue(),
            "queue" => api.queue(),
            // Spotify keeps only the latest 50 plays, so there is no second page.
            _ if offset > 0 => Ok(Vec::new()),
            _ => api.recent(),
        }
    }
}

/// Canvas video URL for a track, from the cache or the Spotify Connect
/// metadata service.
fn canvas_url(native: &NativeControls, uri: &str) -> Option<String> {
    if let Some(url) = crate::canvas::cached(uri) {
        return url;
    }
    let bytes = native
        .metadata(
            uri,
            librespot_protocol::extension_kind::ExtensionKind::CANVAS_V1,
        )
        .ok()?;
    let url = crate::canvas::video_url(&bytes, uri).ok().flatten();
    crate::canvas::remember(uri, url.clone());
    url
}

#[cfg(test)]
mod session_tests {
    use super::*;
    #[test]
    fn local_song_details_do_not_spend_web_api_quota() {
        let client = auth::http_client().unwrap();
        let mut spotify = Spotify::new(
            client.clone(),
            "test-local-song-details".into(),
            Tokens {
                access_token: String::new(),
                refresh_token: String::new(),
                expires_at: u64::MAX,
                scopes: String::new(),
                profile: None,
            },
        );
        let attempts = spotify.count_network_attempts();
        let (native_controls, mut native_commands) =
            NativeControls::test_active("test-local-song-details");
        let mut backend = Backend {
            library_refresh: Default::default(),
            facts: mpsc::sync_channel(1).0,
            prefetch: mpsc::sync_channel(1).0,
            native_controls,
            spotify: Some(spotify),
            native: None,
            native_generation: 0,
            client_id: "test-local-song-details".into(),
            profile: Profile {
                id: "test-local-song-details".into(),
                ..Default::default()
            },
            client,
            events: mpsc::channel().0,
            native_events: mpsc::channel().0,
            lyrics: mpsc::channel().0,
            context: Default::default(),
        };
        for index in 0..3 {
            backend
                .handle(Command::PlayingDetails(Track {
                    uri: format!("spotify:track:{index:022}"),
                    artists: vec![crate::model::Artist {
                        id: Some("invalid-test-artist".into()),
                        name: "Test artist".into(),
                        ..Default::default()
                    }],
                    ..Default::default()
                }))
                .unwrap();
        }
        assert_eq!(
            attempts.load(std::sync::atomic::Ordering::Relaxed),
            0,
            "Local song changes must use native queue data rather than polling the Web API"
        );
        backend.poll().unwrap();
        backend.handle(Command::Refresh).unwrap();
        assert!(
            backend
                .player(PlayerAction::Transfer("test-device".into()), None)
                .is_err()
        );
        backend
            .player(
                PlayerAction::Enqueue("spotify:track:0000000000000000000001".into()),
                Some("test-device".into()),
            )
            .unwrap();
        assert!(matches!(
            native_commands.try_recv(),
            Ok(PlayerAction::Enqueue(_))
        ));
        assert_eq!(attempts.load(std::sync::atomic::Ordering::Relaxed), 0);
        backend.native_controls = NativeControls::default();
        backend
            .handle(Command::PlayingDetails(Track::default()))
            .unwrap();
        assert_eq!(
            attempts.load(std::sync::atomic::Ordering::Relaxed),
            1,
            "Remote playback retains its Web API queue lookup"
        );
    }
    #[test]
    fn a_failed_startup_library_fetch_is_retried_without_another_login() {
        let mut refresh = LibraryRefresh::default();
        let now = Instant::now();
        let failure =
            refresh.fetch::<Vec<Playlist>>(now, || anyhow::bail!("Temporary catalogue failure"));
        assert!(failure.is_err());
        assert!(!refresh.due(now + Duration::from_secs(1)));
        assert!(
            refresh.due(now + Duration::from_secs(30)),
            "Missing library must schedule recovery"
        );
        let playlists = refresh
            .fetch(now + Duration::from_secs(30), || {
                Ok((0..36)
                    .map(|index| Playlist {
                        id: format!("playlist-{index}"),
                        ..Default::default()
                    })
                    .collect::<Vec<_>>())
            })
            .unwrap();
        assert_eq!(playlists.len(), 36);
        assert!(!refresh.due(now + Duration::from_secs(60)));
    }
    #[test]
    fn cached_profiles_only_restore_the_same_session_during_cooldown() {
        let cached = Profile {
            id: "existing".into(),
            ..Profile::default()
        };
        assert_eq!(
            profile_for_session(
                Err(crate::api_backoff::CoolingDown(60).into()),
                Some(cached.clone()),
                true
            )
            .unwrap()
            .id,
            "existing"
        );
        assert!(
            profile_for_session(
                Err(crate::api_backoff::CoolingDown(60).into()),
                Some(cached.clone()),
                false
            )
            .is_err()
        );
        assert!(
            profile_for_session(Err(anyhow::anyhow!("unauthorized")), Some(cached), true).is_err()
        );
    }
}
