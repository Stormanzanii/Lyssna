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

/// Drop playback queued during connect if audio took longer than this.
const QUEUED_NATIVE_TTL: Duration = Duration::from_secs(45);
fn send_queued_native(
    queued: &Mutex<Option<(PlayerAction, Instant)>>,
    controls: &NativeControls,
) -> bool {
    queued
        .lock()
        .ok()
        .and_then(|mut queued| queued.take())
        .filter(|(_, at)| at.elapsed() < QUEUED_NATIVE_TTL)
        .is_some_and(|(action, _)| controls.send(action).is_ok())
}
#[derive(Clone, Serialize)]
pub struct Snapshot {
    narrating: bool,
    home: Option<crate::home::HomePage>,
    home_loading: bool,
    home_error: String,
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
    login_issue: Option<auth::LoginIssue>,
    can_follow: bool,
    lyrics: Option<Lyrics>,
    lyric_error: String,
    details: PlayingDetails,
    route: String,
    generation: u64,
    tracks: Vec<Track>,
    search_playlists: Vec<Playlist>,
    search_artists: Vec<crate::model::Artist>,
    search_albums: Vec<crate::model::Album>,
    search_top_results: Vec<String>,
    search_users: Vec<crate::model::Profile>,
    search_playlists_loading: bool,
    search_playlists_error: String,
    browse_info: Option<BrowseInfo>,
    loading: bool,
    more: bool,
    update_status: String,
    update_version: Option<String>,
    notice: String,
    observed_at: u64,
}
struct Inner {
    dj_requests: crate::dj::requests::Requests,
    dj_voice: crate::dj::voice::VoiceCapture,
    home_generation: std::sync::atomic::AtomicU64,
    snapshot: Mutex<Snapshot>,
    commands: mpsc::Sender<Command>,
    lyrics: mpsc::Sender<LyricCommand>,
    controls: NativeControls,
    native_id: Mutex<Option<String>>,
    generation: Mutex<u64>,
    last_native: Mutex<Option<Instant>>,
    pending_track: Mutex<Option<(String, Instant)>>,
    /// Click-to-audio timing for the last local selection, by page kind.
    start_timing: Mutex<Option<(String, Instant, &'static str)>>,
    /// Local playback requested before native audio connected.
    queued_native: Mutex<Option<(PlayerAction, Instant)>>,
    login_cancelled: Mutex<Arc<AtomicBool>>,
    stopped: AtomicBool,
    update_commands: mpsc::Sender<updater::Command>,
    available: Mutex<Option<updater::Update>>,
    ready_update: Mutex<Option<updater::ReadyUpdate>>,
}
pub struct Desktop(Arc<Inner>);
fn restore_playback(snapshot: &mut Snapshot, value: crate::resume::LastPlayed) {
    if value.dj_context.is_some()
        && let Some(profile) = snapshot.profile.as_ref()
    {
        crate::resume::remember_dj_context(&profile.id, &value.track.uri, value.dj_context);
    }
    snapshot.playback.item = Some(value.track);
    snapshot.playback.progress_ms = Some(value.position_ms);
    snapshot.playback.is_playing = false;
    snapshot.playback.device = Device {
        name: native::device_name(),
        volume_percent: Some(snapshot.settings.volume_percent.min(100)),
        ..Device::default()
    };
    snapshot.observed_at = now_ms();
    snapshot.lyrics = None;
    snapshot.canvas_url = None;
    snapshot.details = PlayingDetails::default();
}
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

/// DJ narration exists only in this computer's player; every other command,
/// including playing an album or playlist page, follows the chosen device.
fn plays_locally(
    command: &str,
    target: Option<&str>,
    native_id: Option<&str>,
    device: &Device,
) -> bool {
    command == "dj" || targets_local_device(target, native_id, device)
}

fn load_native_catalogue(
    inner: Arc<Inner>,
    app: tauri::AppHandle,
    account: String,
    key: String,
    generation: Option<u64>,
) {
    let controls = inner.controls.scoped(&account).unwrap_or_default();
    thread::spawn(move || {
        let Some((kind, id)) = key
            .split_once(':')
            .filter(|(kind, _)| matches!(*kind, "artist" | "album"))
        else {
            return;
        };
        let cached = crate::library_cache::info(&account, &key);
        let complete = cached.as_ref().is_some_and(|info| {
            if kind == "artist" {
                info.overview.is_some()
            } else {
                info.album_details.is_some()
            }
        });
        let info = if generation.is_none()
            && complete
            && crate::library_cache::info_is_fresh(&account, &key)
        {
            cached
        } else {
            controls.catalogue(kind, id, 0).ok().and_then(|entity| {
                let mut info = crate::catalogue::base_info(&entity, kind, id).ok()?;
                if kind == "artist" {
                    info.overview = crate::artist::from_entity(&entity, id).ok();
                } else {
                    info.album_details = Some(crate::album::parse(&entity));
                }
                Some(crate::library_cache::save_info(&account, info))
            })
        };
        let Some(info) = info else {
            if let Some(generation) = generation
                && let Ok(snapshot) = inner.snapshot.lock()
                && snapshot.generation == generation
                && snapshot.route == key
                && snapshot
                    .profile
                    .as_ref()
                    .is_some_and(|profile| profile.id == account)
            {
                let _ = inner.commands.send(Command::BrowseInfo { key, generation });
            }
            return;
        };
        let album_incomplete = info
            .album_details
            .as_ref()
            .is_some_and(|details| !details.complete_duration || details.streams.is_empty());
        let Ok(mut snapshot) = inner.snapshot.lock() else {
            return;
        };
        if snapshot
            .profile
            .as_ref()
            .is_none_or(|profile| profile.id != account)
        {
            return;
        }
        if let Some(generation) = generation {
            if snapshot.generation != generation || snapshot.route != key {
                return;
            }
            let needs_status = info
                .overview
                .as_ref()
                .is_some_and(|overview| !overview.details_loaded)
                && snapshot
                    .browse_info
                    .as_ref()
                    .and_then(|info| info.overview.as_ref())
                    .is_none();
            snapshot.browse_info = Some(info.clone());
            if kind == "artist" && info.overview.is_some() {
                snapshot.loading = false;
                snapshot.more = false;
            }
            let _ = app.emit(
                "spotiflex",
                json!({"type":"browse_info","generation":generation,"info":info}),
            );
            if needs_status {
                let _ = inner.commands.send(Command::ArtistTracks {
                    account,
                    generation,
                    info: Box::new(info),
                });
            }
            if album_incomplete {
                let _ = inner.commands.send(Command::BrowseInfo { key, generation });
            }
        } else {
            let _ = app.emit("spotiflex", json!({"type":"info_prefetch","info":info}));
        }
    });
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
        let route = settings.last_view.clone();
        let inner = Arc::new(Inner {
            home_generation: std::sync::atomic::AtomicU64::new(0),
            dj_requests: crate::dj::requests::Requests::default(),
            dj_voice: crate::dj::voice::VoiceCapture::default(),
            snapshot: Mutex::new(Snapshot {
                narrating: false,
                canvas_url: None,
                home: None,
                home_loading: false,
                home_error: String::new(),
                profile: None,
                playlists: Vec::new(),
                playback: Playback {
                    device: Device {
                        volume_percent: Some(settings.volume_percent.min(100)),
                        ..Device::default()
                    },
                    ..Playback::default()
                },
                settings: settings.clone(),
                native_ready: false,
                local_device_name: native::device_name(),
                native_status: "Waiting for sign-in".into(),
                provider_configured: crate::provider::configured(),
                provider_builtin: crate::provider::builtin_configured(),
                provider_kind: crate::provider::kind(),
                login_pending: true,
                login_issue: None,
                can_follow: false,
                lyrics: None,
                lyric_error: String::new(),
                details: PlayingDetails::default(),
                route,
                generation: 0,
                tracks: Vec::new(),
                search_playlists: Vec::new(),
                search_artists: Vec::new(),
                search_albums: Vec::new(),
                search_top_results: Vec::new(),
                search_users: Vec::new(),
                search_playlists_loading: false,
                search_playlists_error: String::new(),
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
            start_timing: Mutex::new(None),
            queued_native: Mutex::new(None),
            login_cancelled: Mutex::new(Arc::new(AtomicBool::new(false))),
            stopped: AtomicBool::new(false),
            update_commands: updates.commands.clone(),
            available: Mutex::new(None),
            ready_update: Mutex::new(None),
        });
        inner.commands.send(Command::NativeLogin {
            restoring: true,
            cancelled: lock(&inner.login_cancelled)?.clone(),
        })?;
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
                        Event::TrackFacts(facts) => {
                            if snapshot.profile.is_some() {
                                emit(json!({"type":"track_facts","facts":facts}));
                            }
                        }
                        Event::LastPlayed { account, value } => {
                            if snapshot
                                .profile
                                .as_ref()
                                .is_some_and(|profile| profile.id == account)
                                && !snapshot.playback.is_playing
                                && (snapshot.playback.item.is_none()
                                    || snapshot.playback.device.name == native::device_name())
                                && pump
                                    .last_native
                                    .lock()
                                    .ok()
                                    .is_some_and(|last| last.is_none())
                                && let Some(value) = crate::resume::newer(
                                    crate::resume::load(&account),
                                    Some(*value),
                                )
                            {
                                restore_playback(&mut snapshot, value);
                                emit(
                                    json!({"type":"playback","playback":snapshot.playback,"observed_at":snapshot.observed_at,"changed":true}),
                                );
                            }
                        }
                        Event::PagePrefetched {
                            account,
                            key,
                            tracks,
                            info,
                        } => {
                            if snapshot
                                .profile
                                .as_ref()
                                .is_some_and(|profile| profile.id == account)
                            {
                                emit(
                                    json!({"type":"page_prefetch","key":key,"more":tracks.len()==50,"tracks":tracks}),
                                );
                                if let Some(info) = info {
                                    emit(json!({"type":"info_prefetch","info":info}));
                                }
                            }
                        }
                        Event::CanvasPrefetched { uri, url } => {
                            emit(json!({"type":"canvas_prefetch","uri":uri,"url":url}));
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
                            image,
                            verified,
                            biography,
                        } => {
                            if snapshot
                                .playback
                                .item
                                .as_ref()
                                .is_some_and(|track| track.uri == uri)
                            {
                                for artist in &mut snapshot.details.artists {
                                    if artist.id.as_deref() == Some(&artist_id) {
                                        if listeners.is_some() {
                                            artist.monthly_listeners = listeners;
                                        }
                                        if verified.is_some() {
                                            artist.verified = verified;
                                        }
                                        if !biography.is_empty() {
                                            artist.biography = biography.clone();
                                        }
                                        // Local playback only knows artists whose page
                                        // was opened; fall back to the header photo.
                                        if artist.images.is_empty()
                                            && let Some(url) = &image
                                        {
                                            artist.images = vec![crate::model::Artwork {
                                                url: url.clone(),
                                                width: None,
                                            }];
                                        }
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
                            if snapshot.profile.as_ref().map(|old| &old.id) != Some(&profile.id) {
                                snapshot.home = None;
                                snapshot.home_loading = false;
                                snapshot.home_error.clear();
                                pump.home_generation.fetch_add(1, Ordering::SeqCst);
                            }
                            snapshot.profile = Some(profile.clone());
                            snapshot.login_issue = None;
                            snapshot.login_pending = false;
                            snapshot.can_follow =
                                pump.controls.connected_or_connecting(&profile.id)
                                    || auth::Tokens::load(&snapshot.settings.client_id)
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
                            if let Some(connection) =
                                pump.controls.connection_event(Some(&profile.id))
                            {
                                match connection {
                                    NativeEvent::Ready(id) => {
                                        snapshot.native_ready = true;
                                        snapshot.native_status = "Ready · this computer".into();
                                        if let Ok(mut current) = pump.native_id.lock() {
                                            *current = Some(id);
                                        }
                                    }
                                    NativeEvent::Authorizing => {
                                        snapshot.native_status =
                                            "Authorize audio playback in your browser…".into()
                                    }
                                    NativeEvent::Error(message) => {
                                        snapshot.native_ready = false;
                                        snapshot.native_status = message;
                                    }
                                    _ => {}
                                }
                                emit(
                                    json!({"type":"native","ready":snapshot.native_ready,"status":snapshot.native_status}),
                                );
                            }
                            if snapshot.home.is_none()
                                && let Some(page) = crate::library_cache::home(&profile.id)
                            {
                                snapshot.home = Some(page.clone());
                                emit(json!({"type":"home","page":page}));
                            }
                            if let Some(value) = crate::resume::load(&profile.id) {
                                restore_playback(&mut snapshot, value);
                                emit(
                                    json!({"type":"playback","playback":snapshot.playback,"observed_at":snapshot.observed_at,"changed":true}),
                                );
                            }
                        }
                        Event::SignedOut => {
                            pump.dj_requests.cancel_all();
                            pump.dj_voice.cancel_all();
                            if let Ok(mut queued) = pump.queued_native.lock() {
                                *queued = None;
                            }
                            snapshot.profile = None;
                            snapshot.login_issue = None;
                            snapshot.login_pending = false;
                            snapshot.playlists.clear();
                            snapshot.home = None;
                            snapshot.home_loading = false;
                            snapshot.home_error.clear();
                            snapshot.playback = Playback::default();
                            snapshot.narrating = false;
                            snapshot.native_ready = false;
                            snapshot.lyrics = None;
                            snapshot.canvas_url = None;
                            snapshot.details = PlayingDetails::default();
                            snapshot.tracks.clear();
                            snapshot.search_playlists.clear();
                            snapshot.search_artists.clear();
                            snapshot.search_albums.clear();
                            snapshot.search_top_results.clear();
                            snapshot.search_users.clear();
                            snapshot.search_playlists_loading = false;
                            snapshot.search_playlists_error.clear();
                            emit(json!({"type":"signed_out"}));
                        }
                        Event::LoginFailed(issue) => {
                            if !snapshot.login_pending {
                                continue;
                            }
                            snapshot.login_issue = Some(issue.clone());
                            snapshot.login_pending = false;
                            emit(json!({"type":"login_failed","issue":issue}));
                        }
                        Event::LoginFinished => {
                            snapshot.login_pending = false;
                            emit(json!({"type":"login_finished"}));
                        }
                        Event::NativeStarting(generation) => {
                            pump.dj_requests.cancel_all();
                            pump.dj_voice.cancel_all();
                            if let Ok(mut current) = pump.generation.lock() {
                                *current = generation;
                            }
                            if let Ok(mut last) = pump.last_native.lock() {
                                *last = None;
                            }
                            snapshot.native_ready = false;
                            snapshot.native_status = "Connecting native audio…".into();
                            if snapshot.playback.device.name == native::device_name() {
                                snapshot.playback.is_playing = false;
                                snapshot.observed_at = now_ms();
                                emit(
                                    json!({"type":"playback","playback":snapshot.playback,"observed_at":snapshot.observed_at,"changed":false}),
                                );
                            }
                            emit(
                                json!({"type":"native","ready":false,"status":snapshot.native_status}),
                            );
                        }
                        Event::Library(playlists) => {
                            snapshot.playlists = playlists;
                            emit(json!({"type":"library","playlists":snapshot.playlists}));
                        }
                        Event::LibraryFolders(folders) => {
                            emit(json!({"type":"library_folders","folders":folders}));
                        }
                        Event::Playback(mut playback, _observed) => {
                            if snapshot.native_ready
                                && playback.device.name == native::device_name()
                            {
                                playback.device.volume_percent =
                                    Some(snapshot.settings.volume_percent);
                            }
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
                        Event::SearchResults {
                            account,
                            key,
                            generation,
                            results,
                            message,
                        } => {
                            if snapshot.generation != generation
                                || snapshot.route != key
                                || snapshot
                                    .profile
                                    .as_ref()
                                    .is_none_or(|profile| profile.id != account)
                            {
                                continue;
                            }
                            snapshot.tracks = results.tracks.clone();
                            snapshot.search_playlists = results.playlists.clone();
                            snapshot.search_artists = results.artists.clone();
                            snapshot.search_albums = results.albums.clone();
                            snapshot.search_top_results = results.top_results.clone();
                            snapshot.search_users = results.users.clone();
                            snapshot.loading = false;
                            snapshot.more = false;
                            snapshot.search_playlists_loading = false;
                            snapshot.search_playlists_error = message.clone();
                            emit(
                                json!({"type":"search_results","account":account,"key":key,"generation":generation,"results":results,"message":message}),
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
                                        account: snapshot
                                            .profile
                                            .as_ref()
                                            .map(|profile| profile.id.clone())
                                            .unwrap_or_default(),
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
                        Event::PageChanged(key) => {
                            if snapshot.route == key {
                                if key.starts_with("playlist:") {
                                    let _ = pump.commands.send(Command::BrowseInfo {
                                        key: key.clone(),
                                        generation: snapshot.generation,
                                    });
                                }
                                let _ = pump.commands.send(Command::Tracks {
                                    key,
                                    offset: 0,
                                    generation: snapshot.generation,
                                });
                            }
                        }
                        Event::SavedMany(items) => emit(json!({
                            "type": "saved_many",
                            "items": items.into_iter().collect::<std::collections::HashMap<_, _>>()
                        })),
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
                        NativeEvent::Stopped => {
                            if snapshot.playback.device.name == native::device_name() {
                                snapshot.playback.is_playing = false;
                                snapshot.observed_at = now_ms();
                                emit(
                                    json!({"type":"playback","playback":snapshot.playback,"observed_at":snapshot.observed_at,"changed":false}),
                                );
                            }
                        }
                        NativeEvent::Narration(active) => {
                            snapshot.narrating = active;
                            emit(json!({"type":"narration","active":active}));
                        }
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
                                    snapshot.settings.volume_percent = volume;
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
                            let native_id = pump.native_id.lock().ok().and_then(|id| id.clone());
                            snapshot.observed_at = now_ms();
                            let volume = snapshot.settings.volume_percent;
                            if !snapshot.playback.load_native_track(
                                track.clone(),
                                native_id.as_deref(),
                                &native::device_name(),
                                volume,
                            ) {
                                emit(
                                    json!({"type":"playback","playback":snapshot.playback,"observed_at":snapshot.observed_at,"changed":false,"loading":true}),
                                );
                                continue;
                            }
                            snapshot.observed_at = now_ms();
                            snapshot.lyrics = None;
                            snapshot.canvas_url = None;
                            snapshot.lyric_error.clear();
                            snapshot.details = PlayingDetails::default();
                            let _ = pump.commands.send(Command::TrackInfo(track.uri.clone()));
                            let _ = pump.commands.send(Command::FetchLyrics(track.clone()));
                            let _ = pump.commands.send(Command::PlayingDetails(track));
                            emit(
                                json!({"type":"playback","playback":snapshot.playback,"observed_at":snapshot.observed_at,"changed":true,"loading":true}),
                            );
                        }
                        NativeEvent::Reconnecting(seconds) => {
                            snapshot.narrating = false;
                            snapshot.native_ready = false;
                            snapshot.native_status =
                                format!("Reconnecting native audio in {seconds}s…");
                            if snapshot.playback.device.name == native::device_name() {
                                snapshot.playback.is_playing = false;
                                snapshot.observed_at = now_ms();
                                emit(
                                    json!({"type":"playback","playback":snapshot.playback,"observed_at":snapshot.observed_at,"changed":false}),
                                );
                            }
                            emit(
                                json!({"type":"native","ready":false,"status":snapshot.native_status}),
                            );
                        }
                        NativeEvent::Authorizing => {
                            snapshot.narrating = false;
                            snapshot.native_ready = false;
                            snapshot.native_status =
                                "Authorize audio playback in your browser…".into();
                            emit(
                                json!({"type":"native","ready":false,"status":snapshot.native_status}),
                            );
                        }
                        NativeEvent::Ready(id) => {
                            if !matches!(pump.controls.connection_event(snapshot.profile.as_ref().map(|profile|profile.id.as_str())),Some(NativeEvent::Ready(current))if current==id)
                            {
                                continue;
                            }
                            if let Ok(mut current) = pump.native_id.lock() {
                                *current = Some(id);
                            }
                            snapshot.native_ready = true;
                            snapshot.native_status = "Ready · this computer".into();
                            // Reload playlists from Spotify's own library list.
                            let _ = pump.commands.send(Command::Library);
                            if send_queued_native(&pump.queued_native, &pump.controls)
                                && let Ok(mut last) = pump.last_native.lock()
                            {
                                *last = Some(Instant::now());
                            }
                            if ["playlist:", "album:", "artist:"]
                                .iter()
                                .any(|prefix| snapshot.route.starts_with(prefix))
                                && snapshot.profile.is_some()
                            {
                                if snapshot.route.starts_with("artist:")
                                    || snapshot.route.starts_with("album:")
                                {
                                    load_native_catalogue(
                                        pump.clone(),
                                        app.clone(),
                                        snapshot
                                            .profile
                                            .as_ref()
                                            .map(|profile| profile.id.clone())
                                            .unwrap_or_default(),
                                        snapshot.route.clone(),
                                        Some(snapshot.generation),
                                    );
                                } else {
                                    let _ = pump.commands.send(Command::BrowseInfo {
                                        key: snapshot.route.clone(),
                                        generation: snapshot.generation,
                                    });
                                }
                            }
                            emit(
                                json!({"type":"native","ready":true,"status":snapshot.native_status}),
                            );
                            if let Some(track) = snapshot.playback.item.clone() {
                                let _ = pump.commands.send(Command::FetchLyrics(track.clone()));
                                let _ = pump.commands.send(Command::PlayingDetails(track));
                            }
                        }
                        NativeEvent::Error(message) => {
                            snapshot.narrating = false;
                            if let Ok(mut queued) = pump.queued_native.lock() {
                                *queued = None;
                            }
                            snapshot.native_ready = false;
                            snapshot.native_status = message;
                            if snapshot.playback.device.name == native::device_name() {
                                snapshot.playback.is_playing = false;
                                snapshot.observed_at = now_ms();
                                emit(
                                    json!({"type":"playback","playback":snapshot.playback,"observed_at":snapshot.observed_at,"changed":false}),
                                );
                            }
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
                                if playing == Some(true)
                                    && let Ok(mut timing) = pump.start_timing.lock()
                                    && let Some((_, started, kind)) =
                                        timing.take_if(|(wanted, ..)| *wanted == uri)
                                {
                                    record_start_time(kind, started.elapsed());
                                }
                                if let Ok(mut last) = pump.last_native.lock() {
                                    *last = Some(Instant::now());
                                }
                                snapshot.observed_at = now_ms();
                                if let Some(profile) = &snapshot.profile {
                                    let _ = crate::resume::save(
                                        &profile.id,
                                        &snapshot.playback,
                                        snapshot.observed_at,
                                        false,
                                    );
                                }
                                emit(
                                    json!({"type":"native_position","uri":uri,"position_ms":position_ms,"playing":playing,"seeked":seeked,"observed_at":snapshot.observed_at}),
                                );
                            }
                        }
                        NativeEvent::DJContext(active) => {
                            emit(json!({"type": "dj_context", "active": active}));
                        }
                        NativeEvent::QueueChanged => {
                            if let Some(track) = snapshot.playback.item.clone() {
                                let _ = pump.commands.send(Command::PlayingDetails(track));
                            }
                            if snapshot.route == "queue" {
                                let _ = pump.commands.send(Command::Tracks {
                                    key: "queue".into(),
                                    offset: 0,
                                    generation: snapshot.generation,
                                });
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
        self.0.dj_requests.cancel_all();
        self.0.dj_voice.cancel_all();
        if let Ok(mut snapshot) = self.0.snapshot.lock() {
            // A remote speaker's level is not this computer's volume.
            if snapshot.playback.device.name == native::device_name() {
                snapshot.settings.volume_percent = snapshot
                    .playback
                    .device
                    .volume_percent
                    .unwrap_or(snapshot.settings.volume_percent)
                    .min(100);
            }
            let _ = snapshot.settings.save();
        }
        if let Ok(snapshot) = self.0.snapshot.lock()
            && let Some(profile) = &snapshot.profile
            && self
                .0
                .last_native
                .lock()
                .ok()
                .is_some_and(|last| last.is_some())
        {
            let _ =
                crate::resume::save(&profile.id, &snapshot.playback, snapshot.observed_at, true);
        }
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
fn dj_prepare(account: String, state: State<'_, Desktop>) -> std::result::Result<(), String> {
    let snapshot = lock(&state.0.snapshot).map_err(error)?;
    crate::dj::requests::authorize(
        snapshot.profile.as_ref().map(|p| p.id.as_str()),
        snapshot.native_ready,
        &account,
    )
    .map_err(error)?;
    state.0.controls.prewarm_dj_request(&account).map_err(error)
}
#[tauri::command]
async fn dj_request(
    account: String,
    id: String,
    text: String,
    input: crate::dj::PromptInput,
    state: State<'_, Desktop>,
) -> std::result::Result<(), String> {
    let inner = state.0.clone();
    let ticket = {
        let snapshot = lock(&inner.snapshot).map_err(error)?;
        crate::dj::requests::authorize(
            snapshot.profile.as_ref().map(|p| p.id.as_str()),
            snapshot.native_ready,
            &account,
        )
        .map_err(error)?;
        inner.dj_requests.reserve(&id).map_err(error)?
    };
    let prompt = crate::dj::Prompt::new(&text, input).map_err(error)?;
    tauri::async_runtime::spawn_blocking(move || {
        inner
            .controls
            .request_dj(&account, prompt, ticket.cancelled.clone())
    })
    .await
    .map_err(|_| "DJ worker unavailable".to_owned())?
    .map_err(error)
}
#[tauri::command]
async fn dj_voice(
    account: String,
    id: String,
    dialog: String,
    state: State<'_, Desktop>,
    app: tauri::AppHandle,
) -> std::result::Result<String, String> {
    let (capture, vocabulary) = {
        let snapshot = lock(&state.0.snapshot).map_err(error)?;
        crate::dj::requests::authorize(
            snapshot.profile.as_ref().map(|p| p.id.as_str()),
            snapshot.native_ready,
            &account,
        )
        .map_err(error)?;
        let vocabulary = crate::dj::voice::artist_vocabulary(
            snapshot
                .playback
                .item
                .iter()
                .flat_map(|track| &track.artists)
                .chain(&snapshot.details.artists)
                .chain(snapshot.tracks.iter().flat_map(|track| &track.artists))
                .map(|artist| artist.name.as_str()),
        );
        (
            state.0.dj_voice.reserve(id.clone()).map_err(error)?,
            vocabulary,
        )
    };
    tauri::async_runtime::spawn_blocking(move || {
        capture.transcribe_in_dialog(&vocabulary,&dialog,|progress| {
            let _ = app.emit(
                "spotiflex-dj-voice",
                json!({"account":account,"id":id,"level":progress.level,"speech":progress.speech,"stage":progress.stage,"percent":progress.percent}),
            );
        })
    })
    .await
    .map_err(|_| "Voice worker unavailable".to_owned())?
    .map_err(error)
}
#[tauri::command]
async fn dj_release_voice(dialog: String) -> std::result::Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || crate::dj::voice::release_model(&dialog))
        .await
        .map_err(|_| "Voice cleanup unavailable".to_owned())
}
#[tauri::command]
fn dj_cancel(id: String, state: State<'_, Desktop>) {
    state.0.dj_requests.cancel(&id);
    state.0.dj_voice.cancel(&id);
}
#[tauri::command]
fn prefetch_metadata(
    keys: Vec<String>,
    state: State<'_, Desktop>,
    app: tauri::AppHandle,
) -> std::result::Result<(), String> {
    let snapshot = lock(&state.0.snapshot).map_err(error)?;
    let account = snapshot
        .profile
        .as_ref()
        .map(|profile| profile.id.clone())
        .ok_or_else(|| "Sign in first".to_owned())?;
    if !snapshot.native_ready {
        return Ok(());
    }
    let mut seen = std::collections::HashSet::new();
    for key in keys
        .into_iter()
        .take(8)
        .filter(|key| valid_route(key) && (key.starts_with("artist:") || key.starts_with("album:")))
    {
        if seen.insert(key.clone()) {
            load_native_catalogue(state.0.clone(), app.clone(), account.clone(), key, None);
        }
    }
    Ok(())
}
#[tauri::command]
fn sign_in(client_id: String, state: State<'_, Desktop>) -> std::result::Result<(), String> {
    let result = || -> Result<()> {
        ensure!(
            client_id.is_empty() || config::valid_client_id(&client_id),
            "Client ID must contain 32 hexadecimal characters"
        );
        let mut snapshot = lock(&state.0.snapshot)?;
        if !client_id.is_empty() {
            snapshot.settings.client_id = client_id.clone();
        }
        snapshot.settings.save()?;
        snapshot.login_pending = true;
        snapshot.login_issue = None;
        let mut old = lock(&state.0.login_cancelled)?;
        old.store(true, Ordering::Relaxed);
        *old = Arc::new(AtomicBool::new(false));
        let command = if client_id.is_empty() {
            Command::NativeLogin {
                restoring: false,
                cancelled: old.clone(),
            }
        } else {
            Command::Login(client_id, old.clone())
        };
        state.0.commands.send(command)?;
        Ok(())
    };
    result().map_err(error)
}
/// Load a page the pointer is resting on, without navigating, so opening it
/// is instant. Results go to the frontend page cache only.
#[tauri::command]
fn prefetch_page(key: String, state: State<'_, Desktop>) -> std::result::Result<(), String> {
    let result = || -> Result<()> {
        ensure!(valid_route(&key), "Unknown page");
        ensure!(lock(&state.0.snapshot)?.profile.is_some(), "Sign in first");
        state.0.commands.send(Command::PrefetchPage(key))?;
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
fn cancel_sign_in(app: tauri::AppHandle, state: State<'_, Desktop>) {
    if let Ok(cancelled) = state.0.login_cancelled.lock() {
        cancelled.store(true, Ordering::Relaxed);
    }
    if let Ok(mut snapshot) = state.0.snapshot.lock() {
        snapshot.login_pending = false;
    }
    let _ = app.emit("spotiflex", json!({"type":"login_finished"}));
}
#[tauri::command]
fn retry_sign_in(state: State<'_, Desktop>) -> std::result::Result<(), String> {
    let result = || -> Result<()> {
        let mut snapshot = lock(&state.0.snapshot)?;
        ensure!(
            snapshot.profile.is_none() && !snapshot.login_pending,
            "Sign-in already active"
        );

        let mut cancelled = lock(&state.0.login_cancelled)?;
        cancelled.store(true, Ordering::Release);
        *cancelled = Arc::new(AtomicBool::new(false));
        state.0.commands.send(Command::NativeLogin {
            restoring: true,
            cancelled: cancelled.clone(),
        })?;
        snapshot.login_pending = true;
        snapshot.login_issue = None;
        Ok(())
    };
    result().map_err(error)
}
#[tauri::command]
fn sign_out(state: State<'_, Desktop>) -> std::result::Result<(), String> {
    state.0.dj_requests.cancel_all();
    state.0.dj_voice.cancel_all();
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
    if ["home", "liked", "queue", "recent"].contains(&key) {
        return true;
    }
    if let Some(query) = key.strip_prefix("search:") {
        return !query.trim().is_empty() && query.len() <= 500;
    }
    ["album:", "artist:", "playlist:", "liked-artist:"]
        .into_iter()
        .any(|prefix| {
            key.strip_prefix(prefix).is_some_and(|id| {
                id.len() == 22 && id.bytes().all(|byte| byte.is_ascii_alphanumeric())
            })
        })
}
#[tauri::command]
async fn home(
    timezone: String,
    app: tauri::AppHandle,
    state: State<'_, Desktop>,
) -> std::result::Result<(), String> {
    let inner = state.0.clone();
    let (account, generation) = {
        let mut snapshot = lock(&inner.snapshot).map_err(error)?;
        let account = snapshot
            .profile
            .as_ref()
            .context("Sign in first")
            .map_err(error)?
            .id
            .clone();
        if !snapshot.native_ready {
            // The frontend retries Home when the native-ready event arrives.
            return Ok(());
        }
        if timezone.len() > 100 || timezone.chars().any(char::is_control) {
            return Err("Invalid time zone".into());
        }
        snapshot.home_loading = true;
        snapshot.home_error.clear();
        (
            account,
            inner.home_generation.fetch_add(1, Ordering::SeqCst) + 1,
        )
    };
    let _ = app.emit(
        "spotiflex",
        json!({"type":"home_loading","account":account}),
    );
    let controls = inner.controls.scoped(&account).map_err(error)?;
    let result = tauri::async_runtime::spawn_blocking(move || {
        let page = controls.home(&timezone)?;
        crate::library_cache::save_home(&page);
        Ok::<_, anyhow::Error>(page)
    })
    .await;
    let mut snapshot = lock(&inner.snapshot).map_err(error)?;
    if inner.home_generation.load(Ordering::SeqCst) != generation
        || snapshot.profile.as_ref().map(|profile| &profile.id) != Some(&account)
    {
        return Ok(());
    }
    snapshot.home_loading = false;
    match result {
        Ok(Ok(page)) if page.account == account => {
            snapshot.home = Some(page.clone());
            let _ = app.emit("spotiflex", json!({"type":"home","page":page}));
        }
        _ => {
            snapshot.home_error = "Personalized Home could not load. Try refreshing.".into();
            let _ = app.emit(
                "spotiflex",
                json!({"type":"home_error","account":account,"message":snapshot.home_error}),
            );
        }
    }
    Ok(())
}
#[tauri::command]
fn browse(
    key: String,
    generation: u64,
    offset: usize,
    state: State<'_, Desktop>,
    app: tauri::AppHandle,
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
            snapshot.search_playlists.clear();
            snapshot.search_artists.clear();
            snapshot.search_albums.clear();
            snapshot.search_top_results.clear();
            snapshot.search_users.clear();
            snapshot.search_playlists_loading = key.starts_with("search:");
            snapshot.search_playlists_error.clear();
            snapshot.browse_info = snapshot
                .profile
                .as_ref()
                .and_then(|profile| crate::library_cache::info(&profile.id, &key));
            if let Some(info) = snapshot.browse_info.as_ref() {
                let _ = app.emit(
                    "spotiflex",
                    json!({"type":"browse_info","generation":generation,"info":info}),
                );
                if info
                    .overview
                    .as_ref()
                    .is_some_and(|overview| !overview.details_loaded)
                {
                    state.0.commands.send(Command::ArtistTracks {
                        account: snapshot
                            .profile
                            .as_ref()
                            .context("Sign in first")?
                            .id
                            .clone(),
                        generation,
                        info: Box::new(info.clone()),
                    })?;
                }
            }
            snapshot.settings.last_view = key.clone();
            snapshot.settings.save()?;
        }
        ensure!(
            snapshot.route == key && snapshot.generation == generation,
            "Page changed"
        );
        snapshot.loading = true;
        if key == "home" {
            snapshot.loading = false;
            snapshot.more = false;
            return Ok(());
        }
        if offset == 0
            && (key.starts_with("album:")
                || key.starts_with("artist:")
                || key.starts_with("playlist:"))
        {
            if snapshot.native_ready && (key.starts_with("artist:") || key.starts_with("album:")) {
                let account = snapshot
                    .profile
                    .as_ref()
                    .context("Sign in first")?
                    .id
                    .clone();
                load_native_catalogue(
                    state.0.clone(),
                    app.clone(),
                    account,
                    key.clone(),
                    Some(generation),
                );
            }
            if !snapshot.native_ready || key.starts_with("playlist:") {
                state.0.commands.send(Command::BrowseInfo {
                    key: key.clone(),
                    generation,
                })?;
            }
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
/// Page kinds for start timing; never the page's ID or search text.
fn page_kind(route: &str) -> &'static str {
    match route.split_once(':').map_or(route, |(kind, _)| kind) {
        "search" => "search",
        "playlist" => "playlist",
        "album" => "album",
        "artist" => "artist",
        "liked" | "liked-artist" => "liked",
        "recent" => "recent",
        "queue" => "queue",
        "home" => "home",
        _ => "other",
    }
}

/// Append one click-to-audio time to a small local diagnostics log.
fn record_start_time(kind: &str, elapsed: Duration) {
    use std::io::Write;
    let Ok(dir) = crate::config::data_dir().map(|dir| dir.join("diagnostics")) else {
        return;
    };
    let path = dir.join("start-times.log");
    if std::fs::create_dir_all(&dir).is_err() {
        return;
    }
    if std::fs::metadata(&path).is_ok_and(|meta| meta.len() > 64 * 1024) {
        let _ = std::fs::remove_file(&path);
    }
    let when = time::OffsetDateTime::now_utc()
        .format(&time::format_description::well_known::Rfc3339)
        .unwrap_or_default();
    if let Ok(mut file) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
    {
        let _ = writeln!(file, "{when} {kind} {}ms", elapsed.as_millis());
    }
}

fn local_load(action: PlayerAction, tracks: &[Track]) -> Result<PlayerAction> {
    if matches!(&action,PlayerAction::PlayContext{context,..} if context==crate::home::DJ_URI) {
        return Ok(action);
    }
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
            "dj" => PlayerAction::PlayContext {
                context: crate::home::DJ_URI.into(),
                offset: None,
            },
            "play_home" => {
                let context = self.context.clone().context("Playback context missing")?;
                let route = crate::home::route(&context).context("Invalid music context")?;
                if route.starts_with("track:") {
                    PlayerAction::Play(Some(context))
                } else {
                    ensure!(route != "liked", "Open Liked Songs first");
                    PlayerAction::PlayContext {
                        context,
                        offset: None,
                    }
                }
            }
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
            "enqueue" => {
                let uri = self.uri.clone().context("Track URI missing")?;
                native::queue_uri(&uri)?;
                PlayerAction::Enqueue(uri)
            }
            "transfer" => PlayerAction::Transfer(self.uri.clone().context("Device missing")?),
            _ => anyhow::bail!("Unknown playback command"),
        })
    }
}
#[tauri::command]
fn player(
    app: tauri::AppHandle,
    request: PlayerRequest,
    target: Option<String>,
    state: State<'_, Desktop>,
) -> std::result::Result<(), String> {
    if !matches!(request.command.as_str(), "volume" | "shuffle" | "repeat") {
        state.0.dj_requests.cancel_all();
    }
    let result = || -> Result<()> {
        let mut snapshot = lock(&state.0.snapshot)?;
        ensure!(snapshot.profile.is_some(), "Sign in first");
        let mut action = request.action()?;
        let native_context = matches!(request.command.as_str(), "dj" | "play_home");
        let local = plays_locally(
            &request.command,
            target.as_deref(),
            lock(&state.0.native_id)?.as_deref(),
            &snapshot.playback.device,
        );
        if local
            && matches!(action, PlayerAction::Play(None))
            && !state.0.controls.has_track()
            && snapshot.playback.item.is_none()
        {
            if let Some(saved) = snapshot
                .profile
                .as_ref()
                .and_then(|profile| crate::resume::load(&profile.id))
            {
                restore_playback(&mut snapshot, saved);
            } else if let Some(track) = snapshot
                .tracks
                .iter()
                .find(|track| !track.is_local)
                .cloned()
            {
                snapshot.playback.item = Some(track);
                snapshot.playback.progress_ms = Some(0);
            } else {
                anyhow::bail!("Choose a song to start playback");
            }
        }
        if local
            && !state.0.controls.has_track()
            && let (Some(profile), Some(track)) =
                (snapshot.profile.as_ref(), snapshot.playback.item.as_ref())
            && let Some(restored) = crate::resume::restore_dj_action(
                &profile.id,
                &track.uri,
                snapshot.playback.progress_ms.unwrap_or_default(),
                &action,
            )
        {
            action = restored;
        }
        if local
            && matches!(action, PlayerAction::Play(None))
            && !state.0.controls.has_track()
            && let Some(track) = snapshot.playback.item.as_ref()
        {
            let queue = snapshot
                .profile
                .as_ref()
                .map(|profile| crate::resume::queue(&profile.id))
                .filter(|queue| !queue.is_empty())
                .unwrap_or_else(|| {
                    snapshot
                        .tracks
                        .iter()
                        .filter(|item| !item.is_local)
                        .take(100)
                        .map(|item| item.uri.clone())
                        .collect()
                });
            action = crate::resume::restore_action(
                &track.uri,
                &queue,
                snapshot.playback.progress_ms.unwrap_or_default(),
            );
        }
        // After a restart the player shows the saved song without loading it;
        // skipping starts the saved queue one song on or back.
        if local
            && matches!(action, PlayerAction::Next | PlayerAction::Previous)
            && !state.0.controls.has_track()
        {
            if snapshot.playback.item.is_none()
                && let Some(saved) = snapshot
                    .profile
                    .as_ref()
                    .and_then(|profile| crate::resume::load(&profile.id))
            {
                restore_playback(&mut snapshot, saved);
            }
            let track = snapshot
                .playback
                .item
                .clone()
                .context("Choose a song to start playback")?;
            let queue = snapshot
                .profile
                .as_ref()
                .map(|profile| crate::resume::queue(&profile.id))
                .filter(|queue| queue.contains(&track.uri))
                .unwrap_or_else(|| {
                    snapshot
                        .tracks
                        .iter()
                        .filter(|item| !item.is_local)
                        .take(100)
                        .map(|item| item.uri.clone())
                        .collect()
                });
            action = crate::resume::skip_action(
                &track.uri,
                &queue,
                snapshot.playback.progress_ms.unwrap_or_default(),
                matches!(action, PlayerAction::Next),
            )
            .context(if matches!(action, PlayerAction::Next) {
                "No next song in the saved queue"
            } else {
                "No previous song in the saved queue"
            })?;
        }
        if local && action.supports_native() {
            if matches!(action, PlayerAction::Enqueue(_)) {
                ensure!(
                    state.0.controls.has_track(),
                    "Play a song on this computer before adding to its queue."
                );
            }
            if matches!(action, PlayerAction::Next | PlayerAction::Previous) {
                *lock(&state.0.pending_track)? = None;
            }
            if !native_context {
                action = local_load(action, &snapshot.tracks)?;
            }
            if let Some(NativeEvent::Ready(id)) = state
                .0
                .controls
                .connection_event(snapshot.profile.as_ref().map(|profile| profile.id.as_str()))
            {
                snapshot.native_ready = true;
                snapshot.native_status = "Ready · this computer".into();
                *lock(&state.0.native_id)? = Some(id);
                state.0.controls.send(action.clone()).map_err(|_| {
                    anyhow::anyhow!(
                        "Native audio disconnected. Reconnect native audio in Settings."
                    )
                })?;
                if matches!(action, PlayerAction::Enqueue(_)) {
                    let _ = app.emit(
                        "spotiflex",
                        json!({"type":"notice","message":"Added to queue","error":false}),
                    );
                    return Ok(());
                }
                let _ = app.emit(
                    "spotiflex",
                    json!({"type":"native","ready":true,"status":snapshot.native_status}),
                );
            } else if matches!(action, PlayerAction::Pause) {
                *lock(&state.0.queued_native)? = None;
                return Ok(());
            } else {
                if matches!(
                    state.0.controls.connection_event(
                        snapshot.profile.as_ref().map(|profile| profile.id.as_str())
                    ),
                    Some(NativeEvent::Error(_))
                ) {
                    state.0.commands.send(Command::EnsureAudio)?;
                }
                ensure!(
                    matches!(
                        action,
                        PlayerAction::Play(_)
                            | PlayerAction::Resume { .. }
                            | PlayerAction::PlayUris { .. }
                            | PlayerAction::PlayContext { .. }
                            | PlayerAction::RestoreDJ { .. }
                    ),
                    "Native audio is connecting. Try again when ready."
                );
                *lock(&state.0.queued_native)? = Some((action.clone(), Instant::now()));
            }
            if let Some(profile) = snapshot.profile.as_ref() {
                crate::resume::remember_queue(&profile.id, &action);
            }
            if let Some(track) = request.track {
                if let Ok(mut pending) = state.0.pending_track.lock() {
                    *pending = Some((track.uri.clone(), Instant::now()));
                }
                if let Ok(mut timing) = state.0.start_timing.lock() {
                    *timing = Some((
                        track.uri.clone(),
                        Instant::now(),
                        page_kind(&snapshot.route),
                    ));
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
async fn test_audio_output(state: State<'_, Desktop>) -> std::result::Result<bool, String> {
    let name = {
        let snapshot = lock(&state.0.snapshot).map_err(error)?;
        snapshot
            .profile
            .as_ref()
            .context("Sign in first")
            .map_err(error)?;
        snapshot.settings.audio_output.clone()
    };
    tauri::async_runtime::spawn_blocking(move || crate::audio_output::test_sound(name))
        .await
        .map_err(error)?
        .map_err(error)?;
    Ok(true)
}
#[tauri::command]
fn refresh(state: State<'_, Desktop>) -> std::result::Result<(), String> {
    if lock(&state.0.snapshot).map_err(error)?.profile.is_none() {
        return Err("Sign in first".into());
    }
    state.0.commands.send(Command::Refresh).map_err(error)
}
#[tauri::command]
fn save_item(
    uri: String,
    saved: bool,
    state: State<'_, Desktop>,
) -> std::result::Result<(), String> {
    if !crate::collection::supports(&uri) {
        return Err("Choose a Spotify song, album or artist".into());
    }
    state
        .0
        .commands
        .send(Command::SetSaved { uri, saved })
        .map_err(error)
}
#[tauri::command]
async fn audio_outputs(state: State<'_, Desktop>) -> std::result::Result<Vec<String>, String> {
    if lock(&state.0.snapshot).map_err(error)?.profile.is_none() {
        return Err("Sign in first".to_owned());
    }
    tauri::async_runtime::spawn_blocking(crate::audio_output::devices)
        .await
        .map_err(|_| "Audio output worker unavailable".to_owned())?
        .map_err(error)
}
#[tauri::command]
fn save_settings(settings: Settings, state: State<'_, Desktop>) -> std::result::Result<(), String> {
    let result = || -> Result<()> {
        let mut snapshot = lock(&state.0.snapshot)?;
        let mut settings = settings;
        let output_changed = settings.audio_output != snapshot.settings.audio_output;
        if output_changed {
            ensure!(snapshot.profile.is_some(), "Sign in first");
            ensure!(
                settings
                    .audio_output
                    .as_deref()
                    .is_none_or(crate::audio_output::valid_name),
                "Choose a valid audio output"
            );
        }
        settings.client_id = snapshot.settings.client_id.clone();
        settings.last_view = snapshot.route.clone();
        settings.volume_percent = snapshot.settings.volume_percent;
        settings.lyric_size = settings.lyric_size.clamp(18.0, 72.0);
        settings.ui_zoom_percent = settings.ui_zoom_percent.clamp(75, 200);
        settings.lyric_offset_ms = settings.lyric_offset_ms.clamp(-10_000, 10_000);
        settings.save()?;
        if output_changed && let Some(profile) = snapshot.profile.as_ref() {
            state
                .0
                .controls
                .set_audio_output(&profile.id, settings.audio_output.clone());
        }
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
    mode: Option<crate::lyrics::ImportMode>,
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
            mode: mode.unwrap_or_default(),
        })
        .map_err(error)
}
/// Drop any imported lyrics for the playing song and load the provider's.
#[tauri::command]
fn reset_lyrics(state: State<'_, Desktop>) -> std::result::Result<(), String> {
    let track = lock(&state.0.snapshot)
        .map_err(error)?
        .playback
        .item
        .clone()
        .ok_or("Play a track first")?;
    state
        .0
        .lyrics
        .send(LyricCommand::Forget(track.clone()))
        .map_err(error)?;
    state
        .0
        .commands
        .send(Command::FetchLyrics(track))
        .map_err(error)
}
/// Songs the user liked by an artist, for the artist page's "You Liked".
#[tauri::command]
async fn artist_liked_count(
    id: String,
    state: State<'_, Desktop>,
) -> std::result::Result<usize, String> {
    let account = lock(&state.0.snapshot)
        .map_err(error)?
        .profile
        .as_ref()
        .context("Sign in first")
        .map_err(error)?
        .id
        .clone();
    let controls = state.0.controls.scoped(&account).map_err(error)?;
    tauri::async_runtime::spawn_blocking(move || controls.liked_by_artist(&id))
        .await
        .map_err(|_| "Library worker unavailable".to_owned())?
        .map_err(error)
}
#[tauri::command]
async fn saved_lyrics(
    state: State<'_, Desktop>,
) -> std::result::Result<Vec<crate::lyrics::SavedLyrics>, String> {
    let account = lock(&state.0.snapshot)
        .map_err(error)?
        .profile
        .as_ref()
        .context("Sign in first")
        .map_err(error)?
        .id
        .clone();
    let controls = state.0.controls.scoped(&account).map_err(error)?;
    tauri::async_runtime::spawn_blocking(move || {
        let mut saved = crate::lyrics::saved_imports()?;
        // Older imports lack album art; look their songs up once and keep it.
        let missing: Vec<String> = saved
            .iter()
            .filter(|item| item.image.is_empty() && item.uri.starts_with("spotify:track:"))
            .map(|item| item.uri.clone())
            .take(50)
            .collect();
        if !missing.is_empty()
            && let Ok(tracks) = controls.resolve(&missing)
        {
            crate::lyrics::complete_saved(&mut saved, &tracks);
        }
        Ok::<_, anyhow::Error>(saved)
    })
    .await
    .map_err(|_| "Saved lyrics are unavailable".to_owned())?
    .map_err(error)
}
/// A saved lyric file and its download name.
#[tauri::command]
fn saved_lyrics_file(key: String) -> std::result::Result<(String, String), String> {
    crate::lyrics::saved_file(&key).map_err(error)
}
#[tauri::command]
fn delete_saved_lyrics(key: String, state: State<'_, Desktop>) -> std::result::Result<(), String> {
    crate::lyrics::delete_saved(&key).map_err(error)?;
    // Reload the playing song's lyrics if its import was the one removed.
    if let Some(track) = lock(&state.0.snapshot)
        .map_err(error)?
        .playback
        .item
        .clone()
    {
        let _ = state.0.commands.send(Command::FetchLyrics(track));
    }
    Ok(())
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
fn saved_status(uris: Vec<String>, state: State<'_, Desktop>) -> std::result::Result<(), String> {
    if uris.len() > 500 {
        return Err("Too many library items".into());
    }
    state
        .0
        .commands
        .send(Command::SavedStatus(uris))
        .map_err(error)
}
#[tauri::command]
fn create_folder(name: String, state: State<'_, Desktop>) -> std::result::Result<(), String> {
    if lock(&state.0.snapshot).map_err(error)?.profile.is_none() {
        return Err("Sign in first".into());
    }
    state
        .0
        .commands
        .send(Command::CreateFolder(name))
        .map_err(error)
}
#[tauri::command]
fn move_to_folder(
    playlist: String,
    folder: Option<String>,
    state: State<'_, Desktop>,
) -> std::result::Result<(), String> {
    if lock(&state.0.snapshot).map_err(error)?.profile.is_none() {
        return Err("Sign in first".into());
    }
    state
        .0
        .commands
        .send(Command::MoveToFolder { playlist, folder })
        .map_err(error)
}
#[tauri::command]
fn rename_folder(
    id: String,
    name: String,
    state: State<'_, Desktop>,
) -> std::result::Result<(), String> {
    if lock(&state.0.snapshot).map_err(error)?.profile.is_none() {
        return Err("Sign in first".into());
    }
    state
        .0
        .commands
        .send(Command::RenameFolder { id, name })
        .map_err(error)
}
#[tauri::command]
fn delete_folder(id: String, state: State<'_, Desktop>) -> std::result::Result<(), String> {
    if lock(&state.0.snapshot).map_err(error)?.profile.is_none() {
        return Err("Sign in first".into());
    }
    state
        .0
        .commands
        .send(Command::DeleteFolder(id))
        .map_err(error)
}
#[tauri::command]
fn edit_playlist(
    playlist: Playlist,
    name: String,
    description: String,
    state: State<'_, Desktop>,
) -> std::result::Result<(), String> {
    if lock(&state.0.snapshot).map_err(error)?.profile.is_none() {
        return Err("Sign in first".into());
    }
    state
        .0
        .commands
        .send(Command::EditPlaylist {
            playlist,
            name,
            description,
        })
        .map_err(error)
}
#[tauri::command]
fn move_playlist_song(
    playlist: Playlist,
    from: usize,
    uri: String,
    to: usize,
    state: State<'_, Desktop>,
) -> std::result::Result<(), String> {
    if lock(&state.0.snapshot).map_err(error)?.profile.is_none() {
        return Err("Sign in first".into());
    }
    state
        .0
        .commands
        .send(Command::MovePlaylistSong {
            playlist,
            from,
            uri,
            to,
        })
        .map_err(error)
}
#[tauri::command]
fn remove_from_playlist(
    playlist: Playlist,
    index: usize,
    uri: String,
    state: State<'_, Desktop>,
) -> std::result::Result<(), String> {
    if lock(&state.0.snapshot).map_err(error)?.profile.is_none() {
        return Err("Sign in first".into());
    }
    state
        .0
        .commands
        .send(Command::RemoveFromPlaylist {
            playlist,
            index,
            uri,
        })
        .map_err(error)
}
#[tauri::command]
fn remove_playlist(
    id: String,
    name: String,
    state: State<'_, Desktop>,
) -> std::result::Result<(), String> {
    if lock(&state.0.snapshot).map_err(error)?.profile.is_none() {
        return Err("Sign in first".into());
    }
    state
        .0
        .commands
        .send(Command::RemovePlaylist { id, name })
        .map_err(error)
}
#[tauri::command]
fn create_playlist(
    name: String,
    tracks: Vec<Track>,
    state: State<'_, Desktop>,
) -> std::result::Result<(), String> {
    if lock(&state.0.snapshot).map_err(error)?.profile.is_none() {
        return Err("Sign in first".into());
    }
    if tracks.len() > 10_000 {
        return Err("Choose fewer songs".into());
    }
    state
        .0
        .commands
        .send(Command::CreatePlaylist { name, tracks })
        .map_err(error)
}
/// Hides scrollbars in the creator profile sheet; wheel and touch scrolling
/// still work.
const HIDE_SCROLLBARS: &str = r#"(() => {
  const style = document.createElement("style");
  style.textContent = "*{scrollbar-width:none!important}::-webkit-scrollbar{display:none!important;width:0!important;height:0!important}";
  const add = () => (document.head || document.documentElement).appendChild(style);
  if (document.documentElement) add();
  else document.addEventListener("DOMContentLoaded", add, { once: true });
})();"#;
#[tauri::command]
async fn open_creator_profile(
    app: tauri::AppHandle,
    username: String,
    user_id: Option<String>,
) -> std::result::Result<(), String> {
    let resolved = if let Some(id) = user_id.filter(|id| !id.is_empty()) {
        Some(
            tauri::async_runtime::spawn_blocking(move || crate::provider::creator_profile(&id))
                .await
                .map_err(error)?
                .map_err(error)?,
        )
    } else {
        None
    };
    let result = || -> Result<()> {
        use sha2::{Digest, Sha256};
        let url = resolved.map_or_else(|| creator_profile_url(&username), Ok)?;
        let digest = Sha256::digest(url.as_str());
        let label = format!(
            "creator-{}",
            digest
                .iter()
                .take(12)
                .map(|byte| format!("{byte:02x}"))
                .collect::<String>()
        );
        if let Some(window) = app.get_webview_window(&label) {
            window.set_focus()?;
            return Ok(());
        }
        // One profile at a time.
        for (name, window) in app.webview_windows() {
            if name.starts_with("creator-") {
                let _ = window.close();
            }
        }
        let title = format!(
            "{} · Spicy Lyrics",
            username
                .chars()
                .filter(|character| !character.is_control())
                .take(80)
                .collect::<String>()
        );
        let main = app
            .get_webview_window("main")
            .context("Main window missing")?;
        // A borderless sheet fixed over the main window, which dims behind
        // it; clicking anywhere else closes it.
        let window =
            tauri::WebviewWindowBuilder::new(&app, label, tauri::WebviewUrl::External(url))
                .title(title)
                .decorations(false)
                .resizable(false)
                .skip_taskbar(true)
                .shadow(true)
                .visible(false)
                .parent(&main)?
                .initialization_script(HIDE_SCROLLBARS)
                .on_navigation(|url| {
                    url.scheme() == "https" && url.host_str() == Some("spicylyrics.org")
                })
                .build()?;
        let (origin, size, scale) = (
            main.inner_position()?,
            main.inner_size()?,
            main.scale_factor()?,
        );
        // 1080 px keeps the profile page in its two-column layout.
        let width = (f64::from(size.width) * 0.9).min(1080. * scale);
        let height = (f64::from(size.height) * 0.9).min(800. * scale);
        window.set_size(tauri::PhysicalSize::new(width, height))?;
        window.set_position(tauri::PhysicalPosition::new(
            f64::from(origin.x) + (f64::from(size.width) - width) / 2.,
            f64::from(origin.y) + (f64::from(size.height) - height) / 2.,
        ))?;
        let _ = app.emit("spotiflex", json!({"type":"creator_profile","open":true}));
        let events = app.clone();
        let popup = window.clone();
        window.on_window_event(move |event| match event {
            tauri::WindowEvent::Focused(false) => {
                let _ = popup.close();
            }
            tauri::WindowEvent::Destroyed => {
                let open = events
                    .webview_windows()
                    .keys()
                    .any(|name| name.starts_with("creator-") && name != popup.label());
                let _ = events.emit("spotiflex", json!({"type":"creator_profile","open":open}));
            }
            _ => {}
        });
        window.show()?;
        window.set_focus()?;
        Ok(())
    };
    result().map_err(error)
}
/// A Spotify user's profile page, read through this account's native session.
#[tauri::command]
async fn user_profile(
    state: State<'_, Desktop>,
    user: String,
) -> std::result::Result<crate::user_profile::UserProfilePage, String> {
    if !crate::user_profile::valid_user(&user) {
        return Err("Invalid Spotify profile".into());
    }
    let account = lock(&state.0.snapshot)
        .map_err(error)?
        .profile
        .as_ref()
        .context("Sign in first")
        .map_err(error)?
        .id
        .clone();
    let controls = state.0.controls.scoped(&account).map_err(error)?;
    tauri::async_runtime::spawn_blocking(move || {
        controls.run(async |session| crate::user_profile::fetch(session, &user).await)
    })
    .await
    .map_err(error)?
    .map_err(|_| "Profile unavailable. Try again shortly.".to_owned())
}
/// Follow or unfollow a Spotify user; returns the confirmed state.
#[tauri::command]
async fn follow_user(
    state: State<'_, Desktop>,
    user: String,
    follow: bool,
) -> std::result::Result<bool, String> {
    if !crate::user_profile::valid_user(&user) {
        return Err("Invalid Spotify profile".into());
    }
    let account = lock(&state.0.snapshot)
        .map_err(error)?
        .profile
        .as_ref()
        .context("Sign in first")
        .map_err(error)?
        .id
        .clone();
    let controls = state.0.controls.scoped(&account).map_err(error)?;
    tauri::async_runtime::spawn_blocking(move || {
        controls
            .run(async |session| crate::user_profile::set_following(session, &user, follow).await)
    })
    .await
    .map_err(error)?
    .map_err(|_| {
        if follow {
            "Could not follow this profile. Try again shortly.".to_owned()
        } else {
            "Could not unfollow this profile. Try again shortly.".to_owned()
        }
    })
}
/// The next page of one search category, for "Load more".
#[tauri::command]
async fn search_page(
    state: State<'_, Desktop>,
    query: String,
    kind: String,
    offset: usize,
) -> std::result::Result<crate::search::SearchPage, String> {
    let account = lock(&state.0.snapshot)
        .map_err(error)?
        .profile
        .as_ref()
        .context("Sign in first")
        .map_err(error)?
        .id
        .clone();
    let controls = state.0.controls.scoped(&account).map_err(error)?;
    tauri::async_runtime::spawn_blocking(move || {
        controls.run(async |session| crate::search::page(session, &query, &kind, offset).await)
    })
    .await
    .map_err(error)?
    .map_err(|_| "More results are unavailable right now. Try again shortly.".to_owned())
}
#[tauri::command]
async fn resolve_album(
    state: State<'_, Desktop>,
    uri: String,
) -> std::result::Result<crate::model::Album, String> {
    let account = lock(&state.0.snapshot)
        .map_err(error)?
        .profile
        .as_ref()
        .context("Sign in first")
        .map_err(error)?
        .id
        .clone();
    let controls = state.0.controls.scoped(&account).map_err(error)?;
    if lock(&state.0.snapshot).map_err(error)?.profile.is_none() {
        return Err("Sign in first".into());
    }
    tauri::async_runtime::spawn_blocking(move || controls.track(&uri).map(|track| track.album))
        .await
        .map_err(error)?
        .map_err(|_| "Album metadata unavailable. Try again shortly.".to_owned())
}
fn creator_profile_url(username: &str) -> Result<url::Url> {
    let name = username.trim().trim_start_matches('@');
    ensure!(
        !name.is_empty()
            && name.chars().count() <= 80
            && !name
                .chars()
                .any(|character| character.is_control() || character == '/' || character == '\\')
            && !matches!(name, "." | ".."),
        "Invalid creator username"
    );
    let mut url = url::Url::parse("https://spicylyrics.org/embed/")?;
    url.path_segments_mut()
        .map_err(|_| anyhow::anyhow!("Invalid profile path"))?
        .pop_if_empty()
        .push(name);
    Ok(url)
}
#[tauri::command]
fn open_link(url: String) -> std::result::Result<(), String> {
    let parsed = url::Url::parse(&url).map_err(|_| "Invalid link")?;
    if parsed.scheme() != "https"
        || !matches!(
            parsed.host_str(),
            Some(
                "open.spotify.com"
                    | "www.spotify.com"
                    | "developer.spotify.com"
                    | "developers.spicylyrics.org"
                    | "spicylyrics.org"
                    | "lyrprep.spicylyrics.org"
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
/// Taskbar buttons and the system media session.
struct Media(crate::media::Session);
/// The frontend reports the current item so the taskbar buttons and the
/// system media session match what is playing.
#[tauri::command]
fn media_state(state: crate::media::MediaState, app: tauri::AppHandle, media: State<'_, Media>) {
    media.0.update(&app, state);
}
/// Ask WebView2 to hold little memory (it drops GPU textures, decoded images
/// and other caches, about half its footprint on a 4K screen) or to return
/// to normal. The page keeps rendering either way.
#[cfg(windows)]
fn memory_target(window: &tauri::WebviewWindow, low: bool) {
    let _ = window.with_webview(move |webview| unsafe {
        use webview2_com::Microsoft::Web::WebView2::Win32::{
            COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_LOW,
            COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_NORMAL, ICoreWebView2_19,
        };
        use windows::core::Interface;
        if let Ok(core) = webview.controller().CoreWebView2()
            && let Ok(core) = core.cast::<ICoreWebView2_19>()
        {
            let _ = core.SetMemoryUsageTargetLevel(if low {
                COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_LOW
            } else {
                COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_NORMAL
            });
        }
    });
}
#[cfg(not(windows))]
fn memory_target(_window: &tauri::WebviewWindow, _low: bool) {}
/// Disk space used by cached songs, in bytes.
#[tauri::command]
async fn audio_cache_size() -> u64 {
    tauri::async_runtime::spawn_blocking(crate::audio_cache::size)
        .await
        .unwrap_or_default()
}
/// Delete cached songs; returns the bytes freed.
#[tauri::command]
async fn clear_audio_cache() -> std::result::Result<u64, String> {
    tauri::async_runtime::spawn_blocking(crate::audio_cache::clear)
        .await
        .map_err(|_| "Cache cleanup was interrupted".to_owned())?
        .map_err(error)
}
/// Drop WebView2 caches once after browsing, while the window stays usable.
#[tauri::command]
fn trim_memory(window: tauri::WebviewWindow) {
    memory_target(&window, true);
    thread::spawn(move || {
        thread::sleep(Duration::from_secs(2));
        if window.is_focused().unwrap_or(true) {
            memory_target(&window, false);
        }
    });
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
            if let Some(window) = app.get_webview_window("main") {
                window.set_icon(tauri::image::Image::new_owned(
                    crate::app_icon::icon_rgba(64),
                    64,
                    64,
                ))?;
                // WebView2 keeps rendering while minimized, so tell the page
                // when to suspend or throttle its GPU animations.
                let activity = window.clone();
                #[cfg(windows)]
                let was_minimized = AtomicBool::new(false);
                let was_lean = AtomicBool::new(false);
                window.on_window_event(move |event| {
                    // Space Gravity lyrics react to the window being dragged.
                    if let tauri::WindowEvent::Moved(position) = event {
                        let scale = activity.scale_factor().unwrap_or(1.0);
                        let _ = activity.emit(
                            "spotiflex",
                            json!({
                                "type": "window_moved",
                                "x": f64::from(position.x) / scale,
                                "y": f64::from(position.y) / scale,
                            }),
                        );
                    }
                    if matches!(
                        event,
                        tauri::WindowEvent::Resized(_) | tauri::WindowEvent::Focused(_)
                    ) {
                        let minimized = activity.is_minimized().unwrap_or(false);
                        let focused = activity.is_focused().unwrap_or(true);
                        // Hiding the WebView2 controller makes Chromium stop
                        // compositing and throttle timers, so a minimized
                        // window uses no GPU. Audio runs natively and continues.
                        #[cfg(windows)]
                        if was_minimized.swap(minimized, Ordering::SeqCst) != minimized {
                            let _ = activity.with_webview(move |webview| unsafe {
                                let _ = webview.controller().SetIsVisible(!minimized);
                            });
                        }
                        // In the background (music playing behind other
                        // windows) the page needs few caches; keep it lean.
                        let lean = minimized || !focused;
                        if was_lean.swap(lean, Ordering::SeqCst) != lean {
                            memory_target(&activity, lean);
                        }
                        let _ = activity.emit(
                            "spotiflex",
                            json!({"type":"window_activity","minimized":minimized,"focused":focused}),
                        );
                    }
                });
            }
            app.manage(Desktop::start(app.handle().clone())?);
            let handle = app.handle().clone();
            let session = crate::media::Session::start(app.handle(), move |action| {
                let position = match action {
                    crate::media::MediaAction::Seek(position) => Some(position),
                    _ => None,
                };
                let _ = handle.emit(
                    "spotiflex",
                    json!({"type":"media_control","action":action.name(),"position_ms":position}),
                );
            });
            app.manage(Media(session));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            dj_request,
            dj_prepare,
            dj_voice,
            dj_release_voice,
            dj_cancel,
            home,
            bootstrap,
            sign_in,
            cancel_sign_in,
            retry_sign_in,
            prefetch_canvas,
            prefetch_page,
            trim_memory,
            audio_cache_size,
            clear_audio_cache,
            prefetch_metadata,
            sign_out,
            browse,
            player,
            retry_audio,
            test_audio_output,
            refresh,
            save_item,
            save_settings,
            audio_outputs,
            configure_provider,
            configure_spicy_lyrics,
            retry_lyrics,
            import_lyrics,
            reset_lyrics,
            saved_lyrics,
            saved_lyrics_file,
            artist_liked_count,
            delete_saved_lyrics,
            add_tracks,
            create_playlist,
            remove_playlist,
            remove_from_playlist,
            edit_playlist,
            create_folder,
            rename_folder,
            delete_folder,
            move_to_folder,
            move_playlist_song,
            saved_status,
            open_link,
            open_creator_profile,
            resolve_album,
            user_profile,
            follow_user,
            search_page,
            app_update,
            media_state
        ])
        .build(tauri::generate_context!())?;
    app.run(|app, event| {
        if matches!(&event,tauri::RunEvent::WindowEvent{label,event:tauri::WindowEvent::Destroyed,..}if label=="main"){app.exit(0);}
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
    fn early_play_requests_start_once_when_native_audio_is_ready() {
        for context in [
            "spotify:track:0123456789abcdefghijkl",
            "spotify:playlist:0123456789abcdefghijkl",
            crate::home::DJ_URI,
        ] {
            let request: PlayerRequest =
                serde_json::from_value(json!({"command":"play_home", "context":context})).unwrap();
            let queued = Mutex::new(Some((request.action().unwrap(), Instant::now())));
            let (controls, mut commands) = NativeControls::test_active("startup-listener");
            assert!(commands.try_recv().is_err());
            assert!(send_queued_native(&queued, &controls));
            match commands.try_recv().unwrap() {
                PlayerAction::Play(Some(uri)) | PlayerAction::PlayContext { context: uri, .. } => {
                    assert_eq!(uri, context)
                }
                _ => panic!("Expected the queued playback request"),
            }
            assert!(!send_queued_native(&queued, &controls));
            assert!(
                commands.try_recv().is_err(),
                "Readiness updates must not replay the request"
            );
        }
    }

    #[test]
    fn expired_or_cancelled_startup_requests_do_not_start_later() {
        let (controls, mut commands) = NativeControls::test_active("startup-listener");
        let queued = Mutex::new(Some((
            PlayerAction::Play(Some("spotify:track:0123456789abcdefghijkl".into())),
            Instant::now() - QUEUED_NATIVE_TTL,
        )));
        assert!(!send_queued_native(&queued, &controls));
        assert!(!send_queued_native(&Mutex::new(None), &controls));
        assert!(commands.try_recv().is_err());
    }

    #[test]
    fn dj_launch_keeps_session_context_without_playlist_tracks() {
        let request: PlayerRequest = serde_json::from_value(json!({"command":"dj"})).unwrap();
        let action = local_load(request.action().unwrap(), &[])
            .expect("DJ must resolve its session rather than a static playlist");
        assert!(
            matches!(action,PlayerAction::PlayContext{context,offset:None} if context==crate::home::DJ_URI)
        );
    }
    #[test]
    fn creator_profiles_use_usernames_and_encode_path_characters() {
        assert_eq!(
            creator_profile_url("@Arashii").unwrap().as_str(),
            "https://spicylyrics.org/embed/Arashii"
        );
        assert!(creator_profile_url("../other").is_err());
        assert_eq!(
            creator_profile_url("Name#1234").unwrap().as_str(),
            "https://spicylyrics.org/embed/Name%231234"
        );
    }
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
    fn page_play_follows_the_selected_speaker_and_dj_stays_local() {
        let speaker = Device {
            id: Some("echo".into()),
            name: "Gameroom".into(),
            ..Device::default()
        };
        // The album page's Play button sends play_home; it used to start on
        // this computer while a speaker was selected.
        assert!(!plays_locally(
            "play_home",
            Some("echo"),
            Some("session-id"),
            &speaker
        ));
        assert!(plays_locally(
            "play_home",
            Some("native"),
            Some("session-id"),
            &speaker
        ));
        assert!(plays_locally(
            "dj",
            Some("echo"),
            Some("session-id"),
            &speaker
        ));
    }
    #[test]
    fn routes_reject_arbitrary_urls_and_malformed_ids() {
        assert!(valid_route("search:Petite Meller"));
        assert!(valid_route("recent"));
        assert!(valid_route("album:0123456789abcdefghijkl"));
        assert!(valid_route("liked-artist:0123456789abcdefghijkl"));
        assert!(!valid_route("liked-artist:short"));
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
