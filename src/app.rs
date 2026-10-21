use std::{
    collections::HashSet,
    path::PathBuf,
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    time::{Duration, Instant},
};

use eframe::egui::{
    self, Align2, Color32, Id, Modifiers, Pos2, Rect, RichText, Sense, Stroke, Ui, Vec2, vec2,
};

use crate::{
    api::PlayerAction,
    config::{self, PlaylistFolder, Settings},
    lyrics::Lyrics,
    model::{self, Artwork, Device, Playback, Playlist, Profile, Track},
    native::NativeEvent,
    ui::{
        art::{self, ArtCache},
        emoji,
        icons::{self, Icon},
        lyrics_view::{self, LyricsView},
        theme::{
            self, ACCENT, BASE, ELEVATED, ERROR, FAINT, GAP, HIGHLIGHT, RADIUS, SUBDUED, SURFACE,
            TEXT,
        },
    },
    updater::{self, Updater},
    worker::{Command, Event, LyricCommand, Worker},
};

const LIKED_COLOR: Color32 = Color32::from_rgb(120, 70, 200);
const ROW_HEIGHT: f32 = 56.0;
const PLAYER_HEIGHT: f32 = 84.0;
const SEARCH_ID: &str = "global-search";

#[derive(Clone, Copy, PartialEq, Eq)]
enum Center {
    Browse,
    Lyrics,
    Settings,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum LibraryFilter {
    All,
    Owned,
    Collaborative,
}

enum RowAction {
    Select(usize, Modifiers),
    Play(usize),
    Pick(usize),
    Enqueue(usize),
    Save(usize),
}

pub struct SpotiFlex {
    updater: Updater,
    available_update: Option<updater::Update>,
    ready_update: Option<updater::ReadyUpdate>,
    update_status: String,
    update_busy: bool,
    exit_after_update: bool,
    settings: Settings,
    worker: Worker,
    profile: Option<Profile>,
    playlists: Vec<Playlist>,
    tracks: Vec<Track>,
    selected: HashSet<usize>,
    anchor: Option<usize>,
    view: String,
    history: Vec<String>,
    future: Vec<String>,
    center: Center,
    immersive: bool,
    pending_fullscreen: Option<bool>,
    search: String,
    library_filter: String,
    library_kind: LibraryFilter,
    library_alphabetical: bool,
    library_search_open: bool,
    library_collapsed: bool,
    playback: Playback,
    observed: Instant,
    devices: Vec<Device>,
    selected_device: Option<String>,
    native_id: Option<String>,
    native_generation: u64,
    native_status: String,
    native_observed: Option<Instant>,
    lyrics: Option<Lyrics>,
    lyric_error: String,
    lyric_loading: bool,
    page_lyrics: LyricsView,
    panel_lyrics: LyricsView,
    art: ArtCache,
    muted_from: Option<u8>,
    picker: Option<Vec<Track>>,
    picker_filter: String,
    import_path: String,
    pending_import: Option<String>,
    folder_name: String,
    login_pending: bool,
    login_restoring: bool,
    login_issue: Option<crate::auth::LoginIssue>,
    login_cancelled: Arc<AtomicBool>,
    loading: bool,
    more: bool,
    notice: String,
    notice_at: Instant,
    error: bool,
    dirty: bool,
    config_damaged: bool,
    tracks_generation: u64,
    provider_input: String,
    provider_consent: bool,
    provider_configured: bool,
}

impl SpotiFlex {
    pub fn new(context: &eframe::CreationContext<'_>) -> Self {
        theme::install(&context.egui_ctx);
        egui_extras::install_image_loaders(&context.egui_ctx);
        let (settings, notice, config_damaged) = match Settings::load() {
            Ok(settings) => (settings, String::new(), false),
            Err(error) => (Settings::default(), error.to_string(), true),
        };
        let notifier = {
            let context = context.egui_ctx.clone();
            crate::notify::Notifier::new(move || context.request_repaint())
        };
        let worker = Worker::start(notifier.clone());
        let login_pending = config::valid_client_id(&settings.client_id);
        if login_pending {
            let _ = worker
                .commands
                .send(Command::Restore(settings.client_id.clone()));
        }
        let search = settings
            .last_view
            .strip_prefix("search:")
            .unwrap_or_default()
            .to_owned();
        Self {
            updater: Updater::start(notifier),
            available_update: None,
            ready_update: None,
            update_status: "Checking for updates…".into(),
            update_busy: false,
            exit_after_update: false,
            view: settings.last_view.clone(),
            settings,
            worker,
            profile: None,
            playlists: Vec::new(),
            tracks: Vec::new(),
            selected: HashSet::new(),
            anchor: None,
            history: Vec::new(),
            future: Vec::new(),
            center: Center::Browse,
            immersive: false,
            pending_fullscreen: None,
            search,
            library_filter: String::new(),
            library_kind: LibraryFilter::All,
            library_alphabetical: false,
            library_search_open: false,
            library_collapsed: false,
            playback: Playback::default(),
            observed: Instant::now(),
            devices: Vec::new(),
            selected_device: None,
            native_id: None,
            native_generation: 0,
            native_status: "Waiting for sign-in".into(),
            native_observed: None,
            lyrics: None,
            lyric_error: String::new(),
            lyric_loading: false,
            page_lyrics: LyricsView::default(),
            panel_lyrics: LyricsView::default(),
            art: ArtCache::default(),
            muted_from: None,
            picker: None,
            picker_filter: String::new(),
            import_path: String::new(),
            pending_import: None,
            folder_name: String::new(),
            login_pending,
            login_restoring: login_pending,
            login_issue: None,
            login_cancelled: Arc::new(AtomicBool::new(false)),
            loading: false,
            more: false,
            notice,
            notice_at: Instant::now(),
            error: config_damaged,
            dirty: false,
            config_damaged,
            tracks_generation: 0,
            provider_input: String::new(),
            provider_consent: false,
            provider_configured: crate::provider::configured(),
        }
    }

    fn send(&self, command: Command) {
        let _ = self.worker.commands.send(command);
    }

    fn show_notice(&mut self, message: String, error: bool) {
        self.notice = message;
        self.notice_at = Instant::now();
        self.error = error;
    }

    fn save_settings(&mut self) {
        if self.config_damaged || !self.dirty {
            return;
        }
        match self.settings.save() {
            Ok(()) => self.dirty = false,
            Err(error) => self.show_notice(error.to_string(), true),
        }
    }

    /// Load `key` into the browse area without touching navigation history.
    fn navigate(&mut self, key: String) {
        self.tracks_generation = self.tracks_generation.wrapping_add(1);
        self.view = key.clone();
        self.settings.last_view = key.clone();
        self.dirty = true;
        self.tracks.clear();
        self.selected.clear();
        self.anchor = None;
        self.more = false;
        if self.profile.is_some() {
            self.loading = true;
            self.send(Command::Tracks {
                key,
                offset: 0,
                generation: self.tracks_generation,
            });
        }
        self.save_settings();
    }

    /// User navigation: records history and returns to the browse area.
    fn open(&mut self, key: String) {
        self.leave_page();
        if key != self.view {
            self.history.push(self.view.clone());
            self.history.truncate(64);
            self.future.clear();
        }
        self.navigate(key);
    }

    fn leave_page(&mut self) {
        if self.center == Center::Settings {
            self.save_settings();
        }
        self.center = Center::Browse;
        self.set_immersive(false);
    }

    fn back(&mut self) {
        if self.center != Center::Browse {
            self.leave_page();
        } else if let Some(previous) = self.history.pop() {
            self.future.push(self.view.clone());
            self.navigate(previous);
        }
    }

    fn forward(&mut self) {
        if let Some(next) = self.future.pop() {
            self.leave_page();
            self.history.push(self.view.clone());
            self.navigate(next);
        }
    }

    fn set_immersive(&mut self, immersive: bool) {
        self.immersive = immersive;
        self.pending_fullscreen = Some(immersive);
    }

    /// Attach a local .ttml/.lrc file to the current song. The file is kept
    /// per track and used whenever that song plays again.
    fn import_lyrics(&mut self, path: PathBuf) {
        let Some(track) = self.playback.item.clone() else {
            self.show_notice("Play a song first, then drop its lyrics file".into(), true);
            return;
        };
        self.lyric_loading = true;
        self.pending_import = Some(track.uri.clone());
        let _ = self.worker.lyrics.send(LyricCommand::Import(track, path));
    }

    fn forget_lyrics(&mut self) {
        if let Some(track) = self.playback.item.clone() {
            let _ = self.worker.lyrics.send(LyricCommand::Forget(track));
            self.lyrics = None;
            self.page_lyrics.reset();
            self.panel_lyrics.reset();
            self.fetch_lyrics();
            self.show_notice("Imported lyrics removed for this song".into(), false);
        }
    }

    fn dropped_lyrics(&mut self, context: &egui::Context) {
        let dropped = context.input(|input| {
            input
                .raw
                .dropped_files
                .iter()
                .filter_map(|file| file.path.clone())
                .find(|path| {
                    path.extension()
                        .and_then(|extension| extension.to_str())
                        .is_some_and(|extension| {
                            ["ttml", "lrc", "xml"]
                                .contains(&extension.to_ascii_lowercase().as_str())
                        })
                })
        });
        if let Some(path) = dropped
            && self.profile.is_some()
        {
            self.import_lyrics(path);
        }
        let hovering = context.input(|input| !input.raw.hovered_files.is_empty());
        if hovering && self.profile.is_some() {
            let screen = context.content_rect();
            let painter = context.layer_painter(egui::LayerId::new(
                egui::Order::Foreground,
                Id::new("drop-lyrics"),
            ));
            painter.rect_filled(screen, 0.0, Color32::from_black_alpha(170));
            let title = match &self.playback.item {
                Some(track) => format!("Drop to attach lyrics to “{}”", track.name),
                None => "Play a song first to attach lyrics".into(),
            };
            painter.text(
                screen.center() - vec2(0.0, 14.0),
                Align2::CENTER_CENTER,
                title,
                theme::bold(24.0),
                TEXT,
            );
            painter.text(
                screen.center() + vec2(0.0, 20.0),
                Align2::CENTER_CENTER,
                ".ttml or .lrc · saved for this song",
                theme::regular(15.0),
                SUBDUED,
            );
        }
    }

    fn fetch_lyrics(&mut self) {
        if let Some(track) = self.playback.item.clone() {
            self.lyric_loading = true;
            self.lyric_error.clear();
            self.send(Command::FetchLyrics(track));
        }
    }

    fn receive(&mut self) {
        while let Ok(event) = self.updater.events.try_recv() {
            match event {
                updater::Event::Current => {
                    self.update_status = "Up to date".into();
                }
                updater::Event::Available(update) => {
                    self.update_status = format!("Version {} available", update.manifest.version);
                    if self.settings.auto_download_updates
                        && !self.update_busy
                        && self.ready_update.is_none()
                    {
                        self.update_busy = true;
                        let _ = self
                            .updater
                            .commands
                            .send(updater::Command::Download(update.clone()));
                    }
                    self.available_update = Some(update);
                }
                updater::Event::Progress { downloaded, total } => {
                    self.update_status = format!(
                        "Downloading update: {}%",
                        downloaded.saturating_mul(100) / total.max(1)
                    );
                }
                updater::Event::Ready(update) => {
                    self.update_status = format!("Version {} ready to install", update.version);
                    self.ready_update = Some(update);
                    self.update_busy = false;
                }
                updater::Event::Restarted => {
                    self.login_cancelled.store(true, Ordering::Relaxed);
                    self.save_settings();
                    self.exit_after_update = true;
                }
                updater::Event::Error(message) => {
                    self.update_status = message;
                    self.update_busy = false;
                }
            }
        }
        while let Ok(event) = self.worker.events.try_recv() {
            match event {
                Event::BrowseInfo { .. }
                | Event::PlayingDetails { .. }
                | Event::ArtistStats { .. }
                | Event::Canvas { .. }
                | Event::TrackFacts(..)
                | Event::LastPlayed { .. }
                | Event::CanvasPrefetched { .. }
                | Event::PagePrefetched { .. }
                | Event::Saved { .. }
                | Event::SavedMany(..)
                | Event::PageChanged(..)
                | Event::TrackInfo { .. } => {}
                Event::Session(profile) => {
                    if !self.login_pending {
                        continue;
                    }
                    self.login_issue = None;
                    self.login_restoring = false;
                    self.profile = Some(profile);
                    self.native_status = "Connecting…".into();
                    self.navigate(self.view.clone());
                }
                Event::SignedOut => {
                    self.login_issue = None;
                    self.profile = None;
                    self.playlists.clear();
                    self.tracks.clear();
                    self.devices.clear();
                    self.selected.clear();
                    self.history.clear();
                    self.future.clear();
                    self.center = Center::Browse;
                    self.set_immersive(false);
                    self.playback = Playback::default();
                    self.lyrics = None;
                    self.native_id = None;
                    self.selected_device = None;
                    self.picker = None;
                    self.native_status = "Waiting for sign-in".into();
                    self.lyric_loading = false;
                }
                Event::LoginFinished => {
                    self.login_pending = false;
                    self.login_restoring = false;
                }
                Event::LoginFailed(issue) => {
                    self.login_restoring = false;
                    self.login_pending = false;
                    self.login_issue = Some(issue);
                }
                Event::NativeStarting(generation) => {
                    self.native_generation = generation;
                    if self.selected_device == self.native_id {
                        self.selected_device = None;
                    }
                    self.native_id = None;
                    self.native_status = "Connecting…".into();
                }
                Event::SearchResults {
                    account,
                    key,
                    generation,
                    results,
                    message,
                } => {
                    if self
                        .profile
                        .as_ref()
                        .is_some_and(|profile| profile.id == account)
                        && key == self.view
                        && generation == self.tracks_generation
                    {
                        self.tracks = results.tracks;
                        self.loading = false;
                        self.more = false;
                        if !message.is_empty() {
                            self.show_notice(message, true);
                        }
                    }
                }
                Event::Library(playlists) => self.playlists = playlists,
                Event::LibraryFolders(_) => {}
                Event::Tracks {
                    key,
                    offset,
                    generation,
                    tracks,
                } if key == self.view && generation == self.tracks_generation => {
                    self.loading = false;
                    self.more = tracks.len() == 50 && !key.starts_with("search:");
                    if offset == 0 {
                        self.tracks = tracks;
                    } else if offset == self.tracks.len() {
                        self.tracks.extend(tracks);
                    }
                }
                Event::Tracks { .. } => {}
                Event::TracksFailed {
                    generation,
                    message,
                } => {
                    if generation == self.tracks_generation {
                        self.loading = false;
                        self.show_notice(message, true);
                    }
                }
                Event::Playback(playback, observed) => {
                    if self.native_observed.is_some_and(|native| observed < native) {
                        continue;
                    }
                    let changed = self.playback.item.as_ref().map(|track| &track.uri)
                        != playback.item.as_ref().map(|track| &track.uri);
                    self.playback = *playback;
                    self.observed = observed;
                    if changed {
                        self.lyrics = None;
                        self.lyric_error.clear();
                        self.page_lyrics.reset();
                        self.panel_lyrics.reset();
                        if self.settings.show_lyrics || self.center == Center::Lyrics {
                            self.fetch_lyrics();
                        }
                    }
                }
                Event::Devices(devices) => self.devices = devices,
                Event::Notice(message) => self.show_notice(message, false),
                Event::Error(message) => {
                    self.show_notice(message, true);
                }
            }
        }
        while let Ok(message) = self.worker.native_events.try_recv() {
            if self.profile.is_none() || message.generation != self.native_generation {
                continue;
            }
            match message.event {
                NativeEvent::Authorizing => {
                    self.native_status =
                        "Authorize audio playback in your browser (one-time)…".into();
                    self.show_notice(
                        "One-time step: authorize audio playback in the browser tab that just opened.".into(),
                        false,
                    );
                }
                NativeEvent::Ready(id) => {
                    self.native_id = Some(id.clone());
                    self.native_status = "Ready · this computer".into();
                    // Make this PC the playback device unless something else
                    // is already playing.
                    if self.playback.device.id.is_none() || !self.playback.is_playing {
                        self.selected_device = None;
                        self.send(Command::Player {
                            action: PlayerAction::Transfer(id),
                            device: None,
                        });
                    }
                }
                NativeEvent::Track(_) | NativeEvent::Narration(_) | NativeEvent::DJContext(_) => {}
                NativeEvent::QueueChanged => {
                    if let Some(track) = self.playback.item.clone() {
                        self.send(Command::PlayingDetails(track));
                    }
                }
                NativeEvent::Stopped => self.playback.is_playing = false,
                NativeEvent::Transport {
                    shuffle,
                    repeat,
                    volume,
                } => {
                    if let Some(shuffle) = shuffle {
                        self.playback.shuffle_state = shuffle;
                    }
                    if let Some(repeat) = repeat {
                        self.playback.repeat_state = repeat;
                    }
                    if let Some(volume) = volume {
                        self.playback.device.volume_percent = Some(volume);
                    }
                }
                NativeEvent::Error(message) => {
                    self.native_id = None;
                    self.show_notice(message.clone(), true);
                    self.native_status = message;
                }
                NativeEvent::Reconnecting(seconds) => {
                    self.native_id = None;
                    self.playback.is_playing = false;
                    self.native_status = format!("Reconnecting native audio in {seconds}s…");
                }
                NativeEvent::ControlError(message) => self.show_notice(message, true),
                NativeEvent::Position {
                    uri,
                    position_ms,
                    playing,
                    ..
                } => {
                    if self.playback.apply_native_position(
                        self.native_id.as_deref(),
                        &crate::native::device_name(),
                        &uri,
                        position_ms,
                        playing,
                    ) {
                        let now = Instant::now();
                        self.native_observed = Some(now);
                        self.observed = now;
                    }
                }
            }
        }
        while let Ok(event) = self.worker.lyric_events.try_recv() {
            if event.uri.is_empty() {
                match event.result {
                    Ok(_) => {
                        self.provider_configured = true;
                        self.show_notice("Protected lyrics configuration saved".into(), false);
                        self.fetch_lyrics();
                    }
                    Err(error) => self.show_notice(error, true),
                }
                continue;
            }
            if self
                .playback
                .item
                .as_ref()
                .is_some_and(|track| track.uri == event.uri)
            {
                self.lyric_loading = false;
                let imported = self.pending_import.as_deref() == Some(event.uri.as_str());
                match event.result {
                    Ok(lyrics) => {
                        self.lyrics = Some(lyrics);
                        self.lyric_error.clear();
                        self.page_lyrics.reset();
                        self.panel_lyrics.reset();
                        if imported {
                            self.show_notice("Lyrics saved for this song".into(), false);
                        }
                    }
                    Err(message) if imported => self.show_notice(message, true),
                    Err(message) => self.lyric_error = message,
                }
                if imported {
                    self.pending_import = None;
                }
            }
        }
    }

    fn position(&self) -> u64 {
        let elapsed = if self.playback.is_playing {
            self.observed.elapsed().as_millis() as u64
        } else {
            0
        };
        let duration = self
            .playback
            .item
            .as_ref()
            .map_or(0, |track| track.duration_ms);
        self.playback
            .progress_ms
            .unwrap_or(0)
            .saturating_add(elapsed)
            .min(duration)
    }

    fn lyric_position(&self) -> u64 {
        self.position()
            .saturating_add_signed(self.settings.lyric_offset_ms)
    }

    fn action(&self, action: PlayerAction) {
        let own_name = crate::native::device_name();
        let local = self.native_id.is_some()
            && match self.selected_device.as_deref() {
                Some(id) => {
                    self.native_id.as_deref() == Some(id)
                        || self.devices.iter().any(|device| {
                            device.id.as_deref() == Some(id) && device.name == own_name
                        })
                }
                None => self.playback.device.id.is_none() || self.playback.device.name == own_name,
            };
        let action = if local {
            match self.worker.native_controls.send(action) {
                Ok(()) => return,
                Err(action) => action,
            }
        } else {
            action
        };
        let device = self
            .selected_device
            .clone()
            .or_else(|| self.playback.device.id.clone())
            .or_else(|| self.native_id.clone());
        self.send(Command::Player { action, device });
    }

    fn toggle_play(&self) {
        self.action(if self.playback.is_playing {
            PlayerAction::Pause
        } else {
            PlayerAction::Play(None)
        });
    }

    /// Play a track from the current list, keeping its playlist or list as context
    /// so next and previous continue through the same songs.
    fn play_track(&self, index: usize) {
        let Some(track) = self.tracks.get(index) else {
            return;
        };
        if let Some(id) = self.view.strip_prefix("playlist:")
            && !track.is_local
        {
            self.action(PlayerAction::PlayContext {
                context: format!("spotify:playlist:{id}"),
                offset: Some(track.uri.clone()),
            });
        } else if let Some((uris, offset)) = model::play_window(&self.tracks, index, 100) {
            self.action(PlayerAction::PlayUris { uris, offset });
        } else {
            self.action(PlayerAction::Play(Some(track.uri.clone())));
        }
    }

    fn play_view(&self) {
        if let Some(id) = self.view.strip_prefix("playlist:") {
            self.action(PlayerAction::PlayContext {
                context: format!("spotify:playlist:{id}"),
                offset: None,
            });
        } else if let Some(index) = self.tracks.iter().position(|track| !track.is_local) {
            self.play_track(index);
        }
    }

    fn is_current(&self, track: &Track) -> bool {
        self.playback
            .item
            .as_ref()
            .is_some_and(|current| current.uri == track.uri)
    }

    fn selected_tracks(&self) -> Vec<Track> {
        let mut indices: Vec<_> = self.selected.iter().copied().collect();
        indices.sort_unstable();
        indices
            .into_iter()
            .filter_map(|index| self.tracks.get(index).cloned())
            .collect()
    }

    fn select(&mut self, index: usize, modifiers: Modifiers) {
        if modifiers.shift
            && let Some(anchor) = self.anchor
        {
            if !modifiers.command {
                self.selected.clear();
            }
            self.selected.extend(anchor.min(index)..=anchor.max(index));
        } else if modifiers.command {
            if !self.selected.remove(&index) {
                self.selected.insert(index);
            }
            self.anchor = Some(index);
        } else {
            self.selected.clear();
            self.selected.insert(index);
            self.anchor = Some(index);
        }
    }

    fn view_title(&self) -> String {
        if let Some(id) = self.view.strip_prefix("playlist:") {
            self.playlists
                .iter()
                .find(|playlist| playlist.id == id)
                .map_or("Playlist".to_owned(), |playlist| playlist.name.clone())
        } else if let Some(query) = self.view.strip_prefix("search:") {
            format!("Results for “{query}”")
        } else {
            match self.view.as_str() {
                "liked" => "Liked Songs",
                "queue" => "Queue",
                _ => "Home",
            }
            .into()
        }
    }

    // ---------------------------------------------------------------- top bar

    fn top_bar(&mut self, context: &egui::Context) {
        egui::TopBottomPanel::top("navigation")
            .exact_height(64.0)
            .show_separator_line(false)
            .frame(egui::Frame::new().fill(BASE).inner_margin(vec2(12.0, 8.0)))
            .show(context, |ui| {
                let full = ui.max_rect();
                let mid = full.center().y;
                // Left: brand and history.
                brand(ui.painter(), Pos2::new(full.left() + 16.0, mid), 28.0);
                let can_back = self.center != Center::Browse || !self.history.is_empty();
                let can_forward = !self.future.is_empty();
                for (index, (icon, enabled, tip)) in [
                    (Icon::Back, can_back, "Go back"),
                    (Icon::Forward, can_forward, "Go forward"),
                ]
                .into_iter()
                .enumerate()
                {
                    let rect = Rect::from_center_size(
                        Pos2::new(full.left() + 58.0 + index as f32 * 36.0, mid),
                        Vec2::splat(32.0),
                    );
                    ui.painter()
                        .circle_filled(rect.center(), 16.0, Color32::from_white_alpha(10));
                    let response = ui.interact(rect, Id::new(tip), Sense::click());
                    let color = if !enabled {
                        FAINT
                    } else if response.hovered() {
                        TEXT
                    } else {
                        SUBDUED
                    };
                    icons::paint(ui.painter(), rect.shrink(9.0), icon, color);
                    if enabled && response.on_hover_text(tip).clicked() {
                        if icon == Icon::Back {
                            self.back();
                        } else {
                            self.forward();
                        }
                    }
                }

                // Center: home and search pill.
                let search_width = (full.width() - 360.0).clamp(180.0, 480.0);
                let group = 48.0 + GAP + search_width;
                let group_left = (full.center().x - group / 2.0).max(full.left() + 140.0);
                let home =
                    Rect::from_min_size(Pos2::new(group_left, mid - 24.0), Vec2::splat(48.0));
                let home_response = ui.interact(home, Id::new("home"), Sense::click());
                let on_home = self.view == "home" && self.center == Center::Browse;
                ui.painter().circle_filled(
                    home.center(),
                    24.0,
                    if home_response.hovered() {
                        HIGHLIGHT
                    } else {
                        ELEVATED
                    },
                );
                icons::paint(
                    ui.painter(),
                    home.shrink(13.0),
                    Icon::Home,
                    if on_home || home_response.hovered() {
                        TEXT
                    } else {
                        SUBDUED
                    },
                );
                if home_response.on_hover_text("Home").clicked() {
                    self.open("home".into());
                }
                let pill = Rect::from_min_size(
                    Pos2::new(home.right() + GAP, mid - 24.0),
                    vec2(search_width, 48.0),
                );
                let search_id = Id::new(SEARCH_ID);
                let focused = ui.memory(|memory| memory.has_focus(search_id));
                let pill_hovered = ui.rect_contains_pointer(pill);
                ui.painter().rect(
                    pill,
                    24.0,
                    if pill_hovered || focused {
                        HIGHLIGHT
                    } else {
                        ELEVATED
                    },
                    if focused {
                        Stroke::new(2.0_f32, TEXT)
                    } else if pill_hovered {
                        Stroke::new(1.0_f32, Color32::from_white_alpha(40))
                    } else {
                        Stroke::NONE
                    },
                    egui::StrokeKind::Inside,
                );
                icons::paint(
                    ui.painter(),
                    Rect::from_center_size(Pos2::new(pill.left() + 26.0, mid), Vec2::splat(22.0)),
                    Icon::Search,
                    if focused { TEXT } else { SUBDUED },
                );
                let field = Rect::from_min_max(
                    Pos2::new(pill.left() + 48.0, mid - 12.0),
                    Pos2::new(pill.right() - 44.0, mid + 12.0),
                );
                let response = ui.put(
                    field,
                    egui::TextEdit::singleline(&mut self.search)
                        .id(search_id)
                        .frame(false)
                        .font(theme::regular(15.5))
                        .hint_text(RichText::new("What do you want to play?").color(SUBDUED))
                        .desired_width(field.width()),
                );
                if response.lost_focus()
                    && ui.input(|input| input.key_pressed(egui::Key::Enter))
                    && !self.search.trim().is_empty()
                {
                    self.open(format!("search:{}", self.search.trim()));
                }
                if !self.search.is_empty() {
                    let clear = Rect::from_center_size(
                        Pos2::new(pill.right() - 24.0, mid),
                        Vec2::splat(24.0),
                    );
                    if icons::button_at(
                        ui,
                        clear,
                        Id::new("clear-search"),
                        Icon::Close,
                        12.0,
                        false,
                        "Clear",
                    )
                    .clicked()
                    {
                        self.search.clear();
                    }
                }

                // Right: updates, settings, profile.
                let mut x = full.right() - 18.0;
                if let Some(profile) = &self.profile {
                    let name = profile.display_name.clone().unwrap_or(profile.id.clone());
                    let avatar = Rect::from_center_size(Pos2::new(x - 4.0, mid), Vec2::splat(32.0));
                    let response = ui.interact(avatar, Id::new("avatar"), Sense::click());
                    ui.painter().circle_filled(avatar.center(), 20.0, ELEVATED);
                    ui.painter().circle_filled(
                        avatar.center(),
                        15.0,
                        theme::accent_for(&profile.id),
                    );
                    ui.painter().text(
                        avatar.center(),
                        Align2::CENTER_CENTER,
                        name.chars()
                            .next()
                            .unwrap_or('?')
                            .to_uppercase()
                            .to_string(),
                        theme::bold(15.0),
                        Color32::BLACK,
                    );
                    if response.on_hover_text(&name).clicked() {
                        self.center = Center::Settings;
                    }
                    x -= 48.0;
                }
                let gear = Rect::from_center_size(Pos2::new(x, mid), Vec2::splat(32.0));
                if icons::button_at(
                    ui,
                    gear,
                    Id::new("settings"),
                    Icon::Settings,
                    20.0,
                    self.center == Center::Settings,
                    "Settings",
                )
                .clicked()
                {
                    if self.center == Center::Settings {
                        self.leave_page();
                    } else {
                        self.center = Center::Settings;
                    }
                }
                x -= 40.0;
                if self.ready_update.is_some() || self.available_update.is_some() {
                    let label = if self.ready_update.is_some() {
                        "Update ready"
                    } else {
                        "Update available"
                    };
                    let galley = theme::line(ui, label, theme::bold(13.0), Color32::BLACK, 200.0);
                    let rect = Rect::from_min_max(
                        Pos2::new(x - galley.size().x - 28.0, mid - 15.0),
                        Pos2::new(x - 8.0, mid + 15.0),
                    );
                    if rect.left() > pill.right() + 12.0 {
                        let response = ui.interact(rect, Id::new("update-pill"), Sense::click());
                        ui.painter().rect_filled(
                            rect,
                            15.0,
                            if response.hovered() {
                                theme::ACCENT_HOVER
                            } else {
                                ACCENT
                            },
                        );
                        emoji::paint_galley(
                            ui.painter(),
                            rect.center() - galley.size() / 2.0,
                            galley,
                            Color32::BLACK,
                        );
                        if response.clicked() {
                            self.center = Center::Settings;
                        }
                    }
                }
            });
    }

    // ---------------------------------------------------------------- library

    fn sidebar(&mut self, context: &egui::Context, collapsed: bool) {
        let frame = egui::Frame::new()
            .fill(SURFACE)
            .corner_radius(RADIUS)
            .inner_margin(vec2(8.0, 12.0))
            .outer_margin(egui::Margin {
                left: 8,
                right: 4,
                top: 0,
                bottom: 0,
            });
        let panel = if collapsed {
            egui::SidePanel::left("library-collapsed")
                .resizable(false)
                .exact_width(88.0)
        } else {
            egui::SidePanel::left("library")
                .resizable(true)
                .default_width(320.0)
                .width_range(260.0..=440.0)
        };
        panel
            .show_separator_line(false)
            .frame(frame)
            .show(context, |ui| {
                if collapsed {
                    self.library_collapsed_list(ui);
                } else {
                    self.library_list(ui);
                }
            });
    }

    fn library_collapsed_list(&mut self, ui: &mut Ui) {
        ui.vertical_centered(|ui| {
            if icons::button(ui, Icon::Library, 24.0, false, "Expand Your Library").clicked() {
                self.library_collapsed = false;
            }
        });
        ui.add_space(6.0);
        let playlists = self.playlists.clone();
        egui::ScrollArea::vertical()
            .id_salt("library-collapsed-scroll")
            .show(ui, |ui| {
                ui.vertical_centered(|ui| {
                    let (rect, response) =
                        ui.allocate_exact_size(Vec2::splat(56.0), Sense::click());
                    hover_fill(ui, rect, &response, self.view == "liked");
                    liked_cover(ui.painter(), rect.shrink(4.0));
                    if response.on_hover_text("Liked Songs").clicked() {
                        self.open("liked".into());
                    }
                    for playlist in &playlists {
                        let key = format!("playlist:{}", playlist.id);
                        let (rect, response) =
                            ui.allocate_exact_size(Vec2::splat(56.0), Sense::click());
                        hover_fill(ui, rect, &response, self.view == key);
                        cover(ui, rect.shrink(4.0), &playlist.images, 4);
                        if response.on_hover_text(&playlist.name).clicked() {
                            self.open(key);
                        }
                    }
                });
            });
    }

    fn library_list(&mut self, ui: &mut Ui) {
        ui.horizontal(|ui| {
            let response = ui.add(
                egui::Label::new(
                    RichText::new("Your Library")
                        .font(theme::bold(16.0))
                        .color(TEXT),
                )
                .sense(Sense::click()),
            );
            if response.on_hover_text("Collapse Your Library").clicked() {
                self.library_collapsed = true;
            }
            ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                if icons::button(ui, Icon::Collapse, 16.0, false, "Collapse").clicked() {
                    self.library_collapsed = true;
                }
                if icons::button(ui, Icon::Refresh, 16.0, false, "Refresh playlists").clicked()
                    && self.profile.is_some()
                {
                    self.send(Command::Library);
                }
            });
        });
        ui.add_space(4.0);
        ui.horizontal(|ui| {
            ui.spacing_mut().item_spacing.x = 8.0;
            for (kind, label) in [
                (LibraryFilter::All, "Playlists"),
                (LibraryFilter::Owned, "By you"),
                (LibraryFilter::Collaborative, "Collaborative"),
            ] {
                if chip(ui, label, self.library_kind == kind).clicked() {
                    self.library_kind = if self.library_kind == kind && kind != LibraryFilter::All {
                        LibraryFilter::All
                    } else {
                        kind
                    };
                }
            }
        });
        ui.add_space(2.0);
        ui.horizontal(|ui| {
            if self.library_search_open {
                let response = ui.add(
                    egui::TextEdit::singleline(&mut self.library_filter)
                        .hint_text("Search in Your Library")
                        .desired_width((ui.available_width() - 110.0).max(80.0))
                        .margin(vec2(10.0, 6.0)),
                );
                if response.lost_focus() && self.library_filter.is_empty() {
                    self.library_search_open = false;
                }
            } else if icons::button(ui, Icon::Search, 16.0, false, "Search in Your Library")
                .clicked()
            {
                self.library_search_open = true;
            }
            ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                let label = if self.library_alphabetical {
                    "Alphabetical"
                } else {
                    "Recents"
                };
                if ui
                    .add(
                        egui::Label::new(RichText::new(label).size(13.0).color(SUBDUED))
                            .sense(Sense::click()),
                    )
                    .on_hover_text("Change sort order")
                    .clicked()
                {
                    self.library_alphabetical = !self.library_alphabetical;
                }
            });
        });
        ui.add_space(4.0);

        let filter = self.library_filter.to_lowercase();
        let user = self
            .profile
            .as_ref()
            .map_or(String::new(), |profile| profile.id.clone());
        let mut playlists: Vec<&Playlist> = self
            .playlists
            .iter()
            .filter(|playlist| playlist.name.to_lowercase().contains(&filter))
            .filter(|playlist| match self.library_kind {
                LibraryFilter::All => true,
                LibraryFilter::Owned => playlist.owner.id == user,
                LibraryFilter::Collaborative => playlist.collaborative,
            })
            .collect();
        if self.library_alphabetical {
            playlists.sort_by_key(|playlist| playlist.name.to_lowercase());
        }
        let compact = self.settings.compact_library;
        let row_height = if compact { 36.0 } else { 64.0 };
        let show_liked = filter.is_empty() && self.library_kind != LibraryFilter::Collaborative;
        let count = playlists.len() + usize::from(show_liked);
        let mut open = None;
        egui::ScrollArea::vertical()
            .id_salt("library-scroll")
            .auto_shrink(false)
            .show_rows(ui, row_height, count, |ui, range| {
                for index in range {
                    let (rect, response) = ui.allocate_exact_size(
                        vec2(ui.available_width(), row_height),
                        Sense::click(),
                    );
                    let entry = if show_liked {
                        index.checked_sub(1)
                    } else {
                        Some(index)
                    };
                    let (key, name, subtitle) = match entry.and_then(|index| playlists.get(index)) {
                        None => (
                            "liked".to_owned(),
                            "Liked Songs".to_owned(),
                            "Playlist • Pinned".to_owned(),
                        ),
                        Some(playlist) => {
                            let owner = playlist
                                .owner
                                .display_name
                                .clone()
                                .unwrap_or(playlist.owner.id.clone());
                            (
                                format!("playlist:{}", playlist.id),
                                playlist.name.clone(),
                                if playlist.collaborative {
                                    format!("Collaborative • {owner}")
                                } else {
                                    format!("Playlist • {owner}")
                                },
                            )
                        }
                    };
                    let current = self.view == key && self.center == Center::Browse;
                    hover_fill(ui, rect, &response, current);
                    let mut text_left = rect.left() + 10.0;
                    if !compact {
                        let art = Rect::from_min_size(
                            Pos2::new(rect.left() + 8.0, rect.top() + 8.0),
                            Vec2::splat(48.0),
                        );
                        match entry.and_then(|index| playlists.get(index)) {
                            None => liked_cover(ui.painter(), art),
                            Some(playlist) => cover(ui, art, &playlist.images, 4),
                        }
                        text_left = art.right() + 12.0;
                    }
                    let text_width = rect.right() - text_left - 10.0;
                    let title_color = if current { ACCENT } else { TEXT };
                    if compact {
                        let galley =
                            theme::line(ui, &name, theme::regular(14.5), title_color, text_width);
                        emoji::paint_galley(
                            ui.painter(),
                            Pos2::new(text_left, rect.center().y - galley.size().y / 2.0),
                            galley,
                            title_color,
                        );
                    } else {
                        theme::text(
                            ui,
                            Pos2::new(text_left, rect.top() + 12.0),
                            &name,
                            theme::regular(15.0),
                            title_color,
                            text_width,
                        );
                        theme::text(
                            ui,
                            Pos2::new(text_left, rect.top() + 34.0),
                            &subtitle,
                            theme::regular(13.0),
                            SUBDUED,
                            text_width,
                        );
                    }
                    if let Some(playlist) = entry.and_then(|index| playlists.get(index)) {
                        let id = playlist.id.clone();
                        response.context_menu(|ui| {
                            if ui.button("Open").clicked() {
                                open = Some(format!("playlist:{id}"));
                                ui.close();
                            }
                            if ui.button("Copy clean link").clicked() {
                                ui.ctx()
                                    .copy_text(format!("https://open.spotify.com/playlist/{id}"));
                                ui.close();
                            }
                        });
                    }
                    if response.clicked() {
                        open = Some(key);
                    }
                }
                if self.profile.is_none() {
                    ui.add_space(20.0);
                    ui.label(
                        RichText::new("Sign in to bring your Spotify library here.").color(SUBDUED),
                    );
                }
            });
        if let Some(key) = open {
            self.open(key);
        }
    }

    // ---------------------------------------------------------------- browse

    fn header_accent(&mut self, context: &egui::Context) -> Color32 {
        if let Some(id) = self.view.strip_prefix("playlist:") {
            let playlist = self.playlists.iter().find(|playlist| playlist.id == id);
            let url = playlist.and_then(|playlist| art::pick(&playlist.images, 300.0));
            return self
                .art
                .accent(context, url)
                .unwrap_or_else(|| theme::accent_for(id));
        }
        match self.view.as_str() {
            "liked" => LIKED_COLOR,
            "home" => {
                let url = self
                    .playback
                    .item
                    .as_ref()
                    .and_then(|track| art::pick(&track.album.images, 300.0));
                self.art
                    .accent(context, url)
                    .unwrap_or(Color32::from_rgb(76, 56, 150))
            }
            _ => Color32::from_rgb(52, 52, 84),
        }
    }

    fn collection_view(&self) -> bool {
        self.view == "liked" || self.view.starts_with("playlist:")
    }

    fn home_layout(&self, width: f32) -> (usize, f32, usize, f32) {
        let tile_columns = if width >= 900.0 {
            4
        } else if width >= 520.0 {
            2
        } else {
            1
        };
        let tiles = (self.playlists.len() + 1).min(8);
        let card_count = ((width - 32.0) / 190.0).floor().clamp(2.0, 8.0) as usize;
        let card_width = (width - 32.0 - (card_count - 1) as f32 * 8.0) / card_count as f32;
        let _ = tiles;
        (tile_columns, 64.0, card_count, card_width)
    }

    fn header_height(&self, width: f32) -> f32 {
        if self.collection_view() {
            let art = (width * 0.2).clamp(128.0, 232.0);
            return art + 64.0 + 88.0 + 40.0;
        }
        if self.view == "home" {
            let (columns, tile_height, cards, card_width) = self.home_layout(width);
            let tiles = (self.playlists.len() + 1).min(8);
            let mut height = 88.0 + tiles.div_ceil(columns) as f32 * (tile_height + 8.0) + 16.0;
            if cards > 0 && !self.playlists.is_empty() {
                height += 52.0 + card_width + 74.0;
            }
            return height + 56.0 + 40.0;
        }
        104.0 + 40.0
    }

    fn browse(&mut self, ui: &mut Ui) {
        let panel = ui.max_rect();
        let accent = self.header_accent(ui.ctx());
        let width = panel.width();
        let header = self.header_height(width);
        let rows = self.tracks.len();
        let skeleton = if self.loading && rows == 0 { 8 } else { 0 };
        let empty = !self.loading && rows == 0;
        let total =
            header + (rows + skeleton) as f32 * ROW_HEIGHT + if empty { 120.0 } else { 0.0 } + 96.0;
        let mut actions = Vec::new();
        let mut load_more = false;
        egui::ScrollArea::vertical()
            .id_salt(("browse", &self.view))
            .auto_shrink(false)
            .show_viewport(ui, |ui, viewport| {
                let origin = ui.max_rect().min;
                ui.allocate_space(vec2(width, total));
                let gradient = Rect::from_min_size(origin, vec2(width, header.min(420.0) + 40.0));
                theme::vertical_gradient(
                    ui.painter(),
                    gradient,
                    theme::lerp_color(accent, Color32::BLACK, 0.2),
                    SURFACE,
                );
                self.browse_header(ui, origin, width);
                let columns = Columns::new(width);
                let first = ((viewport.min.y - header) / ROW_HEIGHT).floor().max(0.0) as usize;
                let last =
                    (((viewport.max.y - header) / ROW_HEIGHT).ceil().max(0.0) as usize).min(rows);
                for index in first..last {
                    let rect = Rect::from_min_size(
                        origin + vec2(16.0, header + index as f32 * ROW_HEIGHT),
                        vec2(width - 32.0, ROW_HEIGHT),
                    );
                    self.track_row(ui, rect, index, &columns, &mut actions);
                }
                if skeleton > 0 {
                    let pulse = ((ui.input(|input| input.time) * 3.0).sin() * 0.5 + 0.5) as f32;
                    for index in 0..skeleton {
                        let rect = Rect::from_min_size(
                            origin + vec2(16.0, header + index as f32 * ROW_HEIGHT),
                            vec2(width - 32.0, ROW_HEIGHT),
                        );
                        skeleton_row(ui.painter(), rect, pulse);
                    }
                    ui.ctx().request_repaint_after(Duration::from_millis(50));
                }
                if empty {
                    let rect =
                        Rect::from_min_size(origin + vec2(0.0, header + 24.0), vec2(width, 80.0));
                    let (title, detail) = if self.view == "queue" {
                        (
                            "Your queue is empty",
                            "Add songs from any list with right-click → Add to queue",
                        )
                    } else if self.view.starts_with("search:") {
                        (
                            "No results found",
                            "Check the spelling, or try different keywords",
                        )
                    } else {
                        ("Nothing here yet", "Songs you add will appear here")
                    };
                    ui.painter().text(
                        rect.center_top(),
                        Align2::CENTER_TOP,
                        title,
                        theme::bold(20.0),
                        TEXT,
                    );
                    ui.painter().text(
                        rect.center_top() + vec2(0.0, 32.0),
                        Align2::CENTER_TOP,
                        detail,
                        theme::regular(14.0),
                        SUBDUED,
                    );
                }
                if self.more && !self.loading && viewport.max.y > total - 900.0 {
                    load_more = true;
                }
                if self.loading && rows > 0 {
                    let center =
                        origin + vec2(width / 2.0, header + rows as f32 * ROW_HEIGHT + 30.0);
                    ui.put(
                        Rect::from_center_size(center, Vec2::splat(24.0)),
                        egui::Spinner::new().color(SUBDUED),
                    );
                }
            });
        if load_more {
            self.loading = true;
            self.send(Command::Tracks {
                key: self.view.clone(),
                offset: self.tracks.len(),
                generation: self.tracks_generation,
            });
        }
        for action in actions {
            match action {
                RowAction::Select(index, modifiers) => self.select(index, modifiers),
                RowAction::Play(index) => self.play_track(index),
                RowAction::Pick(index) => {
                    self.picker = Some(if self.selected.contains(&index) {
                        self.selected_tracks()
                    } else {
                        self.tracks.get(index).cloned().into_iter().collect()
                    });
                }
                RowAction::Enqueue(index) => {
                    if let Some(track) = self.tracks.get(index) {
                        self.action(PlayerAction::Enqueue(track.uri.clone()));
                    }
                }
                RowAction::Save(index) => {
                    if let Some(track) = self.tracks.get(index) {
                        self.send(Command::SaveTrack(track.uri.clone()));
                    }
                }
            }
        }
        self.selection_bar(ui, panel);
    }

    fn browse_header(&mut self, ui: &mut Ui, origin: Pos2, width: f32) {
        let pad = 24.0;
        let header = self.header_height(width);
        let columns_top = header - 40.0;
        if self.collection_view() {
            let art_size = (width * 0.2).clamp(128.0, 232.0);
            let art_rect = Rect::from_min_size(origin + vec2(pad, 40.0), Vec2::splat(art_size));
            ui.painter().rect_filled(
                art_rect.translate(vec2(0.0, 8.0)).expand(4.0),
                8.0,
                Color32::from_black_alpha(70),
            );
            let playlist = self
                .view
                .strip_prefix("playlist:")
                .and_then(|id| self.playlists.iter().find(|playlist| playlist.id == id))
                .cloned();
            match &playlist {
                Some(playlist) => cover(ui, art_rect, &playlist.images, 6),
                None => liked_cover(ui.painter(), art_rect),
            }
            let text_left = art_rect.right() + 24.0;
            let text_width = (origin.x + width - pad - text_left).max(60.0);
            let title = self.view_title();
            let galley = [80.0, 64.0, 48.0, 36.0, 28.0]
                .into_iter()
                .map(|size| {
                    ui.painter()
                        .layout_no_wrap(title.clone(), theme::bold(size), TEXT)
                })
                .find(|galley| galley.size().x <= text_width)
                .unwrap_or_else(|| theme::line(ui, &title, theme::bold(28.0), TEXT, text_width));
            let title_top = art_rect.bottom() - galley.size().y - 32.0;
            ui.painter().text(
                Pos2::new(text_left, title_top - 6.0),
                Align2::LEFT_BOTTOM,
                if playlist
                    .as_ref()
                    .is_some_and(|playlist| playlist.collaborative)
                {
                    "Collaborative playlist"
                } else {
                    "Playlist"
                },
                theme::regular(14.0),
                TEXT,
            );
            emoji::paint_galley(ui.painter(), Pos2::new(text_left, title_top), galley, TEXT);
            let owner = match &playlist {
                Some(playlist) => playlist
                    .owner
                    .display_name
                    .clone()
                    .unwrap_or(playlist.owner.id.clone()),
                None => self
                    .profile
                    .as_ref()
                    .map(|profile| profile.display_name.clone().unwrap_or(profile.id.clone()))
                    .unwrap_or_default(),
            };
            let count = self.tracks.len();
            let total: u64 = self.tracks.iter().map(|track| track.duration_ms).sum();
            let summary = if count == 0 {
                owner
            } else {
                format!(
                    "{owner}  •  {count}{} songs  •  {}",
                    if self.more { "+" } else { "" },
                    duration_words(total)
                )
            };
            theme::text(
                ui,
                Pos2::new(text_left, art_rect.bottom() - 20.0),
                &summary,
                theme::regular(14.0),
                Color32::from_white_alpha(220),
                text_width,
            );
            // Action row.
            let row_top = art_rect.bottom() + 24.0;
            let play =
                Rect::from_min_size(Pos2::new(origin.x + pad, row_top + 4.0), Vec2::splat(56.0));
            let response = ui.interact(play, Id::new(("play-view", &self.view)), Sense::click());
            icons::round_button_at(ui, play, &response, Icon::Play, ACCENT, Color32::BLACK);
            if response.on_hover_text("Play").clicked() {
                self.play_view();
            }
            let shuffle =
                Rect::from_center_size(play.right_center() + vec2(36.0, 0.0), Vec2::splat(40.0));
            if icons::button_at(
                ui,
                shuffle,
                Id::new("view-shuffle"),
                Icon::Shuffle,
                26.0,
                self.playback.shuffle_state,
                "Shuffle",
            )
            .clicked()
            {
                self.action(PlayerAction::Shuffle(!self.playback.shuffle_state));
            }
            if self.loading {
                ui.put(
                    Rect::from_center_size(
                        shuffle.right_center() + vec2(32.0, 0.0),
                        Vec2::splat(20.0),
                    ),
                    egui::Spinner::new().color(SUBDUED),
                );
            }
        } else if self.view == "home" {
            let (columns, tile_height, card_count, card_width) = self.home_layout(width);
            let name = self
                .profile
                .as_ref()
                .and_then(|profile| profile.display_name.clone())
                .unwrap_or_default();
            ui.painter().text(
                origin + vec2(pad, 32.0),
                Align2::LEFT_TOP,
                if name.is_empty() {
                    "Welcome back".to_owned()
                } else {
                    format!("Welcome back, {name}")
                },
                theme::bold(30.0),
                TEXT,
            );
            let mut y = 88.0;
            let tile_width = (width - 32.0 - (columns - 1) as f32 * 8.0) / columns as f32;
            let mut entries: Vec<(String, String, Option<Vec<Artwork>>)> =
                vec![("liked".into(), "Liked Songs".into(), None)];
            entries.extend(self.playlists.iter().take(7).map(|playlist| {
                (
                    format!("playlist:{}", playlist.id),
                    playlist.name.clone(),
                    Some(playlist.images.clone()),
                )
            }));
            let mut open = None;
            for (index, (key, name, images)) in entries.iter().enumerate() {
                let column = index % columns;
                let row = index / columns;
                let rect = Rect::from_min_size(
                    origin
                        + vec2(
                            16.0 + column as f32 * (tile_width + 8.0),
                            y + row as f32 * (tile_height + 8.0),
                        ),
                    vec2(tile_width, tile_height),
                );
                let response = ui.interact(rect, Id::new(("tile", key)), Sense::click());
                ui.painter().rect_filled(
                    rect,
                    6.0,
                    Color32::from_white_alpha(if response.hovered() { 34 } else { 20 }),
                );
                let art = Rect::from_min_size(rect.min, Vec2::splat(tile_height));
                match images {
                    Some(images) => cover(ui, art, images, 6),
                    None => liked_cover(ui.painter(), art),
                }
                let play_space = if response.hovered() { 56.0 } else { 12.0 };
                theme::text(
                    ui,
                    Pos2::new(art.right() + 14.0, rect.center().y - 10.0),
                    name,
                    theme::bold(14.5),
                    TEXT,
                    rect.right() - art.right() - 14.0 - play_space,
                );
                if response.hovered() {
                    let play = Rect::from_center_size(
                        Pos2::new(rect.right() - 30.0, rect.center().y),
                        Vec2::splat(36.0),
                    );
                    icons::round_button_at(ui, play, &response, Icon::Play, ACCENT, Color32::BLACK);
                }
                if response.clicked() {
                    open = Some(key.clone());
                }
            }
            y += entries.len().div_ceil(columns) as f32 * (tile_height + 8.0) + 16.0;
            if card_count > 0 && !self.playlists.is_empty() {
                ui.painter().text(
                    origin + vec2(pad, y + 8.0),
                    Align2::LEFT_TOP,
                    "Your playlists",
                    theme::bold(22.0),
                    TEXT,
                );
                y += 52.0;
                for (index, playlist) in self.playlists.iter().take(card_count).enumerate() {
                    let rect = Rect::from_min_size(
                        origin + vec2(16.0 + index as f32 * (card_width + 8.0), y),
                        vec2(card_width, card_width + 66.0),
                    );
                    let response =
                        ui.interact(rect, Id::new(("card", &playlist.id)), Sense::click());
                    if response.hovered() {
                        ui.painter()
                            .rect_filled(rect, 8.0, Color32::from_white_alpha(14));
                    }
                    let art = Rect::from_min_size(
                        rect.min + vec2(10.0, 10.0),
                        Vec2::splat(card_width - 20.0),
                    );
                    cover(ui, art, &playlist.images, 6);
                    let lift =
                        ui.ctx()
                            .animate_bool_with_time(response.id, response.hovered(), 0.15);
                    if lift > 0.0 {
                        let play = Rect::from_center_size(
                            art.right_bottom() - vec2(30.0, 30.0 - (1.0 - lift) * 8.0),
                            Vec2::splat(44.0 * lift.max(0.6)),
                        );
                        ui.painter().circle_filled(
                            play.center() + vec2(0.0, 3.0),
                            23.0,
                            Color32::from_black_alpha((90.0 * lift) as u8),
                        );
                        icons::round_button_at(
                            ui,
                            play,
                            &response,
                            Icon::Play,
                            ACCENT,
                            Color32::BLACK,
                        );
                    }
                    theme::text(
                        ui,
                        Pos2::new(art.left(), art.bottom() + 10.0),
                        &playlist.name,
                        theme::bold(14.5),
                        TEXT,
                        art.width(),
                    );
                    let owner = playlist
                        .owner
                        .display_name
                        .clone()
                        .unwrap_or(playlist.owner.id.clone());
                    theme::text(
                        ui,
                        Pos2::new(art.left(), art.bottom() + 32.0),
                        &format!("By {owner}"),
                        theme::regular(13.0),
                        SUBDUED,
                        art.width(),
                    );
                    if response.clicked() {
                        open = Some(format!("playlist:{}", playlist.id));
                    }
                }
                y += card_width + 74.0;
            }
            ui.painter().text(
                origin + vec2(pad, y + 8.0),
                Align2::LEFT_TOP,
                "Recently played",
                theme::bold(22.0),
                TEXT,
            );
            if let Some(key) = open {
                self.open(key);
            }
        } else {
            let title = self.view_title();
            theme::text(
                ui,
                origin + vec2(pad, 36.0),
                &title,
                theme::bold(34.0),
                TEXT,
                width - pad * 2.0,
            );
            if self.view == "queue" {
                ui.painter().text(
                    origin + vec2(pad, 84.0),
                    Align2::LEFT_CENTER,
                    "Next up",
                    theme::regular(14.0),
                    SUBDUED,
                );
            }
        }
        // Column header.
        let columns = Columns::new(width);
        let top = origin.y + columns_top;
        let left = origin.x + 16.0;
        let color = SUBDUED;
        let font = theme::regular(13.0);
        ui.painter().text(
            Pos2::new(left + 22.0, top + 20.0),
            Align2::CENTER_CENTER,
            "#",
            font.clone(),
            color,
        );
        ui.painter().text(
            Pos2::new(left + columns.title, top + 20.0),
            Align2::LEFT_CENTER,
            "Title",
            font.clone(),
            color,
        );
        if columns.album > 0.0 {
            ui.painter().text(
                Pos2::new(left + columns.album, top + 20.0),
                Align2::LEFT_CENTER,
                "Album",
                font,
                color,
            );
        }
        icons::paint(
            ui.painter(),
            Rect::from_center_size(
                Pos2::new(left + columns.width - 40.0, top + 20.0),
                Vec2::splat(16.0),
            ),
            Icon::Clock,
            color,
        );
        ui.painter().hline(
            (origin.x + 16.0)..=(origin.x + width - 16.0),
            top + 39.5,
            Stroke::new(1.0_f32, Color32::from_white_alpha(22)),
        );
    }

    fn track_row(
        &self,
        ui: &mut Ui,
        rect: Rect,
        index: usize,
        columns: &Columns,
        actions: &mut Vec<RowAction>,
    ) {
        let Some(track) = self.tracks.get(index) else {
            return;
        };
        let response = ui.interact(rect, Id::new(("row", &self.view, index)), Sense::click());
        // Geometric hover: child buttons on the row must not cancel its hover
        // state, or they flicker away under the pointer.
        let hovered = ui.rect_contains_pointer(rect);
        let selected = self.selected.contains(&index);
        let current = self.is_current(track);
        if selected || hovered {
            ui.painter().rect_filled(
                rect,
                6.0,
                Color32::from_white_alpha(if selected { 30 } else { 12 }),
            );
        }
        let mid = rect.center().y;
        let number = Rect::from_center_size(Pos2::new(rect.left() + 22.0, mid), Vec2::splat(28.0));
        if hovered {
            let play = ui.interact(
                number,
                Id::new(("row-play", &self.view, index)),
                Sense::click(),
            );
            let icon = if current && self.playback.is_playing {
                Icon::Pause
            } else {
                Icon::Play
            };
            icons::paint(ui.painter(), number.shrink(7.0), icon, TEXT);
            if play.clicked() {
                if current && self.playback.is_playing {
                    self.action(PlayerAction::Pause);
                } else {
                    actions.push(RowAction::Play(index));
                }
            }
        } else if current && self.playback.is_playing {
            equalizer(
                ui.painter(),
                number.shrink(8.0),
                ui.input(|input| input.time) as f32,
            );
            ui.ctx().request_repaint_after(Duration::from_millis(60));
        } else {
            ui.painter().text(
                number.center(),
                Align2::CENTER_CENTER,
                (index + 1).to_string(),
                theme::regular(15.0),
                if current { ACCENT } else { SUBDUED },
            );
        }
        let art = Rect::from_min_size(
            Pos2::new(rect.left() + columns.title, mid - 20.0),
            Vec2::splat(40.0),
        );
        cover(ui, art, &track.album.images, 4);
        let text_left = art.right() + 12.0;
        let text_width = (rect.left() + columns.title_end - text_left - 8.0).max(40.0);
        theme::text(
            ui,
            Pos2::new(text_left, mid - 19.0),
            &track.name,
            theme::regular(15.5),
            if current { ACCENT } else { TEXT },
            text_width,
        );
        theme::text(
            ui,
            Pos2::new(text_left, mid + 2.0),
            &track.artist(),
            theme::regular(13.5),
            if hovered || selected { TEXT } else { SUBDUED },
            text_width,
        );
        if columns.album > 0.0 {
            theme::text(
                ui,
                Pos2::new(rect.left() + columns.album, mid - 9.0),
                &track.album.name,
                theme::regular(13.5),
                if hovered || selected { TEXT } else { SUBDUED },
                columns.width - columns.album - 110.0,
            );
        }
        if hovered && track.addable() {
            let save =
                Rect::from_center_size(Pos2::new(rect.right() - 92.0, mid), Vec2::splat(28.0));
            if icons::button_at(
                ui,
                save,
                Id::new(("row-save", &self.view, index)),
                Icon::Plus,
                14.0,
                false,
                "Save to Liked Songs",
            )
            .clicked()
            {
                actions.push(RowAction::Save(index));
            }
        }
        ui.painter().text(
            Pos2::new(rect.right() - 24.0, mid),
            Align2::RIGHT_CENTER,
            theme::time_text(track.duration_ms),
            theme::regular(13.5),
            SUBDUED,
        );
        if response.double_clicked() {
            actions.push(RowAction::Play(index));
        } else if response.clicked() {
            actions.push(RowAction::Select(index, ui.input(|input| input.modifiers)));
        }
        let many = selected && self.selected.len() > 1;
        response.context_menu(|ui| {
            ui.set_min_width(220.0);
            if ui.button("Play").clicked() {
                actions.push(RowAction::Play(index));
                ui.close();
            }
            if ui
                .button(if many {
                    format!("Add {} songs to playlist…", self.selected.len())
                } else {
                    "Add to playlist…".into()
                })
                .clicked()
            {
                actions.push(RowAction::Pick(index));
                ui.close();
            }
            if ui.button("Add to queue").clicked() {
                actions.push(RowAction::Enqueue(index));
                ui.close();
            }
            if ui.button("Save to Liked Songs").clicked() {
                actions.push(RowAction::Save(index));
                ui.close();
            }
            ui.separator();
            if ui.button("Copy song and artist").clicked() {
                ui.ctx()
                    .copy_text(format!("{} - {}", track.name, track.artist()));
                ui.close();
            }
            if ui.button("Copy ID").clicked() {
                ui.ctx().copy_text(track.id.clone().unwrap_or_default());
                ui.close();
            }
            if ui.button("Copy clean link").clicked() {
                if let Some(id) = &track.id {
                    ui.ctx()
                        .copy_text(format!("https://open.spotify.com/track/{id}"));
                }
                ui.close();
            }
        });
    }

    fn selection_bar(&mut self, ui: &mut Ui, panel: Rect) {
        if self.selected.is_empty() {
            return;
        }
        egui::Area::new(Id::new("selection-bar"))
            .order(egui::Order::Foreground)
            .pivot(Align2::CENTER_BOTTOM)
            .fixed_pos(panel.center_bottom() - vec2(0.0, 20.0))
            .show(ui.ctx(), |ui| {
                egui::Frame::new()
                    .fill(HIGHLIGHT)
                    .corner_radius(24)
                    .inner_margin(vec2(18.0, 8.0))
                    .shadow(egui::Shadow {
                        offset: [0, 6],
                        blur: 24,
                        spread: 0,
                        color: Color32::from_black_alpha(140),
                    })
                    .show(ui, |ui| {
                        ui.horizontal(|ui| {
                            ui.label(
                                RichText::new(format!("{} selected", self.selected.len()))
                                    .font(theme::bold(14.0)),
                            );
                            ui.add_space(8.0);
                            if ui.add(primary("Add to playlist")).clicked() {
                                self.picker = Some(self.selected_tracks());
                            }
                            if ui.button("Copy IDs").clicked() {
                                let ids = self
                                    .selected_tracks()
                                    .iter()
                                    .filter_map(|track| track.id.clone())
                                    .collect::<Vec<_>>()
                                    .join(", ");
                                ui.ctx().copy_text(ids);
                                self.show_notice("Copied track IDs".into(), false);
                            }
                            if icons::button(ui, Icon::Close, 14.0, false, "Clear selection")
                                .clicked()
                            {
                                self.selected.clear();
                            }
                        });
                    });
            });
    }

    // ---------------------------------------------------------------- player

    fn player(&mut self, context: &egui::Context, width: f32) {
        egui::TopBottomPanel::bottom("player")
            .exact_height(PLAYER_HEIGHT)
            .show_separator_line(false)
            .frame(egui::Frame::new().fill(BASE).inner_margin(vec2(8.0, 8.0)))
            .show(context, |ui| {
                let full = ui.max_rect();
                let side = (width * 0.3).clamp(170.0, 400.0);
                let left =
                    Rect::from_min_max(full.min, Pos2::new(full.left() + side, full.bottom()));
                let right =
                    Rect::from_min_max(Pos2::new(full.right() - side, full.top()), full.max);
                let center = Rect::from_min_max(
                    Pos2::new(left.right() + 8.0, full.top()),
                    Pos2::new(right.left() - 8.0, full.bottom()),
                );
                self.player_track(ui, left);
                self.player_controls(ui, center);
                self.player_extras(ui, right);
            });
    }

    fn player_track(&mut self, ui: &mut Ui, rect: Rect) {
        let mid = rect.center().y;
        let Some(track) = self.playback.item.clone() else {
            ui.painter().text(
                Pos2::new(rect.left() + 8.0, mid),
                Align2::LEFT_CENTER,
                if self.profile.is_some() {
                    "Choose something to play"
                } else {
                    ""
                },
                theme::regular(14.0),
                SUBDUED,
            );
            return;
        };
        let art = Rect::from_min_size(Pos2::new(rect.left() + 8.0, mid - 28.0), Vec2::splat(56.0));
        let response = ui.interact(art, Id::new("player-art"), Sense::click());
        cover(ui, art, &track.album.images, 4);
        if response.hovered() {
            ui.painter()
                .rect_filled(art, 4.0, Color32::from_black_alpha(100));
            icons::paint(ui.painter(), art.shrink(18.0), Icon::Lyrics, TEXT);
        }
        if response.on_hover_text("Lyrics").clicked() {
            self.toggle_lyrics_page();
        }
        let text_left = art.right() + 14.0;
        let max_width = (rect.right() - text_left - 44.0).max(40.0);
        let title = theme::line(ui, &track.name, theme::regular(14.5), TEXT, max_width);
        let artist = theme::line(
            ui,
            &track.artist(),
            theme::regular(12.5),
            SUBDUED,
            max_width,
        );
        let text_width = title.size().x.max(artist.size().x);
        emoji::paint_galley(ui.painter(), Pos2::new(text_left, mid - 20.0), title, TEXT);
        emoji::paint_galley(
            ui.painter(),
            Pos2::new(text_left, mid + 2.0),
            artist,
            SUBDUED,
        );
        if track.addable() {
            let save = Rect::from_center_size(
                Pos2::new(text_left + text_width + 22.0, mid),
                Vec2::splat(28.0),
            );
            if icons::button_at(
                ui,
                save,
                Id::new("player-save"),
                Icon::Plus,
                15.0,
                false,
                "Save to Liked Songs",
            )
            .clicked()
            {
                self.send(Command::SaveTrack(track.uri.clone()));
            }
        }
    }

    fn player_controls(&mut self, ui: &mut Ui, rect: Rect) {
        let enabled = self.profile.is_some();
        let cx = rect.center().x;
        let cy = rect.top() + 22.0;
        let play = Rect::from_center_size(Pos2::new(cx, cy), Vec2::splat(36.0));
        let response = ui.interact(play, Id::new("player-play"), Sense::click());
        icons::round_button_at(
            ui,
            play,
            &response,
            if self.playback.is_playing {
                Icon::Pause
            } else {
                Icon::Play
            },
            if enabled { ACCENT } else { FAINT },
            Color32::BLACK,
        );
        if response.on_hover_text("Play / pause · Space").clicked() && enabled {
            self.toggle_play();
        }
        let repeat_icon = if self.playback.repeat_state == "track" {
            Icon::RepeatOne
        } else {
            Icon::Repeat
        };
        let buttons = [
            (-96.0, Icon::Shuffle, self.playback.shuffle_state, "Shuffle"),
            (-52.0, Icon::Previous, false, "Previous"),
            (52.0, Icon::Next, false, "Next"),
            (
                96.0,
                repeat_icon,
                self.playback.repeat_state != "off" && !self.playback.repeat_state.is_empty(),
                "Repeat",
            ),
        ];
        for (offset, icon, active, tip) in buttons {
            let button = Rect::from_center_size(Pos2::new(cx + offset, cy), Vec2::splat(32.0));
            if icons::button_at(
                ui,
                button,
                Id::new(("transport", tip)),
                icon,
                17.0,
                active,
                tip,
            )
            .clicked()
                && enabled
            {
                match icon {
                    Icon::Shuffle => {
                        self.action(PlayerAction::Shuffle(!self.playback.shuffle_state))
                    }
                    Icon::Previous => self.action(PlayerAction::Previous),
                    Icon::Next => self.action(PlayerAction::Next),
                    _ => self.action(PlayerAction::Repeat(
                        match self.playback.repeat_state.as_str() {
                            "off" | "" => "context",
                            "context" => "track",
                            _ => "off",
                        }
                        .into(),
                    )),
                }
            }
        }
        let duration = self
            .playback
            .item
            .as_ref()
            .map_or(0, |track| track.duration_ms);
        let bar_width = (rect.width() - 110.0).clamp(80.0, 640.0);
        let y = rect.top() + 56.0;
        let bar_rect = Rect::from_center_size(Pos2::new(cx, y), vec2(bar_width, 12.0));
        let fraction = self.position() as f32 / duration.max(1) as f32;
        let output = bar(ui, bar_rect, Id::new("seek"), fraction);
        if let Some(released) = output.released
            && duration > 0
            && enabled
        {
            let target = (released * duration as f32) as u64;
            self.action(PlayerAction::Seek(target));
            self.playback.progress_ms = Some(target);
            self.observed = Instant::now();
        }
        let shown = (output.shown * duration as f32) as u64;
        let font = theme::regular(12.0);
        ui.painter().text(
            Pos2::new(bar_rect.left() - 10.0, y),
            Align2::RIGHT_CENTER,
            theme::time_text(shown),
            font.clone(),
            SUBDUED,
        );
        ui.painter().text(
            Pos2::new(bar_rect.right() + 10.0, y),
            Align2::LEFT_CENTER,
            theme::time_text(duration),
            font,
            SUBDUED,
        );
    }

    fn player_extras(&mut self, ui: &mut Ui, rect: Rect) {
        let mid = rect.center().y;
        let mut x = rect.right() - 20.0;
        let mut slot = |width: f32| {
            let slot = Rect::from_center_size(Pos2::new(x - width / 2.0, mid), vec2(width, 32.0));
            x -= width + 4.0;
            slot
        };
        let roomy = rect.width() >= 300.0;
        let full_icon = if self.immersive {
            Icon::ExitFullscreen
        } else {
            Icon::Fullscreen
        };
        if icons::button_at(
            ui,
            slot(32.0),
            Id::new(("player", "immersive")),
            full_icon,
            16.0,
            false,
            "Full screen lyrics",
        )
        .clicked()
        {
            let entering = !self.immersive;
            self.set_immersive(entering);
            if entering {
                self.show_lyrics_page();
            }
        }
        let volume = self.playback.device.volume_percent.unwrap_or(50);
        if roomy {
            let bar_rect = slot(96.0).shrink2(vec2(4.0, 10.0));
            let output = bar(
                ui,
                bar_rect,
                Id::new(("player", "volume")),
                volume as f32 / 100.0,
            );
            if let Some(released) = output.released {
                let value = (released * 100.0).round() as u8;
                self.action(PlayerAction::Volume(value));
                self.playback.device.volume_percent = Some(value);
                self.muted_from = None;
            }
        }
        let volume_icon = if volume == 0 {
            Icon::Volume(0)
        } else {
            Icon::Volume(volume)
        };
        if icons::button_at(
            ui,
            slot(32.0),
            Id::new(("player", "mute")),
            volume_icon,
            17.0,
            false,
            if volume == 0 { "Unmute" } else { "Mute" },
        )
        .clicked()
        {
            let value = if volume == 0 {
                self.muted_from.take().unwrap_or(50)
            } else {
                self.muted_from = Some(volume);
                0
            };
            self.action(PlayerAction::Volume(value));
            self.playback.device.volume_percent = Some(value);
        }
        let devices_rect = slot(32.0);
        let remote = self.playback.device.id.is_some() && self.playback.device.id != self.native_id;
        let devices = icons::button_at(
            ui,
            devices_rect,
            Id::new(("player", "devices")),
            Icon::Devices,
            17.0,
            remote,
            "Connect to a device",
        );
        if devices.clicked() && self.profile.is_some() {
            self.send(Command::Refresh);
        }
        self.devices_popup(&devices);
        if rect.width() >= 230.0 {
            if icons::button_at(
                ui,
                slot(32.0),
                Id::new(("player", "queue")),
                Icon::Queue,
                17.0,
                self.view == "queue" && self.center == Center::Browse,
                "Queue",
            )
            .clicked()
            {
                self.open("queue".into());
            }
            if icons::button_at(
                ui,
                slot(32.0),
                Id::new(("player", "now-playing")),
                Icon::NowPlaying,
                17.0,
                self.settings.show_lyrics,
                "Now playing view",
            )
            .clicked()
            {
                self.settings.show_lyrics = !self.settings.show_lyrics;
                self.dirty = true;
                if self.settings.show_lyrics && self.lyrics.is_none() {
                    self.fetch_lyrics();
                }
                self.save_settings();
            }
        }
        if icons::button_at(
            ui,
            slot(32.0),
            Id::new(("player", "lyrics")),
            Icon::Lyrics,
            17.0,
            self.center == Center::Lyrics,
            "Lyrics",
        )
        .clicked()
        {
            self.toggle_lyrics_page();
        }
    }

    fn show_lyrics_page(&mut self) {
        self.center = Center::Lyrics;
        self.page_lyrics.resume();
        if self.lyrics.is_none() && !self.lyric_loading {
            self.fetch_lyrics();
        }
    }

    fn toggle_lyrics_page(&mut self) {
        if self.center == Center::Lyrics {
            self.leave_page();
        } else {
            self.show_lyrics_page();
        }
    }

    fn devices_popup(&mut self, anchor: &egui::Response) {
        egui::Popup::from_toggle_button_response(anchor)
            .align(egui::RectAlign::TOP_END)
            .gap(12.0)
            .width(300.0)
            .frame(popover_frame())
            .show(|ui| {
                ui.set_min_width(280.0);
                ui.label(RichText::new("Connect to a device").font(theme::bold(18.0)));
                ui.add_space(6.0);
                let mut transfer = None;
                let current = self.playback.device.id.clone();
                if let Some(id) = self.native_id.clone() {
                    if device_row(
                        ui,
                        "This computer",
                        "SpotiFlex",
                        current.as_ref() == Some(&id),
                    )
                    .clicked()
                    {
                        transfer = Some(id);
                    }
                } else {
                    ui.label(RichText::new(&self.native_status).small().color(SUBDUED));
                }
                for device in &self.devices {
                    let Some(id) = device.id.clone() else {
                        continue;
                    };
                    if self.native_id.as_ref() == Some(&id) {
                        continue;
                    }
                    if device_row(ui, &device.name, "Spotify Connect", device.is_active).clicked() {
                        transfer = Some(id);
                    }
                }
                ui.add_space(4.0);
                if ui.button("Refresh devices").clicked() && self.profile.is_some() {
                    self.send(Command::Refresh);
                }
                if let Some(id) = transfer {
                    self.selected_device = Some(id.clone());
                    self.action(PlayerAction::Transfer(id));
                    ui.close();
                }
            });
    }

    // ---------------------------------------------------------------- lyrics

    fn lyrics_page(&mut self, ui: &mut Ui) {
        let rect = ui.max_rect();
        let time = if self.settings.reduce_motion {
            0.0
        } else {
            ui.input(|input| input.time) as f32
        };
        let url = self
            .playback
            .item
            .as_ref()
            .and_then(|track| art::pick(&track.album.images, 640.0))
            .map(str::to_owned);
        let context = ui.ctx().clone();
        let art = url.as_deref().and_then(|url| self.art.get(&context, url));
        art::paint_background(ui.painter(), rect, art, time);
        if !self.immersive {
            theme::mask_corners(ui.painter(), rect, RADIUS as f32, BASE);
        }

        // Top-right controls.
        let mut x = rect.right() - 28.0;
        let top = rect.top() + 28.0;
        let close = Rect::from_center_size(Pos2::new(x, top), Vec2::splat(34.0));
        if icons::button_at(
            ui,
            close,
            Id::new("lyrics-close"),
            Icon::Close,
            15.0,
            false,
            "Close lyrics · Esc",
        )
        .clicked()
        {
            self.leave_page();
            return;
        }
        x -= 40.0;
        let full_icon = if self.immersive {
            Icon::ExitFullscreen
        } else {
            Icon::Fullscreen
        };
        let full = Rect::from_center_size(Pos2::new(x, top), Vec2::splat(34.0));
        if icons::button_at(
            ui,
            full,
            Id::new("lyrics-full"),
            full_icon,
            16.0,
            false,
            "Full screen",
        )
        .clicked()
        {
            let immersive = !self.immersive;
            self.set_immersive(immersive);
        }
        x -= 40.0;
        let more = Rect::from_center_size(Pos2::new(x, top), Vec2::splat(34.0));
        let more_response = icons::button_at(
            ui,
            more,
            Id::new("lyrics-more"),
            Icon::More,
            18.0,
            false,
            "Lyrics options",
        );
        self.lyrics_menu(&more_response);

        let Some(track) = self.playback.item.clone() else {
            lyrics_view::message(
                ui,
                rect,
                "Nothing playing",
                "Play a song to see its lyrics here",
            );
            return;
        };
        let wide = rect.width() >= 720.0 && rect.height() >= 420.0;
        let lyrics_rect = if wide {
            let column = rect.width() * 0.4;
            let art_size = (column * 0.72).min(rect.height() * 0.55).min(480.0);
            let art_rect = Rect::from_center_size(
                Pos2::new(rect.left() + column * 0.55, rect.center().y - 40.0),
                Vec2::splat(art_size),
            );
            ui.painter().rect_filled(
                art_rect.translate(vec2(0.0, 14.0)).expand(6.0),
                14.0,
                Color32::from_black_alpha(60),
            );
            cover(ui, art_rect, &track.album.images, 10);
            let title_width = (column * 0.9).max(art_size);
            let title = theme::line(ui, &track.name, theme::bold(28.0), TEXT, title_width);
            let title_pos = Pos2::new(
                art_rect.center().x - title.size().x / 2.0,
                art_rect.bottom() + 26.0,
            );
            emoji::paint_galley(ui.painter(), title_pos, title.clone(), TEXT);
            let subtitle = theme::line(
                ui,
                &format!("{}  ·  {}", track.artist(), track.album.name),
                theme::regular(16.0),
                Color32::from_white_alpha(190),
                title_width,
            );
            emoji::paint_galley(
                ui.painter(),
                Pos2::new(
                    art_rect.center().x - subtitle.size().x / 2.0,
                    title_pos.y + title.size().y + 8.0,
                ),
                subtitle,
                TEXT,
            );
            Rect::from_min_max(
                Pos2::new(rect.left() + column + 16.0, rect.top() + 56.0),
                Pos2::new(rect.right() - 40.0, rect.bottom() - 52.0),
            )
        } else {
            let art_rect = Rect::from_min_size(rect.min + vec2(24.0, 18.0), Vec2::splat(52.0));
            cover(ui, art_rect, &track.album.images, 6);
            let width = (x - art_rect.right() - 40.0).max(60.0);
            theme::text(
                ui,
                Pos2::new(art_rect.right() + 14.0, art_rect.top() + 4.0),
                &track.name,
                theme::bold(18.0),
                TEXT,
                width,
            );
            theme::text(
                ui,
                Pos2::new(art_rect.right() + 14.0, art_rect.top() + 28.0),
                &track.artist(),
                theme::regular(14.0),
                Color32::from_white_alpha(190),
                width,
            );
            Rect::from_min_max(
                Pos2::new(rect.left() + 16.0, rect.top() + 88.0),
                Pos2::new(rect.right() - 16.0, rect.bottom() - 48.0),
            )
        };
        let size = self.settings.lyric_size * (lyrics_rect.width() / 760.0).clamp(0.8, 1.4);
        let style = lyrics_view::Style {
            size,
            reduce_motion: self.settings.reduce_motion,
            romanized: self.settings.romanized,
            blur: true,
        };
        let position = self.lyric_position();
        let mut seek = None;
        match &self.lyrics {
            Some(lyrics) if lyrics.instrumental => {
                lyrics_view::message(ui, lyrics_rect, "♪  Instrumental", "Enjoy the music");
            }
            Some(lyrics) if !lyrics.lines.is_empty() => {
                seek = self
                    .page_lyrics
                    .show(ui, lyrics_rect, lyrics, position, &style);
                let credit = format!("Lyrics provided by: {}", lyrics.source);
                ui.painter().text(
                    Pos2::new(lyrics_rect.left() + 8.0, rect.bottom() - 24.0),
                    Align2::LEFT_CENTER,
                    credit,
                    theme::regular(13.0),
                    Color32::from_white_alpha(150),
                );
            }
            _ if self.lyric_loading => {
                lyrics_view::message(ui, lyrics_rect, "Finding lyrics…", "");
            }
            _ => {
                let detail = if self.lyric_error.is_empty() {
                    "Use the ⋯ menu to retry or import an .lrc or .ttml file".to_owned()
                } else {
                    self.lyric_error.clone()
                };
                lyrics_view::message(ui, lyrics_rect, "Lyrics unavailable", &detail);
            }
        }
        if !self.page_lyrics.following() && self.lyrics.is_some() {
            let pill = Rect::from_center_size(
                Pos2::new(lyrics_rect.center().x, lyrics_rect.bottom() - 10.0),
                vec2(148.0, 36.0),
            );
            let response = ui.interact(pill, Id::new("lyrics-resume"), Sense::click());
            ui.painter().rect_filled(
                pill,
                18.0,
                Color32::from_white_alpha(if response.hovered() { 255 } else { 230 }),
            );
            ui.painter().text(
                pill.center(),
                Align2::CENTER_CENTER,
                "Back to current",
                theme::bold(14.0),
                Color32::BLACK,
            );
            if response.clicked() {
                self.page_lyrics.resume();
            }
        }
        if let Some(position) = seek {
            self.seek_lyrics(position);
        }
    }

    fn seek_lyrics(&mut self, position: u64) {
        let target = position.saturating_add_signed(-self.settings.lyric_offset_ms);
        self.action(PlayerAction::Seek(target));
        self.playback.progress_ms = Some(target);
        self.observed = Instant::now();
    }

    fn lyrics_menu(&mut self, anchor: &egui::Response) {
        egui::Popup::from_toggle_button_response(anchor)
            .align(egui::RectAlign::BOTTOM_END)
            .gap(6.0)
            .width(300.0)
            .frame(popover_frame())
            .close_behavior(egui::PopupCloseBehavior::CloseOnClickOutside)
            .show(|ui| {
                ui.set_min_width(280.0);
                if ui.button("Refresh lyrics").clicked() {
                    self.fetch_lyrics();
                    ui.close();
                }
                ui.add_space(4.0);
                ui.label(RichText::new("Timing offset").color(SUBDUED).size(13.0));
                ui.horizontal(|ui| {
                    if ui.button("−100 ms").clicked() {
                        self.settings.lyric_offset_ms -= 100;
                        self.dirty = true;
                    }
                    ui.label(format!("{:+} ms", self.settings.lyric_offset_ms));
                    if ui.button("+100 ms").clicked() {
                        self.settings.lyric_offset_ms += 100;
                        self.dirty = true;
                    }
                });
                let mut size = self.settings.lyric_size;
                if ui
                    .add(
                        egui::Slider::new(&mut size, 18.0..=60.0)
                            .text("Size")
                            .show_value(false),
                    )
                    .changed()
                {
                    self.settings.lyric_size = size;
                    self.dirty = true;
                }
                if ui
                    .checkbox(&mut self.settings.romanized, "Show romanization")
                    .changed()
                {
                    self.dirty = true;
                }
                ui.separator();
                ui.label(
                    RichText::new("Import local lyrics")
                        .color(SUBDUED)
                        .size(13.0),
                );
                ui.add(
                    egui::TextEdit::singleline(&mut self.import_path)
                        .hint_text("Path to .lrc or .ttml file")
                        .desired_width(f32::INFINITY),
                );
                ui.label(
                    RichText::new(
                        "Or drop a file onto the window. It stays attached to this song.",
                    )
                    .size(12.0)
                    .color(SUBDUED),
                );
                if ui.button("Import for this track").clicked() {
                    let path = PathBuf::from(self.import_path.trim().trim_matches('"'));
                    self.import_lyrics(path);
                    ui.close();
                }
                let imported = self
                    .lyrics
                    .as_ref()
                    .is_some_and(|lyrics| lyrics.source.starts_with("Local"));
                if imported && ui.button("Remove imported lyrics").clicked() {
                    self.forget_lyrics();
                    ui.close();
                }
            });
        if !anchor.ctx.is_popup_open() {
            self.save_settings();
        }
    }

    fn now_playing(&mut self, context: &egui::Context) {
        egui::SidePanel::right("now-playing")
            .resizable(true)
            .default_width(340.0)
            .width_range(280.0..=460.0)
            .show_separator_line(false)
            .frame(
                egui::Frame::new()
                    .fill(SURFACE)
                    .corner_radius(RADIUS)
                    .outer_margin(egui::Margin {
                        left: 4,
                        right: 8,
                        top: 0,
                        bottom: 0,
                    }),
            )
            .show(context, |ui| {
                let panel = ui.max_rect();
                let url = self
                    .playback
                    .item
                    .as_ref()
                    .and_then(|track| art::pick(&track.album.images, 300.0))
                    .map(str::to_owned);
                let accent = self
                    .art
                    .accent(ui.ctx(), url.as_deref())
                    .unwrap_or(HIGHLIGHT);
                theme::vertical_gradient(
                    ui.painter(),
                    Rect::from_min_size(panel.min, vec2(panel.width(), 360.0)),
                    theme::lerp_color(accent, SURFACE, 0.35),
                    SURFACE,
                );
                theme::mask_corners(ui.painter(), panel, RADIUS as f32, BASE);
                egui::ScrollArea::vertical()
                    .id_salt("now-playing-scroll")
                    .auto_shrink(false)
                    .show(ui, |ui| {
                        egui::Frame::new().inner_margin(16).show(ui, |ui| {
                            self.now_playing_contents(ui, accent);
                        });
                    });
            });
    }

    fn now_playing_contents(&mut self, ui: &mut Ui, accent: Color32) {
        let width = ui.available_width();
        ui.horizontal(|ui| {
            let title = if self.view == "home"
                || self.view == "queue"
                || self.view.starts_with("search:")
            {
                "Now playing".to_owned()
            } else {
                self.view_title()
            };
            ui.add(
                egui::Label::new(RichText::new(title).font(theme::bold(16.0)).color(TEXT))
                    .truncate(),
            );
            ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                if icons::button(ui, Icon::Close, 13.0, false, "Hide Now playing view").clicked() {
                    self.settings.show_lyrics = false;
                    self.dirty = true;
                    self.save_settings();
                }
            });
        });
        ui.add_space(10.0);
        let Some(track) = self.playback.item.clone() else {
            ui.add_space(40.0);
            ui.vertical_centered(|ui| {
                ui.label(RichText::new("Nothing playing").font(theme::bold(18.0)));
                ui.label(RichText::new("Pick a song and it will show up here.").color(SUBDUED));
            });
            return;
        };
        let (art_rect, response) = ui.allocate_exact_size(Vec2::splat(width), Sense::click());
        cover(ui, art_rect, &track.album.images, 8);
        if response.on_hover_text("Open lyrics").clicked() {
            self.show_lyrics_page();
        }
        ui.add_space(8.0);
        ui.horizontal(|ui| {
            ui.vertical(|ui| {
                ui.set_width(width - 44.0);
                ui.add(
                    egui::Label::new(
                        RichText::new(&track.name)
                            .font(theme::bold(22.0))
                            .color(TEXT),
                    )
                    .truncate(),
                );
                ui.add(
                    egui::Label::new(RichText::new(track.artist()).size(15.0).color(SUBDUED))
                        .truncate(),
                );
            });
            if track.addable()
                && icons::button(ui, Icon::Plus, 16.0, false, "Save to Liked Songs").clicked()
            {
                self.send(Command::SaveTrack(track.uri.clone()));
            }
        });
        ui.add_space(12.0);
        if self.center != Center::Lyrics {
            let card_height = 380.0;
            let (card, _) = ui.allocate_exact_size(vec2(width, card_height), Sense::hover());
            ui.painter()
                .rect_filled(card, 10.0, theme::lerp_color(accent, Color32::BLACK, 0.25));
            ui.painter().text(
                card.min + vec2(16.0, 16.0),
                Align2::LEFT_TOP,
                "Lyrics",
                theme::bold(16.0),
                TEXT,
            );
            let expand =
                Rect::from_center_size(card.right_top() + vec2(-26.0, 26.0), Vec2::splat(30.0));
            if icons::button_at(
                ui,
                expand,
                Id::new("panel-lyrics-open"),
                Icon::Fullscreen,
                14.0,
                false,
                "Open lyrics",
            )
            .clicked()
            {
                self.show_lyrics_page();
            }
            let inner = Rect::from_min_max(card.min + vec2(4.0, 48.0), card.max - vec2(4.0, 12.0));
            let style = lyrics_view::Style {
                size: 21.0,
                reduce_motion: self.settings.reduce_motion,
                romanized: self.settings.romanized,
                blur: false,
            };
            let position = self.lyric_position();
            let mut seek = None;
            match &self.lyrics {
                Some(lyrics) if lyrics.instrumental => {
                    small_message(ui, inner, "Instrumental");
                }
                Some(lyrics) if !lyrics.lines.is_empty() => {
                    seek = self.panel_lyrics.show(ui, inner, lyrics, position, &style);
                    if !self.panel_lyrics.following() {
                        let pill = Rect::from_center_size(
                            inner.center_bottom() - vec2(0.0, 18.0),
                            vec2(120.0, 30.0),
                        );
                        let response = ui.interact(pill, Id::new("panel-resume"), Sense::click());
                        ui.painter().rect_filled(pill, 15.0, TEXT);
                        ui.painter().text(
                            pill.center(),
                            Align2::CENTER_CENTER,
                            "Back to current",
                            theme::bold(12.5),
                            Color32::BLACK,
                        );
                        if response.clicked() {
                            self.panel_lyrics.resume();
                        }
                    }
                }
                _ if self.lyric_loading => small_message(ui, inner, "Finding lyrics…"),
                _ => small_message(ui, inner, "Lyrics unavailable for this song"),
            }
            if let Some(position) = seek {
                self.seek_lyrics(position);
            }
            ui.add_space(12.0);
        }
        egui::Frame::new()
            .fill(ELEVATED)
            .corner_radius(10)
            .inner_margin(16)
            .show(ui, |ui| {
                ui.set_width(width - 32.0);
                ui.label(RichText::new("About this song").font(theme::bold(16.0)));
                ui.add_space(4.0);
                ui.label(RichText::new(format!("Album · {}", track.album.name)).color(SUBDUED));
                ui.label(
                    RichText::new(format!("Length · {}", theme::time_text(track.duration_ms)))
                        .color(SUBDUED),
                );
            });
        ui.add_space(12.0);
        egui::Frame::new()
            .fill(ELEVATED)
            .corner_radius(10)
            .inner_margin(16)
            .show(ui, |ui| {
                ui.set_width(width - 32.0);
                ui.horizontal(|ui| {
                    let (rect, _) = ui.allocate_exact_size(Vec2::splat(24.0), Sense::hover());
                    icons::paint(ui.painter(), rect, Icon::Devices, ACCENT);
                    ui.vertical(|ui| {
                        ui.label(RichText::new("Playing on").size(12.5).color(SUBDUED));
                        let name = if self.playback.device.id.is_some()
                            && self.playback.device.id == self.native_id
                        {
                            "This computer".to_owned()
                        } else if self.playback.device.name.is_empty() {
                            "No active device".to_owned()
                        } else {
                            self.playback.device.name.clone()
                        };
                        ui.label(RichText::new(name).font(theme::bold(14.5)).color(ACCENT));
                    });
                });
            });
    }

    // ---------------------------------------------------------------- settings

    fn settings_page(&mut self, ui: &mut Ui) {
        let width = ui.available_width();
        let column = (width - 48.0).min(760.0);
        egui::ScrollArea::vertical()
            .id_salt("settings-scroll")
            .auto_shrink(false)
            .show(ui, |ui| {
                ui.add_space(32.0);
                ui.horizontal(|ui| {
                    ui.add_space(((width - column) / 2.0).max(24.0));
                    ui.vertical(|ui| {
                        ui.set_width(column);
                        self.settings_contents(ui);
                    });
                });
                ui.add_space(48.0);
            });
    }

    fn settings_contents(&mut self, ui: &mut Ui) {
        ui.horizontal(|ui| {
            ui.label(
                RichText::new("Settings")
                    .font(theme::bold(32.0))
                    .color(TEXT),
            );
            ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                if icons::button(ui, Icon::Close, 15.0, false, "Close settings").clicked() {
                    self.leave_page();
                }
                if self.dirty && !self.config_damaged && ui.add(primary("Save")).clicked() {
                    self.save_settings();
                }
            });
        });
        if self.config_damaged {
            ui.label(
                RichText::new("Settings file is damaged. It has been preserved; repair it before saving new settings.")
                    .color(ERROR),
            );
        }
        ui.add_space(12.0);

        card(ui, "Lyrics", |ui| {
            self.dirty |= ui
                .add(
                    egui::Slider::new(&mut self.settings.lyric_size, 18.0..=60.0).text("Text size"),
                )
                .changed();
            self.dirty |= ui
                .add(
                    egui::Slider::new(&mut self.settings.lyric_offset_ms, -10_000..=10_000)
                        .text("Timing offset (ms)"),
                )
                .changed();
            self.dirty |= toggle(
                ui,
                &mut self.settings.romanized,
                "Show supplied romanization",
            )
            .changed();
            self.dirty |= toggle(
                ui,
                &mut self.settings.reduce_motion,
                "Reduce motion (static background, no blur)",
            )
            .changed();
        });
        card(ui, "Layout", |ui| {
            self.dirty |=
                toggle(ui, &mut self.settings.show_lyrics, "Show Now playing view").changed();
            self.dirty |= toggle(
                ui,
                &mut self.settings.compact_library,
                "Compact library rows",
            )
            .changed();
        });
        card(ui, "Lyrics provider", |ui| {
            ui.label(
                RichText::new(if self.provider_configured {
                    "Private provider configured in the operating system credential store."
                } else {
                    "Configure a private lyrics provider, or import local lyric files."
                })
                .color(SUBDUED),
            );
            ui.add(
                egui::TextEdit::singleline(&mut self.provider_input)
                    .password(true)
                    .hint_text("HTTPS provider host")
                    .desired_width(f32::INFINITY)
                    .margin(vec2(12.0, 8.0)),
            );
            ui.checkbox(
                &mut self.provider_consent,
                "Allow Spotify access token to this host",
            );
            ui.label(
                RichText::new("Only short-lived access tokens are shared. Refresh tokens stay local. Changing the host requires consent again.")
                    .small()
                    .color(SUBDUED),
            );
            if ui
                .add_enabled(
                    !self.provider_input.trim().is_empty() && self.provider_consent,
                    primary("Save protected provider"),
                )
                .clicked()
            {
                let host = std::mem::take(&mut self.provider_input);
                let _ = self.worker.lyrics.send(LyricCommand::Configure {
                    host,
                    consent: self.provider_consent,
                });
                self.provider_consent = false;
            }
        });
        card(ui, "Audio", |ui| {
            ui.horizontal(|ui| {
                let color = if self.native_id.is_some() {
                    ACCENT
                } else {
                    SUBDUED
                };
                ui.label(RichText::new("●").color(color));
                ui.add(egui::Label::new(&self.native_status).wrap());
            });
            if self.profile.is_some() && ui.button("Reconnect native audio").clicked() {
                self.native_id = None;
                self.native_status = "Connecting…".into();
                self.send(Command::RetryAudio);
            }
        });
        card(ui, "Playlist folders", |ui| {
            ui.label(
                RichText::new("Local folders organize the add-to-playlist picker. They do not change Spotify folders.")
                    .color(SUBDUED),
            );
            ui.horizontal(|ui| {
                ui.add(
                    egui::TextEdit::singleline(&mut self.folder_name)
                        .hint_text("New folder name")
                        .margin(vec2(12.0, 8.0)),
                );
                if ui.button("Create").clicked() && !self.folder_name.trim().is_empty() {
                    self.settings.folders.push(PlaylistFolder {
                        name: self.folder_name.trim().to_owned(),
                        show_in_picker: true,
                        ..PlaylistFolder::default()
                    });
                    self.folder_name.clear();
                    self.dirty = true;
                }
            });
            let mut remove = None;
            for (index, folder) in self.settings.folders.iter_mut().enumerate() {
                ui.push_id(index, |ui| {
                    ui.collapsing(&folder.name, |ui| {
                        self.dirty |= ui
                            .checkbox(&mut folder.show_in_picker, "Show in playlist picker")
                            .changed();
                        for playlist in &self.playlists {
                            let mut included = folder.playlist_ids.contains(&playlist.id);
                            if ui.checkbox(&mut included, &playlist.name).changed() {
                                folder.playlist_ids.retain(|id| id != &playlist.id);
                                if included {
                                    folder.playlist_ids.push(playlist.id.clone());
                                }
                                self.dirty = true;
                            }
                        }
                        if ui.button("Remove folder").clicked() {
                            remove = Some(index);
                        }
                    });
                });
            }
            if let Some(index) = remove {
                self.settings.folders.remove(index);
                self.dirty = true;
            }
        });
        card(ui, "App updates", |ui| {
            self.dirty |= toggle(
                ui,
                &mut self.settings.auto_download_updates,
                "Automatically download verified updates",
            )
            .changed();
            self.update_controls(ui);
        });
        card(ui, "Account", |ui| {
            if let Some(profile) = &self.profile {
                ui.label(format!(
                    "Signed in as {}",
                    profile.display_name.as_deref().unwrap_or(&profile.id)
                ));
            }
            ui.label(
                RichText::new("Keyboard: Space play/pause · Ctrl+K search · Alt+←/→ history · F5 refresh · Esc close")
                    .small()
                    .color(SUBDUED),
            );
            if self.profile.is_some() && ui.button("Sign out").clicked() {
                self.send(Command::Logout);
            }
        });
    }

    fn update_controls(&mut self, ui: &mut Ui) {
        ui.label(
            RichText::new(format!(
                "SpotiFlex {} · {}",
                env!("CARGO_PKG_VERSION"),
                self.update_status
            ))
            .color(SUBDUED),
        );
        if let Some(update) = &self.available_update {
            ui.label(&update.manifest.notes);
        }
        ui.horizontal(|ui| {
            if !self.update_busy
                && self.ready_update.is_some()
                && ui.add(primary("Install update and restart")).clicked()
            {
                if let Some(update) = self.ready_update.take() {
                    self.update_busy = true;
                    self.update_status = "Installing update…".into();
                    let _ = self
                        .updater
                        .commands
                        .send(updater::Command::Install(update));
                }
            } else if !self.update_busy
                && self.ready_update.is_none()
                && self.available_update.is_some()
                && ui.button("Download update").clicked()
                && let Some(update) = self.available_update.clone()
            {
                self.update_busy = true;
                let _ = self
                    .updater
                    .commands
                    .send(updater::Command::Download(update));
            }
            if !self.update_busy && ui.button("Check for updates").clicked() {
                self.update_status = "Checking for updates…".into();
                let _ = self.updater.commands.send(updater::Command::Check);
            }
            if self.update_busy {
                ui.spinner();
            }
        });
    }

    // ---------------------------------------------------------------- overlays

    fn picker(&mut self, context: &egui::Context) {
        let Some(tracks) = self.picker.clone() else {
            return;
        };
        let modal = egui::Modal::new(Id::new("playlist-picker"))
            .frame(popover_frame().inner_margin(20))
            .show(context, |ui| {
                ui.set_width(400.0_f32.min(context.content_rect().width() - 80.0));
                ui.horizontal(|ui| {
                    ui.label(RichText::new("Add to playlist").font(theme::bold(20.0)));
                    ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                        if icons::button(ui, Icon::Close, 13.0, false, "Close").clicked() {
                            self.picker = None;
                        }
                    });
                });
                ui.label(
                    RichText::new(format!(
                        "{} {} · duplicates are skipped",
                        tracks.len(),
                        if tracks.len() == 1 { "song" } else { "songs" }
                    ))
                    .color(SUBDUED),
                );
                ui.add_space(4.0);
                ui.add(
                    egui::TextEdit::singleline(&mut self.picker_filter)
                        .hint_text("Find a playlist")
                        .desired_width(f32::INFINITY)
                        .margin(vec2(12.0, 8.0)),
                );
                ui.add_space(4.0);
                let filter = self.picker_filter.to_lowercase();
                let user = self
                    .profile
                    .as_ref()
                    .map_or("", |profile| profile.id.as_str());
                let visible: HashSet<_> = self
                    .settings
                    .folders
                    .iter()
                    .filter(|folder| folder.show_in_picker)
                    .flat_map(|folder| folder.playlist_ids.iter().cloned())
                    .collect();
                let mut chosen = None;
                egui::ScrollArea::vertical()
                    .max_height((context.content_rect().height() - 260.0).clamp(160.0, 460.0))
                    .show(ui, |ui| {
                        for playlist in self.playlists.iter().filter(|playlist| {
                            playlist.editable_by(user)
                                && playlist.name.to_lowercase().contains(&filter)
                                && (visible.is_empty() || visible.contains(&playlist.id))
                        }) {
                            let (rect, response) = ui.allocate_exact_size(
                                vec2(ui.available_width(), 52.0),
                                Sense::click(),
                            );
                            hover_fill(ui, rect, &response, false);
                            let art =
                                Rect::from_min_size(rect.min + vec2(6.0, 6.0), Vec2::splat(40.0));
                            cover(ui, art, &playlist.images, 4);
                            theme::text(
                                ui,
                                Pos2::new(art.right() + 12.0, rect.center().y - 9.0),
                                &playlist.name,
                                theme::regular(15.0),
                                TEXT,
                                rect.right() - art.right() - 20.0,
                            );
                            if response.clicked() {
                                chosen = Some(playlist.clone());
                            }
                        }
                    });
                if let Some(playlist) = chosen {
                    self.send(Command::Add {
                        playlist,
                        tracks: tracks.clone(),
                    });
                    self.picker = None;
                }
            });
        if modal.should_close() {
            self.picker = None;
        }
    }

    fn toast(&mut self, context: &egui::Context) {
        if self.notice.is_empty() || self.profile.is_none() {
            return;
        }
        if !self.error && self.notice_at.elapsed() > Duration::from_secs(5) {
            self.notice.clear();
            return;
        }
        if !self.error {
            context.request_repaint_after(Duration::from_millis(500));
        }
        egui::Area::new(Id::new("toast"))
            .order(egui::Order::Foreground)
            .anchor(Align2::CENTER_BOTTOM, vec2(0.0, -(PLAYER_HEIGHT + 20.0)))
            .show(context, |ui| {
                egui::Frame::new()
                    .fill(if self.error {
                        Color32::from_rgb(120, 28, 38)
                    } else {
                        Color32::from_rgb(88, 70, 170)
                    })
                    .corner_radius(8)
                    .inner_margin(vec2(16.0, 10.0))
                    .shadow(egui::Shadow {
                        offset: [0, 6],
                        blur: 24,
                        spread: 0,
                        color: Color32::from_black_alpha(140),
                    })
                    .show(ui, |ui| {
                        ui.set_max_width(560.0);
                        ui.horizontal(|ui| {
                            ui.add(
                                egui::Label::new(RichText::new(&self.notice).color(TEXT)).wrap(),
                            );
                            if icons::button(ui, Icon::Close, 11.0, false, "Dismiss").clicked() {
                                self.notice.clear();
                            }
                        });
                    });
            });
    }

    fn sign_in(&mut self, context: &egui::Context) {
        // Deliberately ignore ModalResponse::should_close(): setup cannot be
        // dismissed by Escape or outside clicks until sign-in succeeds.
        egui::Modal::new(Id::new("required-spotify-setup"))
            .backdrop_color(Color32::from_black_alpha(210))
            .frame(
                egui::Frame::new()
                    .fill(ELEVATED)
                    .corner_radius(16)
                    .inner_margin(32)
                    .stroke(Stroke::new(1.0_f32, Color32::from_white_alpha(16))),
            )
            .show(context, |ui| {
                let width = 560.0_f32.min(context.content_rect().width() - 96.0);
                ui.set_width(width);
                ui.set_max_height((context.content_rect().height() - 80.0).max(320.0));
                egui::ScrollArea::vertical().show(ui, |ui| {
                    ui.horizontal(|ui| {
                        let (rect, _) = ui.allocate_exact_size(Vec2::splat(40.0), Sense::hover());
                        brand(ui.painter(), rect.center(), 40.0);
                        ui.vertical(|ui| {
                            ui.label(RichText::new("Welcome to SpotiFlex").font(theme::bold(24.0)).color(TEXT));
                            ui.label(RichText::new("Your Spotify, with synced lyrics and playlist tools.").color(SUBDUED));
                        });
                    });
                    ui.add_space(18.0);
                    egui::Frame::new()
                        .fill(Color32::from_rgba_unmultiplied(167, 139, 250, 30))
                        .stroke(Stroke::new(1.0_f32, ACCENT))
                        .corner_radius(10)
                        .inner_margin(vec2(16.0, 12.0))
                        .show(ui, |ui| {
                            ui.set_width(width - 32.0);
                            ui.label(RichText::new("Spotify Premium required").font(theme::bold(20.0)).color(ACCENT));
                            ui.label(
                                RichText::new("Playback runs through Spotify Connect, which only works with Premium accounts. Development apps also need a Premium owner; other accounts must be allowed in the dashboard.")
                                    .size(13.0)
                                    .color(TEXT),
                            );
                        });
                    if !self.notice.is_empty() {
                        ui.add_space(10.0);
                        ui.label(RichText::new(&self.notice).color(if self.error { ERROR } else { SUBDUED }));
                    }
                    ui.add_space(18.0);
                    step(ui, 1, "Create a Spotify developer app with Web API enabled.", |ui| {
                        ui.hyperlink_to("Open Developer Dashboard ↗", config::DASHBOARD_URL);
                    });
                    step(ui, 2, "Add this exact Redirect URI in the app settings.", |ui| {
                        ui.horizontal(|ui| {
                            egui::Frame::new()
                                .fill(Color32::from_white_alpha(12))
                                .corner_radius(6)
                                .inner_margin(vec2(10.0, 6.0))
                                .show(ui, |ui| {
                                    ui.label(RichText::new(config::REDIRECT_URI).monospace().color(TEXT));
                                });
                            if ui.button("Copy").clicked() {
                                ui.ctx().copy_text(config::REDIRECT_URI.into());
                                self.show_notice("Redirect URI copied".into(), false);
                            }
                        });
                    });
                    step(ui, 3, "Paste the app's Client ID. No client secret is needed.", |ui| {
                        let response = ui.add_enabled(
                            !self.login_pending,
                            egui::TextEdit::singleline(&mut self.settings.client_id)
                                .hint_text("Spotify Client ID")
                                .desired_width(f32::INFINITY)
                                .margin(vec2(12.0, 10.0)),
                        );
                        if response.changed() {
                            self.settings.client_id = self.settings.client_id.trim().to_owned();
                            self.dirty = true;
                        }
                    });
                    ui.add_space(14.0);
                    if self.login_pending {
                        ui.horizontal(|ui| {
                            ui.spinner();
                            ui.label(if self.login_restoring { "Restoring saved sign-in…" } else { "Finish sign-in in your browser…" });
                            ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                                if !self.login_restoring && ui.button("Cancel").clicked() {
                                    self.login_cancelled.store(true, Ordering::Relaxed);
                                    self.login_pending = false;
                                }
                            });
                        });
                    } else {
                        if let Some(issue) = self.login_issue.clone() {
                            ui.colored_label(Color32::LIGHT_RED, issue.message);
                            if issue.retry_saved && ui.button("Retry saved sign-in").clicked() {
                                self.login_restoring = true;
                                self.login_pending = true;
                                self.login_issue = None;
                                self.send(Command::Restore(self.settings.client_id.clone()));
                            }
                        }
                        let valid = config::valid_client_id(&self.settings.client_id);
                        let button = primary("Sign in with Spotify").min_size(vec2(width, 48.0));
                        if ui.add_enabled(valid, button).clicked() {
                            self.save_settings();
                            self.login_pending = true;
                            self.login_issue = None;
                            self.login_cancelled = Arc::new(AtomicBool::new(false));
                            self.send(Command::Login(
                                self.settings.client_id.clone(),
                                self.login_cancelled.clone(),
                            ));
                        }
                        if !valid && !self.settings.client_id.is_empty() {
                            ui.label(RichText::new("Client IDs are 32 letters and numbers.").small().color(SUBDUED));
                        }
                    }
                    if self.available_update.is_some() {
                        ui.add_space(12.0);
                        ui.separator();
                        self.update_controls(ui);
                    }
                });
            });
    }

    fn shortcuts(&mut self, context: &egui::Context) {
        if self.profile.is_none() {
            return;
        }
        if context.input_mut(|input| input.consume_key(Modifiers::COMMAND, egui::Key::K)) {
            context.memory_mut(|memory| memory.request_focus(Id::new(SEARCH_ID)));
        }
        if context.input_mut(|input| input.consume_key(Modifiers::ALT, egui::Key::ArrowLeft)) {
            self.back();
        }
        if context.input_mut(|input| input.consume_key(Modifiers::ALT, egui::Key::ArrowRight)) {
            self.forward();
        }
        if context.wants_keyboard_input() {
            return;
        }
        if context.input(|input| input.key_pressed(egui::Key::Space)) {
            self.toggle_play();
        }
        if context.input(|input| input.key_pressed(egui::Key::F5)) {
            self.send(Command::Refresh);
            self.navigate(self.view.clone());
        }
        if context.input(|input| input.key_pressed(egui::Key::Escape))
            && self.picker.is_none()
            && !context.is_popup_open()
        {
            if self.immersive {
                self.set_immersive(false);
            } else if self.center != Center::Browse {
                self.leave_page();
            } else {
                self.selected.clear();
            }
        }
    }
}

impl eframe::App for SpotiFlex {
    fn update(&mut self, context: &egui::Context, _frame: &mut eframe::Frame) {
        self.receive();
        self.art.poll(context);
        if self.exit_after_update {
            context.send_viewport_cmd(egui::ViewportCommand::Close);
            return;
        }
        if let Some(fullscreen) = self.pending_fullscreen.take() {
            context.send_viewport_cmd(egui::ViewportCommand::Fullscreen(fullscreen));
        }
        self.shortcuts(context);
        self.dropped_lyrics(context);
        let width = context.content_rect().width();
        let signed_in = self.profile.is_some();
        if !self.immersive {
            self.top_bar(context);
        }
        self.player(context, width);
        if !self.immersive {
            self.sidebar(context, self.library_collapsed || width < 900.0);
            if signed_in && self.settings.show_lyrics && width >= 1180.0 {
                self.now_playing(context);
            }
        }
        let lyrics_page = self.center == Center::Lyrics && signed_in;
        let frame = if lyrics_page {
            egui::Frame::new()
        } else {
            egui::Frame::new().fill(SURFACE).corner_radius(RADIUS)
        };
        let frame = if self.immersive {
            frame
        } else {
            frame.outer_margin(egui::Margin {
                left: 4,
                right: if signed_in && self.settings.show_lyrics && width >= 1180.0 {
                    4
                } else {
                    8
                },
                top: 0,
                bottom: 0,
            })
        };
        egui::CentralPanel::default()
            .frame(frame)
            .show(context, |ui| {
                if !signed_in {
                    return;
                }
                match self.center {
                    Center::Lyrics => self.lyrics_page(ui),
                    Center::Settings => self.settings_page(ui),
                    Center::Browse => self.browse(ui),
                }
            });
        self.picker(context);
        self.toast(context);
        if !signed_in {
            self.sign_in(context);
        }
        let animated = lyrics_page && !self.settings.reduce_motion;
        if self.playback.is_playing || animated {
            context.request_repaint_after(Duration::from_millis(if self.settings.reduce_motion {
                100
            } else {
                16
            }));
        }
    }

    fn on_exit(&mut self, _gl: Option<&eframe::glow::Context>) {
        self.login_cancelled.store(true, Ordering::Relaxed);
        self.save_settings();
    }

    fn clear_color(&self, _visuals: &egui::Visuals) -> [f32; 4] {
        [0.0, 0.0, 0.0, 1.0]
    }
}

// -------------------------------------------------------------------- widgets

struct Columns {
    width: f32,
    title: f32,
    title_end: f32,
    album: f32,
}

impl Columns {
    fn new(width: f32) -> Self {
        let width = width - 32.0;
        let album = if width >= 700.0 { width * 0.58 } else { 0.0 };
        Self {
            width,
            title: 52.0,
            title_end: if album > 0.0 {
                album - 16.0
            } else {
                width - 120.0
            },
            album,
        }
    }
}

struct BarOutput {
    shown: f32,
    released: Option<f32>,
}

/// Thin Spotify-style slider: white fill, green with a knob while hovered.
fn bar(ui: &Ui, rect: Rect, id: Id, value: f32) -> BarOutput {
    let response = ui.interact(rect.expand2(vec2(0.0, 6.0)), id, Sense::click_and_drag());
    let fraction = |pos: Pos2| ((pos.x - rect.left()) / rect.width().max(1.0)).clamp(0.0, 1.0);
    let pointer = response
        .interact_pointer_pos()
        .or(response.hover_pos())
        .map(fraction);
    let mut shown = value.clamp(0.0, 1.0);
    let mut released = None;
    if response.dragged() || response.is_pointer_button_down_on() {
        shown = pointer.unwrap_or(shown);
    }
    if response.drag_stopped() || response.clicked() {
        released = Some(pointer.unwrap_or(shown));
        shown = released.unwrap_or(shown);
    }
    let active = response.hovered() || response.dragged();
    let track = Rect::from_center_size(rect.center(), vec2(rect.width(), 4.0));
    ui.painter()
        .rect_filled(track, 2.0, Color32::from_white_alpha(60));
    let filled = Rect::from_min_max(
        track.min,
        Pos2::new(track.left() + track.width() * shown, track.bottom()),
    );
    ui.painter()
        .rect_filled(filled, 2.0, if active { ACCENT } else { TEXT });
    if active {
        ui.painter()
            .circle_filled(Pos2::new(filled.right(), track.center().y), 6.0, TEXT);
        ui.ctx().set_cursor_icon(egui::CursorIcon::PointingHand);
    }
    BarOutput { shown, released }
}

fn primary(text: &str) -> egui::Button<'_> {
    egui::Button::new(
        RichText::new(text)
            .font(theme::bold(15.0))
            .color(Color32::BLACK),
    )
    .fill(ACCENT)
    .corner_radius(24)
    .min_size(vec2(0.0, 40.0))
}

fn chip(ui: &mut Ui, label: &str, selected: bool) -> egui::Response {
    let galley = theme::line(ui, label, theme::regular(13.5), TEXT, 200.0);
    let (rect, response) = ui.allocate_exact_size(galley.size() + vec2(24.0, 14.0), Sense::click());
    let (fill, text) = if selected {
        (TEXT, Color32::BLACK)
    } else if response.hovered() {
        (Color32::from_rgb(56, 56, 78), TEXT)
    } else {
        (HIGHLIGHT, TEXT)
    };
    ui.painter().rect_filled(rect, rect.height() / 2.0, fill);
    ui.painter()
        .galley_with_override_text_color(rect.center() - galley.size() / 2.0, galley, text);
    response
}

/// Label on the left, pill switch on the right.
fn toggle(ui: &mut Ui, value: &mut bool, label: &str) -> egui::Response {
    let width = ui.available_width();
    let (rect, mut response) = ui.allocate_exact_size(vec2(width, 32.0), Sense::click());
    if response.clicked() {
        *value = !*value;
        response.mark_changed();
    }
    let on = ui.ctx().animate_bool_with_time(response.id, *value, 0.12);
    ui.painter().text(
        Pos2::new(rect.left(), rect.center().y),
        Align2::LEFT_CENTER,
        label,
        theme::regular(14.5),
        TEXT,
    );
    let switch = Rect::from_center_size(
        Pos2::new(rect.right() - 22.0, rect.center().y),
        vec2(40.0, 22.0),
    );
    ui.painter().rect_filled(
        switch,
        11.0,
        theme::lerp_color(Color32::from_rgb(90, 90, 116), ACCENT, on),
    );
    ui.painter().circle_filled(
        Pos2::new(switch.left() + 11.0 + on * 18.0, switch.center().y),
        8.0,
        if *value { Color32::BLACK } else { TEXT },
    );
    response
}

fn card(ui: &mut Ui, title: &str, contents: impl FnOnce(&mut Ui)) {
    // Fix the inner width so long text wraps instead of widening one card.
    let width = (ui.available_width() - 40.0).max(120.0);
    egui::Frame::new()
        .fill(ELEVATED)
        .corner_radius(12)
        .inner_margin(20)
        .show(ui, |ui| {
            ui.set_width(width);
            ui.label(RichText::new(title).font(theme::bold(17.0)).color(TEXT));
            ui.add_space(6.0);
            contents(ui);
        });
    ui.add_space(12.0);
}

fn step(ui: &mut Ui, number: usize, text: &str, contents: impl FnOnce(&mut Ui)) {
    ui.horizontal_top(|ui| {
        let (rect, _) = ui.allocate_exact_size(Vec2::splat(28.0), Sense::hover());
        ui.painter()
            .circle_stroke(rect.center(), 13.0, Stroke::new(1.5_f32, ACCENT));
        ui.painter().text(
            rect.center(),
            Align2::CENTER_CENTER,
            number.to_string(),
            theme::bold(14.0),
            ACCENT,
        );
        ui.vertical(|ui| {
            ui.label(RichText::new(text).color(TEXT));
            contents(ui);
        });
    });
    ui.add_space(10.0);
}

fn device_row(ui: &mut Ui, name: &str, kind: &str, active: bool) -> egui::Response {
    let (rect, response) = ui.allocate_exact_size(vec2(ui.available_width(), 52.0), Sense::click());
    hover_fill(ui, rect, &response, false);
    let color = if active { ACCENT } else { TEXT };
    icons::paint(
        ui.painter(),
        Rect::from_center_size(
            Pos2::new(rect.left() + 22.0, rect.center().y),
            Vec2::splat(24.0),
        ),
        Icon::Devices,
        color,
    );
    theme::text(
        ui,
        Pos2::new(rect.left() + 46.0, rect.top() + 8.0),
        name,
        theme::bold(14.5),
        color,
        rect.width() - 56.0,
    );
    theme::text(
        ui,
        Pos2::new(rect.left() + 46.0, rect.top() + 28.0),
        if active { "Listening on" } else { kind },
        theme::regular(12.5),
        if active { ACCENT } else { SUBDUED },
        rect.width() - 56.0,
    );
    response
}

fn popover_frame() -> egui::Frame {
    egui::Frame::new()
        .fill(Color32::from_rgb(36, 36, 52))
        .corner_radius(10)
        .inner_margin(12)
        .shadow(egui::Shadow {
            offset: [0, 10],
            blur: 32,
            spread: 0,
            color: Color32::from_black_alpha(160),
        })
}

fn hover_fill(ui: &Ui, rect: Rect, response: &egui::Response, selected: bool) {
    let alpha = if selected {
        24
    } else if response.hovered() {
        12
    } else {
        return;
    };
    ui.painter()
        .rect_filled(rect, 6.0, Color32::from_white_alpha(alpha));
}

fn cover(ui: &Ui, rect: Rect, images: &[Artwork], radius: u8) {
    ui.painter().rect_filled(rect, radius, HIGHLIGHT);
    let pixels = rect.width() * ui.ctx().pixels_per_point();
    if let Some(url) = art::pick(images, pixels) {
        egui::Image::new(url)
            .corner_radius(radius)
            .show_loading_spinner(false)
            .paint_at(ui, rect);
    } else {
        icons::paint(
            ui.painter(),
            rect.shrink(rect.width() * 0.3),
            Icon::Music,
            FAINT,
        );
    }
}

fn liked_cover(painter: &egui::Painter, rect: Rect) {
    let radius = (rect.width() * 0.08).clamp(4.0, 8.0);
    painter.rect_filled(rect, radius, Color32::from_rgb(124, 58, 237));
    let glow = Rect::from_min_max(rect.center(), rect.max);
    painter.rect_filled(
        glow,
        egui::CornerRadius {
            nw: 0,
            ne: 0,
            sw: 0,
            se: radius as u8,
        },
        Color32::from_rgba_unmultiplied(236, 72, 153, 110),
    );
    icons::paint(painter, rect.shrink(rect.width() * 0.3), Icon::Heart, TEXT);
}

fn equalizer(painter: &egui::Painter, rect: Rect, time: f32) {
    let width = rect.width() / 5.0;
    for bar in 0..3 {
        let phase = time * (5.0 + bar as f32 * 1.7) + bar as f32;
        let height = rect.height() * (0.35 + 0.65 * (phase.sin() * 0.5 + 0.5));
        let left = rect.left() + bar as f32 * width * 2.0;
        painter.rect_filled(
            Rect::from_min_max(
                Pos2::new(left, rect.bottom() - height),
                Pos2::new(left + width, rect.bottom()),
            ),
            1.0,
            ACCENT,
        );
    }
}

fn skeleton_row(painter: &egui::Painter, rect: Rect, pulse: f32) {
    let color = Color32::from_white_alpha((10.0 + pulse * 10.0) as u8);
    let mid = rect.center().y;
    painter.rect_filled(
        Rect::from_center_size(Pos2::new(rect.left() + 22.0, mid), vec2(14.0, 12.0)),
        3.0,
        color,
    );
    painter.rect_filled(
        Rect::from_min_size(Pos2::new(rect.left() + 52.0, mid - 20.0), Vec2::splat(40.0)),
        4.0,
        color,
    );
    painter.rect_filled(
        Rect::from_min_size(
            Pos2::new(rect.left() + 104.0, mid - 14.0),
            vec2(rect.width() * 0.3, 11.0),
        ),
        5.0,
        color,
    );
    painter.rect_filled(
        Rect::from_min_size(
            Pos2::new(rect.left() + 104.0, mid + 4.0),
            vec2(rect.width() * 0.18, 10.0),
        ),
        5.0,
        color,
    );
}

fn small_message(ui: &Ui, rect: Rect, text: &str) {
    ui.painter().text(
        rect.center(),
        Align2::CENTER_CENTER,
        text,
        theme::bold(16.0),
        Color32::from_white_alpha(200),
    );
}

fn duration_words(milliseconds: u64) -> String {
    let minutes = milliseconds / 60_000;
    if minutes >= 60 {
        format!("{} hr {} min", minutes / 60, minutes % 60)
    } else {
        format!("{minutes} min")
    }
}

fn brand(painter: &egui::Painter, center: Pos2, size: f32) {
    use crate::ui::icon_pixels::{ICON_BAR_HALF_WIDTH, ICON_BARS, ICON_RADIUS};
    let tile = Rect::from_center_size(center, Vec2::splat(size * 0.94));
    painter.rect_filled(tile, size * ICON_RADIUS, ACCENT);
    let bottom = Rect::from_min_max(tile.center(), tile.max);
    painter.rect_filled(
        bottom,
        egui::CornerRadius {
            nw: 0,
            ne: 0,
            sw: 0,
            se: (size * ICON_RADIUS) as u8,
        },
        Color32::from_rgba_unmultiplied(34, 211, 238, 120),
    );
    let origin = center - Vec2::splat(size / 2.0);
    for (x, half) in ICON_BARS {
        painter.rect_filled(
            Rect::from_center_size(
                origin + vec2(x, 0.5) * size,
                vec2(ICON_BAR_HALF_WIDTH * 2.0, half * 2.0) * size,
            ),
            ICON_BAR_HALF_WIDTH * size,
            Color32::from_rgb(10, 10, 18),
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn duration_words_switches_to_hours() {
        assert_eq!(duration_words(59 * 60_000), "59 min");
        assert_eq!(duration_words(125 * 60_000), "2 hr 5 min");
    }

    #[test]
    fn columns_hide_album_on_narrow_widths() {
        assert_eq!(Columns::new(600.0).album, 0.0);
        assert!(Columns::new(1200.0).album > Columns::new(1200.0).title_end);
    }
}
