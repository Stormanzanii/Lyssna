//! Public desktop events. Tokens and the configured provider URL stay in Rust.
use crate::{
    api::PlayerAction,
    auth,
    config::{self, Settings},
    lyrics::Lyrics,
    model::{BrowseInfo, Device, Playback, PlayingDetails, Playlist, Profile, Track},
    native::{self, NativeControls, NativeEvent},
    notify::Notifier,
    updater,
    worker::{Command, Event, LyricCommand, Worker},
};
use anyhow::{Context, Result, ensure};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
        mpsc,
    },
    thread,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use tauri::{Emitter, Manager, State};

#[derive(Clone, Serialize)]
pub struct Snapshot {
    canvas_url: Option<String>,
    profile: Option<Profile>,
    playlists: Vec<Playlist>,
    playback: Playback,
    settings: Settings,
    native_ready: bool,
    local_device_name: String,
    native_status: String,
    provider_configured: bool,
    provider_builtin: bool,
    provider_kind: Option<String>,
    login_pending: bool,
    can_follow: bool,
    lyrics: Option<Lyrics>,
    lyric_error: String,
    details: PlayingDetails,
    route: String,
    generation: u64,
    tracks: Vec<Track>,
    browse_info: Option<BrowseInfo>,
    loading: bool,
    more: bool,
    update_status: String,
    update_version: Option<String>,
    notice: String,
    observed_at: u64,
}
struct Inner {
    snapshot: Mutex<Snapshot>,
    commands: mpsc::Sender<Command>,
    lyrics: mpsc::Sender<LyricCommand>,
    controls: NativeControls,
    native_id: Mutex<Option<String>>,
    generation: Mutex<u64>,
    last_native: Mutex<Option<Instant>>,
    pending_track: Mutex<Option<(String, Instant)>>,
    login_cancelled: Mutex<Arc<AtomicBool>>,
    stopped: AtomicBool,
    update_commands: mpsc::Sender<updater::Command>,
    available: Mutex<Option<updater::Update>>,
    ready_update: Mutex<Option<updater::ReadyUpdate>>,
}
pub struct Desktop(Arc<Inner>);
fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .min(u64::MAX as u128) as u64
}
fn error(error: impl std::fmt::Display) -> String {
    error.to_string()
}
fn lock<T>(value: &Mutex<T>) -> Result<std::sync::MutexGuard<'_, T>> {
    value
        .lock()
        .map_err(|_| anyhow::anyhow!("Desktop state unavailable"))
}

fn targets_local_device(target: Option<&str>, native_id: Option<&str>, device: &Device) -> bool {
    target == Some("native")
        || target.is_some_and(|target| Some(target) == native_id)
        || device.name == native::device_name()
            && (target.is_none() || target == device.id.as_deref())
}

impl Desktop {
    fn start(app: tauri::AppHandle) -> Result<Self> {
        let (settings, notice) = match Settings::load() {
            Ok(settings) => (settings, String::new()),
            Err(_) => (
                Settings::default(),
                "Existing settings could not be read. Sign in to continue.".into(),
            ),
        };
        let (wake, wakes) = mpsc::sync_channel(1);
        let notifier = Notifier::new(move || {
            let _ = wake.try_send(());
        });
        let worker = Worker::start(notifier.clone());
        let updates = updater::Updater::start(notifier);
        let restore = config::valid_client_id(&settings.client_id);
        let route = settings.last_view.clone();
        let inner = Arc::new(Inner {
            snapshot: Mutex::new(Snapshot {
                canvas_url: None,
                profile: None,
                playlists: Vec::new(),
                playback: Playback::default(),
                settings: settings.clone(),
                native_ready: false,
                local_device_name: native::device_name(),
                native_status: "Waiting for sign-in".into(),
                provider_configured: crate::provider::configured(),
                provider_builtin: crate::provider::builtin_configured(),
                provider_kind: crate::provider::kind(),
                login_pending: restore,
                can_follow: false,
                lyrics: None,
                lyric_error: String::new(),
                details: PlayingDetails::default(),
                route,
                generation: 0,
                tracks: Vec::new(),
                browse_info: None,
                loading: false,
                more: false,
                update_status: "Checking for updates…".into(),
                update_version: None,
                notice,
                observed_at: now_ms(),
            }),
            commands: worker.commands.clone(),
            lyrics: worker.lyrics.clone(),
            controls: worker.native_controls.clone(),
            native_id: Mutex::new(None),
            generation: Mutex::new(0),
            last_native: Mutex::new(None),
            pending_track: Mutex::new(None),
            login_cancelled: Mutex::new(Arc::new(AtomicBool::new(false))),
            stopped: AtomicBool::new(false),
            update_commands: updates.commands.clone(),
            available: Mutex::new(None),
            ready_update: Mutex::new(None),
        });
        if restore {
            inner.commands.send(Command::Restore(settings.client_id))?;
        }
        let pump = inner.clone();
        thread::spawn(move || {
            let emit = |value: Value| {
                let _ = app.emit("spotiflex", value);
            };
            while !pump.stopped.load(Ordering::Relaxed) {
                let _ = wakes.recv_timeout(Duration::from_millis(50));
                while let Ok(event) = worker.events.try_recv() {
                    let Ok(mut snapshot) = pump.snapshot.lock() else {
                        return;
                    };
                    match event {
                        Event::CanvasPrefetched { url } => {
                            emit(json!({"type":"canvas_prefetch","url":url}));
                        }
                        Event::Canvas { uri, url } => {
                            if snapshot
                                .playback
                                .item
                                .as_ref()
                                .is_some_and(|track| track.uri == uri)
                            {
                                snapshot.canvas_url = url.clone();
                                emit(json!({"type":"canvas","uri":uri,"url":url}));
                            }
                        }
                        Event::ArtistStats {
                            uri,
                            artist_id,
                            listeners,
                        } => {
                            if snapshot
                                .playback
                                .item
                                .as_ref()
                                .is_some_and(|track| track.uri == uri)
                            {
                                for artist in &mut snapshot.details.artists {
                                    if artist.id.as_deref() == Some(&artist_id) {
                                        artist.monthly_listeners = Some(listeners);
                                    }
                                }
                                emit(
                                    json!({"type":"playing_details","uri":uri,"details":snapshot.details}),
                                );
                            }
                        }
                        Event::TrackInfo { uri, mut track } => {
                            if snapshot
                                .playback
                                .item
                                .as_ref()
                                .is_some_and(|current| current.uri == uri)
                            {
                                track.uri = uri;
                                if track.songwriters.is_empty() {
                                    track.songwriters = snapshot
                                        .playback
                                        .item
                                        .as_ref()
                                        .map(|item| item.songwriters.clone())
                                        .unwrap_or_default();
                                }
                                snapshot.playback.item = Some(*track);
                                emit(
                                    json!({"type":"playback","playback":snapshot.playback,"observed_at":snapshot.observed_at,"changed":false}),
                                );
                            }
                        }
                        Event::Session(profile) => {
                            if !snapshot.login_pending {
                                continue;
                            }
                            snapshot.profile = Some(profile.clone());
                            snapshot.login_pending = false;
                            snapshot.can_follow = auth::Tokens::load(&snapshot.settings.client_id)
                                .ok()
                                .flatten()
                                .is_some_and(|tokens| {
                                    tokens
                                        .scopes
                                        .split_whitespace()
                                        .any(|scope| scope == "user-follow-modify")
                                });
                            emit(
                                json!({"type":"session","profile":profile,"can_follow":snapshot.can_follow}),
                            );
                        }
                        Event::SignedOut => {
                            snapshot.profile = None;
                            snapshot.login_pending = false;
                            snapshot.playlists.clear();
                            snapshot.playback = Playback::default();
                            snapshot.native_ready = false;
                            snapshot.lyrics = None;
                            snapshot.canvas_url = None;
                            snapshot.details = PlayingDetails::default();
                            snapshot.tracks.clear();
                            emit(json!({"type":"signed_out"}));
                        }
                        Event::LoginFinished => {
                            snapshot.login_pending = false;
                            emit(json!({"type":"login_finished"}));
                        }
                        Event::NativeStarting(generation) => {
                            if let Ok(mut current) = pump.generation.lock() {
                                *current = generation;
                            }
                            if let Ok(mut last) = pump.last_native.lock() {
                                *last = None;
                            }
                            snapshot.native_ready = false;
                            snapshot.native_status = "Connecting native audio…".into();
                            emit(
                                json!({"type":"native","ready":false,"status":snapshot.native_status}),
                            );
                        }
                        Event::Library(playlists) => {
                            snapshot.playlists = playlists;
                            emit(json!({"type":"library","playlists":snapshot.playlists}));
                        }
                        Event::Playback(mut playback, _observed) => {
                            if snapshot.playback.keep_native_when_empty(
                                &playback,
                                snapshot.native_ready,
                                &native::device_name(),
                            ) {
                                continue;
                            }
                            if let Ok(mut pending) = pump.pending_track.lock()
                                && let Some((uri, requested)) = pending.as_ref()
                            {
                                if playback.item.as_ref().is_none_or(|track| &track.uri != uri)
                                    && requested.elapsed() < Duration::from_secs(8)
                                {
                                    continue;
                                }
                                *pending = None;
                            }
                            let changed = snapshot.playback.item.as_ref().map(|track| &track.uri)
                                != playback.item.as_ref().map(|track| &track.uri);
                            if changed
                                && playback.device.name == native::device_name()
                                && pump
                                    .last_native
                                    .lock()
                                    .ok()
                                    .and_then(|value| *value)
                                    .is_some_and(|native| native.elapsed() < Duration::from_secs(2))
                            {
                                continue;
                            }
                            if !changed
                                && playback.device.name == native::device_name()
                                && pump
                                    .last_native
                                    .lock()
                                    .ok()
                                    .and_then(|value| *value)
                                    .is_some_and(|native| native.elapsed() < Duration::from_secs(2))
                            {
                                let elapsed = if snapshot.playback.is_playing {
                                    now_ms().saturating_sub(snapshot.observed_at)
                                } else {
                                    0
                                };
                                playback.progress_ms = snapshot
                                    .playback
                                    .progress_ms
                                    .map(|position| position.saturating_add(elapsed));
                                playback.is_playing = snapshot.playback.is_playing;
                                playback.shuffle_state = snapshot.playback.shuffle_state;
                                playback.repeat_state = snapshot.playback.repeat_state.clone();
                                playback.device.volume_percent =
                                    snapshot.playback.device.volume_percent;
                            }
                            snapshot.playback = *playback;
                            snapshot.observed_at = now_ms();
                            if changed {
                                snapshot.lyrics = None;
                                snapshot.canvas_url = None;
                                snapshot.lyric_error.clear();
                                snapshot.details = PlayingDetails::default();
                                if let Some(track) = snapshot.playback.item.clone() {
                                    let _ = pump.commands.send(Command::FetchLyrics(track.clone()));
                                    let _ = pump.commands.send(Command::PlayingDetails(track));
                                }
                            }
                            emit(
                                json!({"type":"playback","playback":snapshot.playback,"observed_at":snapshot.observed_at,"changed":changed}),
                            );
                        }
                        Event::Tracks {
                            key,
                            offset,
                            generation,
                            tracks,
                        } => {
                            if snapshot.generation != generation || snapshot.route != key {
                                continue;
                            }
                            snapshot.loading = false;
                            snapshot.more = tracks.len() == 50;
                            if offset == 0 {
                                snapshot.tracks = tracks.clone();
                            } else if snapshot.tracks.len() == offset {
                                snapshot.tracks.extend(tracks.clone());
                            }
                            emit(
                                json!({"type":"tracks","key":key,"generation":generation,"offset":offset,"tracks":tracks,"more":snapshot.more}),
                            );
                        }
                        Event::TracksFailed {
                            generation,
                            message,
                        } => {
                            if generation == snapshot.generation {
                                snapshot.loading = false;
                                emit(
                                    json!({"type":"tracks_failed","generation":generation,"message":message}),
                                );
                            }
                        }
                        Event::BrowseInfo { generation, info } => {
                            if generation == snapshot.generation {
                                if info
                                    .overview
                                    .as_ref()
                                    .is_some_and(|overview| !overview.details_loaded)
                                {
                                    let _ = pump.commands.send(Command::ArtistTracks {
                                        generation,
                                        info: info.clone(),
                                    });
                                }
                                snapshot.browse_info = Some(*info.clone());
                                emit(
                                    json!({"type":"browse_info","generation":generation,"info":info}),
                                );
                            }
                        }
                        Event::PlayingDetails { uri, details } => {
                            if snapshot
                                .playback
                                .item
                                .as_ref()
                                .is_some_and(|track| track.uri == uri)
                            {
                                snapshot.details = *details.clone();
                                emit(json!({"type":"playing_details","uri":uri,"details":details}));
                            }
                        }
                        Event::Saved { uri, saved } => {
                            emit(json!({"type":"saved","uri":uri,"saved":saved}))
                        }
                        Event::Devices(devices) => {
                            emit(json!({"type":"devices","devices":devices}))
                        }
                        Event::Notice(message) => {
                            emit(json!({"type":"notice","message":message,"error":false}))
                        }
                        Event::Error(message) => {
                            snapshot.notice = message.clone();
                            emit(json!({"type":"notice","message":message,"error":true}));
                        }
                    }
                }
                while let Ok(message) = worker.native_events.try_recv() {
                    if pump
                        .generation
                        .lock()
                        .map_or(true, |generation| *generation != message.generation)
                    {
                        continue;
                    }
                    let Ok(mut snapshot) = pump.snapshot.lock() else {
                        return;
                    };
                    if snapshot.profile.is_none() {
                        continue;
                    }
                    match message.event {
                        NativeEvent::Transport {
                            shuffle,
                            repeat,
                            volume,
                        } => {
                            if snapshot.playback.device.name == native::device_name() {
                                if let Some(shuffle) = shuffle {
                                    snapshot.playback.shuffle_state = shuffle;
                                }
                                if let Some(repeat) = repeat {
                                    snapshot.playback.repeat_state = repeat;
                                }
                                if let Some(volume) = volume {
                                    snapshot.playback.device.volume_percent = Some(volume);
                                }
                                emit(
                                    json!({"type":"playback","playback":snapshot.playback,"observed_at":snapshot.observed_at,"changed":false}),
                                );
                            }
                        }
                        NativeEvent::Track(track) => {
                            let track = *track;
                            if let Ok(mut pending) = pump.pending_track.lock()
                                && let Some((uri, requested)) = pending.as_ref()
                            {
                                if *uri != track.uri && requested.elapsed() < Duration::from_secs(8)
                                {
                                    continue;
                                }
                                *pending = None;
                            }
                            if let Some(current) = snapshot
                                .playback
                                .item
                                .as_mut()
                                .filter(|current| current.uri == track.uri)
                            {
                                current.duration_ms = track.duration_ms;
                                if !track.songwriters.is_empty() {
                                    current.songwriters = track.songwriters.clone();
                                }
                                emit(
                                    json!({"type":"playback","playback":snapshot.playback,"observed_at":snapshot.observed_at,"changed":false}),
                                );
                                continue;
                            }
                            snapshot.playback.item = Some(track.clone());
                            snapshot.playback.progress_ms = Some(0);
                            snapshot.playback.is_playing = false;
                            snapshot.playback.device.name = native::device_name();
                            snapshot.playback.device.id =
                                pump.native_id.lock().ok().and_then(|id| id.clone());
                            snapshot.playback.device.is_active = true;
                            snapshot.observed_at = now_ms();
                            snapshot.lyrics = None;
                            snapshot.canvas_url = None;
                            snapshot.lyric_error.clear();
                            snapshot.details = PlayingDetails::default();
                            if let Ok(mut pending) = pump.pending_track.lock() {
                                *pending = Some((track.uri.clone(), Instant::now()));
                            }
                            let _ = pump.commands.send(Command::TrackInfo(track.uri.clone()));
                            let _ = pump.commands.send(Command::FetchLyrics(track.clone()));
                            let _ = pump.commands.send(Command::PlayingDetails(track));
                            emit(
                                json!({"type":"playback","playback":snapshot.playback,"observed_at":snapshot.observed_at,"changed":true,"loading":true}),
                            );
                        }
                        NativeEvent::Authorizing => {
                            snapshot.native_status =
                                "Authorize audio playback in your browser…".into();
                            emit(
                                json!({"type":"native","ready":false,"status":snapshot.native_status}),
                            );
                        }
                        NativeEvent::Ready(id) => {
                            if let Ok(mut current) = pump.native_id.lock() {
                                *current = Some(id);
                            }
                            snapshot.native_ready = true;
                            snapshot.native_status = "Ready · this computer".into();
                            emit(
                                json!({"type":"native","ready":true,"status":snapshot.native_status}),
                            );
                        }
                        NativeEvent::Error(message) => {
                            snapshot.native_ready = false;
                            snapshot.native_status = message;
                            emit(
                                json!({"type":"native","ready":false,"status":snapshot.native_status}),
                            );
                        }
                        NativeEvent::ControlError(message) => {
                            emit(json!({"type":"notice","message":message,"error":true}))
                        }
                        NativeEvent::Position {
                            uri,
                            position_ms,
                            playing,
                            seeked,
                        } => {
                            let id = pump.native_id.lock().ok().and_then(|value| value.clone());
                            if snapshot.playback.apply_native_position(
                                id.as_deref(),
                                &native::device_name(),
                                &uri,
                                position_ms,
                                playing,
                            ) {
                                if playing == Some(true)
                                    && let Ok(mut pending) = pump.pending_track.lock()
                                {
                                    *pending = None;
                                }
                                if let Ok(mut last) = pump.last_native.lock() {
                                    *last = Some(Instant::now());
                                }
                                snapshot.observed_at = now_ms();
                                emit(
                                    json!({"type":"native_position","uri":uri,"position_ms":position_ms,"playing":playing,"seeked":seeked,"observed_at":snapshot.observed_at}),
                                );
                            }
                        }
                    }
                }
                while let Ok(event) = worker.lyric_events.try_recv() {
                    let Ok(mut snapshot) = pump.snapshot.lock() else {
                        return;
                    };
                    if event.uri.is_empty() {
                        match event.result {
                            Ok(_) => {
                                snapshot.provider_configured = true;
                                snapshot.provider_kind = crate::provider::kind();
                                snapshot.lyric_error.clear();
                                emit(
                                    json!({"type":"provider_configured","kind":snapshot.provider_kind}),
                                );
                                if let Some(track) = snapshot.playback.item.clone() {
                                    let _ = pump.commands.send(Command::FetchLyrics(track));
                                }
                            }
                            Err(message) => {
                                emit(json!({"type":"notice","message":message,"error":true}))
                            }
                        }
                    } else if snapshot
                        .playback
                        .item
                        .as_ref()
                        .is_some_and(|track| track.uri == event.uri)
                    {
                        match event.result {
                            Ok(lyrics) => {
                                snapshot.lyrics = Some(lyrics.clone());
                                snapshot.lyric_error.clear();
                                emit(json!({"type":"lyrics","uri":event.uri,"lyrics":lyrics}));
                            }
                            Err(message) => {
                                snapshot.lyric_error = message.clone();
                                emit(
                                    json!({"type":"lyric_error","uri":event.uri,"message":message}),
                                );
                            }
                        }
                    }
                }
                while let Ok(event) = updates.events.try_recv() {
                    let Ok(mut snapshot) = pump.snapshot.lock() else {
                        return;
                    };
                    match event {
                        updater::Event::Current => snapshot.update_status = "Up to date".into(),
                        updater::Event::Available(update) => {
                            snapshot.update_version = Some(update.manifest.version.clone());
                            snapshot.update_status = "Update available".into();
                            if snapshot.settings.auto_download_updates {
                                let _ = pump
                                    .update_commands
                                    .send(updater::Command::Download(update.clone()));
                            }
                            if let Ok(mut available) = pump.available.lock() {
                                *available = Some(update);
                            }
                        }
                        updater::Event::Progress { downloaded, total } => {
                            snapshot.update_status = format!(
                                "Downloading update · {}%",
                                downloaded.saturating_mul(100) / total.max(1)
                            )
                        }
                        updater::Event::Ready(update) => {
                            snapshot.update_status = "Ready to install".into();
                            if let Ok(mut ready) = pump.ready_update.lock() {
                                *ready = Some(update);
                            }
                        }
                        updater::Event::Restarted => {
                            app.exit(0);
                            return;
                        }
                        updater::Event::Error(message) => snapshot.update_status = message,
                    }
                    emit(
                        json!({"type":"update","status":snapshot.update_status,"version":snapshot.update_version}),
                    );
                }
            }
        });
        Ok(Self(inner))
    }
    fn stop(&self) {
        self.0.stopped.store(true, Ordering::Relaxed);
        if let Ok(cancelled) = self.0.login_cancelled.lock() {
            cancelled.store(true, Ordering::Relaxed);
        }
        let _ = self.0.commands.send(Command::Shutdown);
        let _ = self.0.update_commands.send(updater::Command::Shutdown);
    }
}

#[tauri::command]
fn bootstrap(state: State<'_, Desktop>) -> std::result::Result<Snapshot, String> {
    lock(&state.0.snapshot)
        .map(|snapshot| snapshot.clone())
        .map_err(error)
}
#[tauri::command]
fn sign_in(client_id: String, state: State<'_, Desktop>) -> std::result::Result<(), String> {
    let result = || -> Result<()> {
        ensure!(
            config::valid_client_id(&client_id),
            "Client ID must contain 32 hexadecimal characters"
        );
        let mut snapshot = lock(&state.0.snapshot)?;
        snapshot.settings.client_id = client_id.clone();
        snapshot.settings.save()?;
        snapshot.login_pending = true;
        let mut old = lock(&state.0.login_cancelled)?;
        old.store(true, Ordering::Relaxed);
        *old = Arc::new(AtomicBool::new(false));
        state
            .0
            .commands
            .send(Command::Login(client_id, old.clone()))?;
        Ok(())
    };
    result().map_err(error)
}
/// Resolve Canvas videos for tracks the user is about to play (hovered rows).
#[tauri::command]
fn prefetch_canvas(uris: Vec<String>, state: State<'_, Desktop>) {
    let uris: Vec<String> = uris
        .into_iter()
        .filter(|uri| uri.starts_with("spotify:track:") && uri.len() < 64)
        .take(8)
        .collect();
    if !uris.is_empty() {
        let _ = state.0.commands.send(Command::PrefetchCanvas(uris));
    }
}
#[tauri::command]
fn cancel_sign_in(state: State<'_, Desktop>) {
    if let Ok(cancelled) = state.0.login_cancelled.lock() {
        cancelled.store(true, Ordering::Relaxed);
    }
}
#[tauri::command]
fn sign_out(state: State<'_, Desktop>) -> std::result::Result<(), String> {
    if let Ok(cancelled) = state.0.login_cancelled.lock() {
        cancelled.store(true, Ordering::Relaxed);
    }
    if let Ok(mut snapshot) = state.0.snapshot.lock() {
        snapshot.profile = None;
        snapshot.login_pending = false;
    }
    state.0.commands.send(Command::Logout).map_err(error)
}
fn valid_route(key: &str) -> bool {
    if ["home", "liked", "queue"].contains(&key) {
        return true;
    }
    if let Some(query) = key.strip_prefix("search:") {
        return !query.trim().is_empty() && query.len() <= 500;
    }
    ["album:", "artist:", "playlist:"]
        .into_iter()
        .any(|prefix| {
            key.strip_prefix(prefix).is_some_and(|id| {
                id.len() == 22 && id.bytes().all(|byte| byte.is_ascii_alphanumeric())
            })
        })
}
#[tauri::command]
fn browse(
    key: String,
    generation: u64,
    offset: usize,
    state: State<'_, Desktop>,
) -> std::result::Result<(), String> {
    let result = || -> Result<()> {
        ensure!(valid_route(&key), "Unknown page");
        ensure!(offset <= 100_000, "Page offset too large");
        let mut snapshot = lock(&state.0.snapshot)?;
        ensure!(snapshot.profile.is_some(), "Sign in first");
        if offset > 0 && (snapshot.loading || offset != snapshot.tracks.len()) {
            return Ok(());
        }
        if offset == 0 {
            snapshot.route = key.clone();
            snapshot.generation = generation;
            snapshot.tracks.clear();
            snapshot.browse_info = None;
            snapshot.settings.last_view = key.clone();
            snapshot.settings.save()?;
        }
        ensure!(
            snapshot.route == key && snapshot.generation == generation,
            "Page changed"
        );
        snapshot.loading = true;
        if offset == 0 && (key.starts_with("album:") || key.starts_with("artist:")) {
            state.0.commands.send(Command::BrowseInfo {
                key: key.clone(),
                generation,
            })?;
        }
        state.0.commands.send(Command::Tracks {
            key,
            generation,
            offset,
        })?;
        Ok(())
    };
    result().map_err(error)
}
fn local_load(action: PlayerAction, tracks: &[Track]) -> Result<PlayerAction> {
    if let PlayerAction::PlayContext { offset, .. } = &action {
        let uris: Vec<_> = tracks
            .iter()
            .filter(|track| !track.is_local)
            .map(|track| track.uri.clone())
            .collect();
        ensure!(!uris.is_empty(), "Wait for the playlist tracks to load");
        let index = offset.as_ref().map_or(Ok(0), |uri| {
            uris.iter()
                .position(|track| track == uri)
                .context("Selected track is not loaded")
        })?;
        let start = index.saturating_sub(30);
        return Ok(PlayerAction::PlayUris {
            uris: uris.into_iter().skip(start).take(100).collect(),
            offset: index - start,
        });
    }
    Ok(action)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PlayerRequest {
    command: String,
    uri: Option<String>,
    uris: Option<Vec<String>>,
    context: Option<String>,
    offset: Option<usize>,
    position_ms: Option<u64>,
    volume: Option<u8>,
    enabled: Option<bool>,
    repeat: Option<String>,
    track: Option<Track>,
}
impl PlayerRequest {
    fn action(&self) -> Result<PlayerAction> {
        Ok(match self.command.as_str() {
            "play" => PlayerAction::Play(self.uri.clone()),
            "pause" => PlayerAction::Pause,
            "next" => PlayerAction::Next,
            "previous" => PlayerAction::Previous,
            "play_context" => PlayerAction::PlayContext {
                context: self.context.clone().context("Playback context missing")?,
                offset: self.uri.clone(),
            },
            "play_uris" => {
                let uris = self.uris.clone().context("Track list missing")?;
                ensure!(
                    !uris.is_empty() && uris.len() <= 100,
                    "Choose between 1 and 100 tracks"
                );
                let offset = self.offset.unwrap_or(0);
                ensure!(offset < uris.len(), "Track offset out of range");
                PlayerAction::PlayUris { uris, offset }
            }
            "seek" => PlayerAction::Seek(self.position_ms.context("Seek position missing")?),
            "volume" => PlayerAction::Volume(self.volume.context("Volume missing")?.min(100)),
            "shuffle" => PlayerAction::Shuffle(self.enabled.context("Shuffle state missing")?),
            "repeat" => {
                let repeat = self.repeat.clone().context("Repeat state missing")?;
                ensure!(
                    ["off", "context", "track"].contains(&repeat.as_str()),
                    "Invalid repeat state"
                );
                PlayerAction::Repeat(repeat)
            }
            "enqueue" => PlayerAction::Enqueue(self.uri.clone().context("Track URI missing")?),
            "transfer" => PlayerAction::Transfer(self.uri.clone().context("Device missing")?),
            _ => anyhow::bail!("Unknown playback command"),
        })
    }
}
#[tauri::command]
fn player(
    request: PlayerRequest,
    target: Option<String>,
    state: State<'_, Desktop>,
) -> std::result::Result<(), String> {
    let result = || -> Result<()> {
        let mut snapshot = lock(&state.0.snapshot)?;
        ensure!(snapshot.profile.is_some(), "Sign in first");
        let mut action = request.action()?;
        let local = targets_local_device(
            target.as_deref(),
            lock(&state.0.native_id)?.as_deref(),
            &snapshot.playback.device,
        );
        if local && !matches!(action, PlayerAction::Transfer(_) | PlayerAction::Enqueue(_)) {
            action = local_load(action, &snapshot.tracks)?;
            ensure!(
                snapshot.native_ready,
                "Native audio is connecting. Try again when ready."
            );
            state.0.controls.send(action.clone()).map_err(|_| {
                anyhow::anyhow!("Native audio disconnected. Reconnect native audio in Settings.")
            })?;
            if let Some(track) = request.track {
                if let Ok(mut pending) = state.0.pending_track.lock() {
                    *pending = Some((track.uri.clone(), Instant::now()));
                }
                snapshot.playback.item = Some(track.clone());
                snapshot.playback.progress_ms = Some(0);
                snapshot.playback.is_playing = false;
                snapshot.lyrics = None;
                snapshot.canvas_url = None;
                snapshot.lyric_error.clear();
                snapshot.details = PlayingDetails::default();
                snapshot.observed_at = now_ms();
                let _ = state.0.commands.send(Command::FetchLyrics(track.clone()));
                let _ = state.0.commands.send(Command::PlayingDetails(track));
            }
            snapshot.playback.device.name = native::device_name();
            snapshot.playback.device.id = lock(&state.0.native_id)?.clone();
            snapshot.playback.device.is_active = true;
            if let Ok(mut last) = state.0.last_native.lock() {
                *last = Some(Instant::now());
            }
            return Ok(());
        }
        let device = if local {
            lock(&state.0.native_id)?.clone()
        } else {
            target
        };
        state.0.commands.send(Command::Player { action, device })?;
        Ok(())
    };
    result().map_err(error)
}
#[tauri::command]
fn retry_audio(state: State<'_, Desktop>) -> std::result::Result<(), String> {
    state.0.commands.send(Command::RetryAudio).map_err(error)
}
#[tauri::command]
fn refresh(state: State<'_, Desktop>) -> std::result::Result<(), String> {
    state.0.commands.send(Command::Refresh).map_err(error)
}
#[tauri::command]
fn save_item(
    uri: String,
    saved: bool,
    state: State<'_, Desktop>,
) -> std::result::Result<(), String> {
    if !uri.starts_with("spotify:track:") && !uri.starts_with("spotify:artist:") {
        return Err("Choose a Spotify track or artist".into());
    }
    state
        .0
        .commands
        .send(Command::SetSaved { uri, saved })
        .map_err(error)
}
#[tauri::command]
fn save_settings(settings: Settings, state: State<'_, Desktop>) -> std::result::Result<(), String> {
    let result = || -> Result<()> {
        let mut snapshot = lock(&state.0.snapshot)?;
        let mut settings = settings;
        settings.client_id = snapshot.settings.client_id.clone();
        settings.lyric_size = settings.lyric_size.clamp(18.0, 72.0);
        settings.lyric_offset_ms = settings.lyric_offset_ms.clamp(-10_000, 10_000);
        settings.save()?;
        snapshot.settings = settings;
        Ok(())
    };
    result().map_err(error)
}
#[tauri::command]
fn configure_spicy_lyrics(
    key: String,
    consent: bool,
    state: State<'_, Desktop>,
) -> std::result::Result<(), String> {
    state
        .0
        .lyrics
        .send(LyricCommand::ConfigureSpicy { key, consent })
        .map_err(error)
}
#[tauri::command]
fn configure_provider(
    host: String,
    consent: bool,
    state: State<'_, Desktop>,
) -> std::result::Result<(), String> {
    state
        .0
        .lyrics
        .send(LyricCommand::Configure { host, consent })
        .map_err(error)
}
#[tauri::command]
fn retry_lyrics(state: State<'_, Desktop>) -> std::result::Result<(), String> {
    let track = lock(&state.0.snapshot)
        .map_err(error)?
        .playback
        .item
        .clone()
        .ok_or("Play a track first")?;
    state
        .0
        .commands
        .send(Command::FetchLyrics(track))
        .map_err(error)
}
#[tauri::command]
fn import_lyrics(
    filename: String,
    contents: String,
    state: State<'_, Desktop>,
) -> std::result::Result<(), String> {
    if contents.len() > 2_000_000 {
        return Err("Lyric file exceeds 2 MB".into());
    }
    let track = lock(&state.0.snapshot)
        .map_err(error)?
        .playback
        .item
        .clone()
        .ok_or("Play a track first")?;
    state
        .0
        .lyrics
        .send(LyricCommand::ImportText {
            track,
            filename,
            contents,
        })
        .map_err(error)
}
#[tauri::command]
fn add_tracks(
    playlist: Playlist,
    tracks: Vec<Track>,
    state: State<'_, Desktop>,
) -> std::result::Result<(), String> {
    state
        .0
        .commands
        .send(Command::Add { playlist, tracks })
        .map_err(error)
}
#[tauri::command]
fn open_link(url: String) -> std::result::Result<(), String> {
    let parsed = url::Url::parse(&url).map_err(|_| "Invalid link")?;
    if parsed.scheme() != "https"
        || !matches!(
            parsed.host_str(),
            Some(
                "open.spotify.com"
                    | "developer.spotify.com"
                    | "developers.spicylyrics.org"
                    | "spicylyrics.org"
            )
        )
        || !parsed.username().is_empty()
        || parsed.password().is_some()
    {
        return Err("Link is not an allowed Spotify or lyrics page".into());
    }
    webbrowser::open(parsed.as_str())
        .map(|_| ())
        .map_err(|_| "Cannot open browser".into())
}
#[tauri::command]
fn app_update(action: String, state: State<'_, Desktop>) -> std::result::Result<(), String> {
    let result = || -> Result<()> {
        let command = match action.as_str() {
            "check" => updater::Command::Check,
            "download" => updater::Command::Download(
                lock(&state.0.available)?
                    .clone()
                    .context("No update available")?,
            ),
            "install" => updater::Command::Install(
                lock(&state.0.ready_update)?
                    .take()
                    .context("Update is not downloaded yet")?,
            ),
            _ => anyhow::bail!("Unknown update action"),
        };
        state.0.update_commands.send(command)?;
        Ok(())
    };
    result().map_err(error)
}
pub fn run() -> Result<(), Box<dyn std::error::Error>> {
    use tauri_plugin_window_state::StateFlags;
    let app = tauri::Builder::default()
        .plugin(
            tauri_plugin_window_state::Builder::default()
                .with_state_flags(StateFlags::SIZE | StateFlags::POSITION | StateFlags::MAXIMIZED)
                .build(),
        )
        .setup(|app| {
            app.manage(Desktop::start(app.handle().clone())?);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            bootstrap,
            sign_in,
            cancel_sign_in,
            prefetch_canvas,
            sign_out,
            browse,
            player,
            retry_audio,
            refresh,
            save_item,
            save_settings,
            configure_provider,
            configure_spicy_lyrics,
            retry_lyrics,
            import_lyrics,
            add_tracks,
            open_link,
            app_update
        ])
        .build(tauri::generate_context!())?;
    app.run(|app, event| {
        if matches!(event, tauri::RunEvent::Exit)
            && let Some(state) = app.try_state::<Desktop>()
        {
            state.stop();
        }
    });
    Ok(())
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn local_playlist_selection_uses_the_chosen_loaded_track() {
        let tracks: Vec<_> = (0..150)
            .map(|index| Track {
                uri: format!("spotify:track:{index}"),
                ..Track::default()
            })
            .collect();
        let action = local_load(
            PlayerAction::PlayContext {
                context: "spotify:playlist:other-owner".into(),
                offset: Some(tracks[110].uri.clone()),
            },
            &tracks,
        )
        .unwrap();
        let PlayerAction::PlayUris { uris, offset } = action else {
            panic!("Local playback must not wait on remote playlist resolution")
        };
        assert_eq!(uris[offset], tracks[110].uri);
        assert!(uris.len() <= 100);
        assert!(
            local_load(
                PlayerAction::PlayContext {
                    context: "spotify:playlist:empty".into(),
                    offset: None
                },
                &[]
            )
            .is_err()
        );
    }
    #[test]
    fn local_device_ids_use_native_controls_without_redirecting_remote_devices() {
        let local = Device {
            id: Some("web-api-id".into()),
            name: native::device_name(),
            ..Device::default()
        };
        assert!(targets_local_device(
            Some("native"),
            Some("session-id"),
            &local
        ));
        assert!(targets_local_device(
            Some("session-id"),
            Some("session-id"),
            &local
        ));
        assert!(targets_local_device(
            Some("web-api-id"),
            Some("session-id"),
            &local
        ));
        assert!(targets_local_device(None, Some("session-id"), &local));
        assert!(!targets_local_device(
            Some("another-pc"),
            Some("session-id"),
            &local
        ));
        assert!(!targets_local_device(
            None,
            Some("session-id"),
            &Device::default()
        ));
    }
    #[test]
    fn routes_reject_arbitrary_urls_and_malformed_ids() {
        assert!(valid_route("search:Petite Meller"));
        assert!(valid_route("album:0123456789abcdefghijkl"));
        assert!(!valid_route("https://example.com"));
        assert!(!valid_route("album:../secrets"));
        assert!(!valid_route("search:"));
    }
    #[test]
    fn invalid_player_commands_never_reach_the_audio_worker() {
        let request: PlayerRequest = serde_json::from_value(
            json!({"command":"play_uris","uris":["spotify:track:one"],"offset":5}),
        )
        .unwrap();
        assert!(request.action().is_err());
        let request: PlayerRequest =
            serde_json::from_value(json!({"command":"repeat","repeat":"invalid"})).unwrap();
        assert!(request.action().is_err());
    }
}
