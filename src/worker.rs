use std::{
    path::PathBuf,
    sync::{Arc, atomic::AtomicBool, mpsc},
    thread,
    time::{Duration, Instant},
};

use anyhow::{Context, Result};
use eframe::egui;

use crate::{
    api::{PlayerAction, Spotify},
    auth::{self, Tokens},
    lyrics::{self, Lyrics},
    model::{Device, Playback, Playlist, Profile, Track},
    native::{NativeControls, NativeMessage, NativePlayer},
};

pub enum Command {
    Restore(String),
    Login(String, Arc<AtomicBool>),
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
    Shutdown,
}

pub enum Event {
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
    Fetch(Track, String),
    Import(Track, PathBuf),
    /// Drop lyrics imported for a track; a following fetch uses the provider.
    Forget(Track),
    Configure {
        host: String,
        consent: bool,
    },
}

pub struct LyricEvent {
    pub uri: String,
    pub result: Result<Lyrics, String>,
}

impl Worker {
    pub fn start(context: egui::Context) -> Self {
        let native_controls = NativeControls::default();
        let backend_controls = native_controls.clone();
        let (commands, receive_commands) = mpsc::channel();
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
                        let login = matches!(command, Command::Login(..) | Command::Restore(..));
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
    context: egui::Context,
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
                self.client_id = client_id.clone();
                let tokens = auth::login(&self.client, &client_id, &cancelled)?;
                if !cancelled.load(std::sync::atomic::Ordering::Relaxed) {
                    self.establish(tokens, client_id)?;
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
                self.player(action, device)?;
                self.poll()?;
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
                api.tokens.refresh_if_needed(&api.client, &api.client_id)?;
                let token = api.tokens.access_token.clone();
                let _ = self.lyrics.send(LyricCommand::Fetch(track, token));
            }
            Command::RetryAudio => self.start_audio()?,
            Command::Shutdown => {}
        }
        Ok(())
    }

    fn fetch_tracks(&mut self, key: &str, offset: usize) -> Result<Vec<Track>> {
        let api = self.api()?;
        if let Some(query) = key.strip_prefix("search:") {
            api.search(query)
        } else if let Some(id) = key.strip_prefix("playlist:") {
            api.playlist_tracks(id, offset)
        } else {
            match key {
                "liked" => api.saved_tracks(offset),
                "queue" => api.queue(),
                _ => api.recent(),
            }
        }
    }
}
