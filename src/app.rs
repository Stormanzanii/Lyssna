use std::{
    collections::HashSet,
    path::PathBuf,
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    time::{Duration, Instant},
};

use eframe::egui::{self, Align, Color32, FontId, Layout, RichText, Sense, Stroke, Vec2};

use crate::{
    api::PlayerAction,
    config::{self, PlaylistFolder, Settings},
    lyrics::Lyrics,
    model::{Device, Playback, Playlist, Profile, Track},
    native::NativeEvent,
    worker::{Command, Event, LyricCommand, Worker},
};

const GREEN: Color32 = Color32::from_rgb(30, 215, 96);
const MUTED: Color32 = Color32::from_rgb(166, 173, 169);
const PANEL: Color32 = Color32::from_rgb(18, 20, 19);

pub struct SpotiFlex {
    settings: Settings,
    worker: Worker,
    profile: Option<Profile>,
    playlists: Vec<Playlist>,
    tracks: Vec<Track>,
    selected: HashSet<usize>,
    view: String,
    search: String,
    library_filter: String,
    playback: Playback,
    observed: Instant,
    devices: Vec<Device>,
    selected_device: Option<String>,
    native_id: Option<String>,
    native_status: String,
    lyrics: Option<Lyrics>,
    lyric_error: String,
    lyric_loading: bool,
    active_line: Option<usize>,
    follow_lyrics: bool,
    cinema: bool,
    settings_open: bool,
    devices_open: bool,
    picker: Option<Vec<Track>>,
    picker_filter: String,
    import_path: String,
    folder_name: String,
    login_pending: bool,
    login_cancelled: Arc<AtomicBool>,
    loading: bool,
    more: bool,
    notice: String,
    error: bool,
    dirty: bool,
    config_damaged: bool,
    provider_input: String,
    provider_consent: bool,
    provider_configured: bool,
}

impl SpotiFlex {
    pub fn new(context: &eframe::CreationContext<'_>) -> Self {
        let mut visuals = egui::Visuals::dark();
        visuals.panel_fill = Color32::from_rgb(8, 10, 9);
        visuals.window_fill = Color32::from_rgb(27, 30, 28);
        visuals.extreme_bg_color = Color32::from_rgb(10, 12, 11);
        visuals.selection.bg_fill = Color32::from_rgb(34, 67, 44);
        visuals.selection.stroke = Stroke::new(1.0_f32, GREEN);
        visuals.widgets.active.bg_fill = Color32::from_rgb(52, 65, 56);
        visuals.widgets.hovered.bg_fill = Color32::from_rgb(48, 53, 50);
        visuals.widgets.inactive.bg_fill = Color32::from_rgb(32, 36, 33);
        visuals.widgets.noninteractive.bg_stroke = Stroke::NONE;
        context.egui_ctx.set_visuals(visuals);
        context.egui_ctx.style_mut(|style| {
            style.spacing.item_spacing = Vec2::new(10.0, 9.0);
            style.spacing.button_padding = Vec2::new(14.0, 9.0);
            style
                .text_styles
                .insert(egui::TextStyle::Body, FontId::proportional(15.0));
            style
                .text_styles
                .insert(egui::TextStyle::Button, FontId::proportional(14.0));
            style
                .text_styles
                .insert(egui::TextStyle::Heading, FontId::proportional(27.0));
        });
        let mut fonts = egui::FontDefinitions::default();
        if let Ok(bytes) = std::fs::read("C:\\Windows\\Fonts\\segoeui.ttf") {
            fonts
                .font_data
                .insert("segoe".into(), egui::FontData::from_owned(bytes).into());
            fonts
                .families
                .entry(egui::FontFamily::Proportional)
                .or_default()
                .insert(0, "segoe".into());
        }
        context.egui_ctx.set_fonts(fonts);
        egui_extras::install_image_loaders(&context.egui_ctx);
        let (settings, notice, config_damaged) = match Settings::load() {
            Ok(settings) => (settings, String::new(), false),
            Err(error) => (Settings::default(), error.to_string(), true),
        };
        let worker = Worker::start(context.egui_ctx.clone());
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
            view: settings.last_view.clone(),
            settings,
            worker,
            profile: None,
            playlists: Vec::new(),
            tracks: Vec::new(),
            selected: HashSet::new(),
            search,
            library_filter: String::new(),
            playback: Playback::default(),
            observed: Instant::now(),
            devices: Vec::new(),
            selected_device: None,
            native_id: None,
            native_status: "Waiting for sign-in".into(),
            lyrics: None,
            lyric_error: String::new(),
            lyric_loading: false,
            active_line: None,
            follow_lyrics: true,
            cinema: false,
            settings_open: false,
            devices_open: false,
            picker: None,
            picker_filter: String::new(),
            import_path: String::new(),
            folder_name: String::new(),
            login_pending,
            login_cancelled: Arc::new(AtomicBool::new(false)),
            loading: false,
            more: false,
            notice,
            error: config_damaged,
            dirty: false,
            config_damaged,
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

    fn navigate(&mut self, key: String) {
        self.view = key.clone();
        self.settings.last_view = key.clone();
        self.dirty = true;
        self.tracks.clear();
        self.selected.clear();
        self.more = false;
        if self.profile.is_some() {
            self.loading = true;
            self.send(Command::Tracks { key, offset: 0 });
        }
        self.save_settings();
    }

    fn fetch_lyrics(&mut self) {
        if let Some(track) = self.playback.item.clone() {
            self.lyric_loading = true;
            self.lyric_error.clear();
            self.send(Command::FetchLyrics(track));
        }
    }

    fn receive(&mut self) {
        while let Ok(event) = self.worker.events.try_recv() {
            match event {
                Event::Session(profile) => {
                    self.profile = Some(profile);
                    self.native_status = "Connecting…".into();
                    self.navigate(self.view.clone());
                }
                Event::SignedOut => {
                    self.profile = None;
                    self.playlists.clear();
                    self.tracks.clear();
                    self.devices.clear();
                    self.selected.clear();
                    self.playback = Playback::default();
                    self.lyrics = None;
                    self.native_id = None;
                    self.selected_device = None;
                    self.picker = None;
                    self.native_status = "Waiting for sign-in".into();
                    self.lyric_loading = false;
                }
                Event::LoginFinished => self.login_pending = false,
                Event::Library(playlists) => self.playlists = playlists,
                Event::Tracks {
                    key,
                    offset,
                    tracks,
                } if key == self.view => {
                    self.loading = false;
                    self.more = tracks.len() == 50 && !key.starts_with("search:");
                    if offset == 0 {
                        self.tracks = tracks;
                    } else if offset == self.tracks.len() {
                        self.tracks.extend(tracks);
                    }
                }
                Event::Tracks { .. } => {}
                Event::Playback(playback, observed) => {
                    let changed = self.playback.item.as_ref().map(|track| &track.uri)
                        != playback.item.as_ref().map(|track| &track.uri);
                    self.playback = *playback;
                    self.observed = observed;
                    if changed {
                        self.lyrics = None;
                        self.active_line = None;
                        self.lyric_error.clear();
                        self.follow_lyrics = true;
                        if self.settings.show_lyrics || self.cinema {
                            self.fetch_lyrics();
                        }
                    }
                }
                Event::Devices(devices) => self.devices = devices,
                Event::Notice(message) => self.show_notice(message, false),
                Event::Error(message) => {
                    self.loading = false;
                    self.show_notice(message, true);
                }
            }
        }
        while let Ok(event) = self.worker.native_events.try_recv() {
            if self.profile.is_none() {
                continue;
            }
            match event {
                NativeEvent::Ready(id) => {
                    self.native_id = Some(id);
                    self.native_status = "Ready · this computer".into();
                }
                NativeEvent::Error(message) => {
                    self.native_id = None;
                    self.native_status = message;
                }
                NativeEvent::Position {
                    uri,
                    position_ms,
                    playing,
                } => {
                    if self
                        .playback
                        .item
                        .as_ref()
                        .is_some_and(|track| track.uri == uri)
                        && self.playback.device.id == self.native_id
                    {
                        self.playback.progress_ms = Some(position_ms);
                        self.observed = Instant::now();
                        if let Some(playing) = playing {
                            self.playback.is_playing = playing;
                        }
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
                match event.result {
                    Ok(lyrics) => {
                        self.lyrics = Some(lyrics);
                        self.lyric_error.clear();
                    }
                    Err(message) => self.lyric_error = message,
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

    fn action(&self, action: PlayerAction) {
        let device = self
            .selected_device
            .clone()
            .or_else(|| self.playback.device.id.clone())
            .or_else(|| self.native_id.clone());
        self.send(Command::Player { action, device });
    }

    fn top_bar(&mut self, context: &egui::Context) {
        egui::TopBottomPanel::top("navigation")
            .frame(egui::Frame::new().fill(Color32::BLACK).inner_margin(14))
            .show(context, |ui| {
                ui.horizontal(|ui| {
                    brand(ui, 30.0);
                    ui.label(RichText::new("SpotiFlex").strong().size(20.0));
                    ui.add_space(22.0);
                    if ui.button("⌂  Home").clicked() {
                        self.navigate("home".into());
                    }
                    let response = ui.add(
                        egui::TextEdit::singleline(&mut self.search)
                            .hint_text("What do you want to play?")
                            .desired_width((ui.available_width() - 250.0).clamp(120.0, 420.0))
                            .margin(Vec2::new(16.0, 10.0)),
                    );
                    if ((response.lost_focus()
                        && ui.input(|input| input.key_pressed(egui::Key::Enter)))
                        || ui.button("Search").clicked())
                        && !self.search.trim().is_empty()
                    {
                        self.navigate(format!("search:{}", self.search.trim()));
                    }
                    ui.with_layout(Layout::right_to_left(Align::Center), |ui| {
                        if ui.button("Settings").clicked() {
                            self.settings_open = true;
                        }
                        if let Some(profile) = &self.profile {
                            ui.label(
                                RichText::new(
                                    profile.display_name.as_deref().unwrap_or(&profile.id),
                                )
                                .color(MUTED),
                            );
                        }
                    });
                });
            });
    }

    fn sidebar(&mut self, context: &egui::Context) {
        egui::SidePanel::left("library")
            .resizable(true)
            .default_width(260.0)
            .width_range(200.0..=400.0)
            .frame(
                egui::Frame::new()
                    .fill(PANEL)
                    .inner_margin(16)
                    .corner_radius(10),
            )
            .show(context, |ui| {
                ui.horizontal(|ui| {
                    ui.label(RichText::new("Your Library").size(19.0).strong());
                    if ui
                        .small_button("↻")
                        .on_hover_text("Refresh all playlists")
                        .clicked()
                        && self.profile.is_some()
                    {
                        self.send(Command::Library);
                    }
                });
                ui.add_space(8.0);
                if ui
                    .selectable_label(self.view == "liked", "♥  Liked Songs")
                    .clicked()
                {
                    self.navigate("liked".into());
                }
                if ui
                    .selectable_label(self.view == "queue", "≡  Queue")
                    .clicked()
                {
                    self.navigate("queue".into());
                }
                ui.add_space(10.0);
                ui.add(
                    egui::TextEdit::singleline(&mut self.library_filter)
                        .hint_text("Search your library")
                        .desired_width(f32::INFINITY),
                );
                ui.add_space(4.0);
                ui.label(
                    RichText::new(format!("{} playlists", self.playlists.len()))
                        .small()
                        .color(MUTED),
                );
                let filter = self.library_filter.to_lowercase();
                let playlists = self.playlists.clone();
                egui::ScrollArea::vertical()
                    .id_salt("library-scroll")
                    .show(ui, |ui| {
                        for playlist in playlists
                            .iter()
                            .filter(|playlist| playlist.name.to_lowercase().contains(&filter))
                        {
                            let key = format!("playlist:{}", playlist.id);
                            let row = ui.horizontal(|ui| {
                                if !self.settings.compact_library {
                                    artwork(ui, &playlist.images, 42.0);
                                }
                                let response = ui.selectable_label(
                                    self.view == key,
                                    RichText::new(&playlist.name).size(14.0),
                                );
                                if response.clicked() {
                                    self.navigate(key.clone());
                                }
                            });
                            row.response.context_menu(|ui| {
                                ui.label(&playlist.name);
                                ui.separator();
                                if ui.button("Copy clean link").clicked() {
                                    ui.ctx().copy_text(format!(
                                        "https://open.spotify.com/playlist/{}",
                                        playlist.id
                                    ));
                                    ui.close();
                                }
                            });
                        }
                        if self.profile.is_none() {
                            ui.add_space(28.0);
                            ui.label(
                                RichText::new("Sign in to bring your Spotify library here.")
                                    .color(MUTED),
                            );
                        }
                    });
            });
    }

    fn setup(&mut self, ui: &mut egui::Ui) {
        egui::ScrollArea::vertical().show(ui, |ui| {
            ui.add_space(34.0);
            ui.label(RichText::new("Your Spotify. A little more you.").size(34.0).strong());
            ui.add_space(8.0);
            ui.label(RichText::new("Sign in once. Your playlists, music, and lyrics live here.").size(17.0).color(MUTED));
            ui.add_space(28.0);
            egui::Frame::new().fill(Color32::from_rgb(28, 35, 30)).inner_margin(24).corner_radius(12).show(ui, |ui| {
                ui.set_max_width(620.0);
                ui.heading("Connect Spotify");
                ui.add_space(8.0);
                ui.label("1. Open Spotify Developer Dashboard. Create an app with Web API enabled.");
                ui.hyperlink_to("Open Developer Dashboard ↗", config::DASHBOARD_URL);
                ui.label("2. Add this exact Redirect URI in the app settings:");
                ui.horizontal_wrapped(|ui| {
                    ui.code(config::REDIRECT_URI);
                    if ui.small_button("Copy").clicked() { ui.ctx().copy_text(config::REDIRECT_URI.into()); }
                });
                ui.label("3. Paste the app's Client ID below. No client secret needed.");
                ui.add_space(8.0);
                let response = ui.add_enabled(!self.login_pending, egui::TextEdit::singleline(&mut self.settings.client_id).hint_text("Spotify Client ID").desired_width(440.0));
                if response.changed() { self.settings.client_id = self.settings.client_id.trim().to_owned(); self.dirty = true; }
                ui.add_space(10.0);
                if self.login_pending {
                    ui.horizontal(|ui| {
                        ui.spinner(); ui.label("Finish sign-in in your browser…");
                        if ui.button("Cancel").clicked() { self.login_cancelled.store(true, Ordering::Relaxed); }
                    });
                } else if ui.add_enabled(config::valid_client_id(&self.settings.client_id), primary("Sign in with Spotify")).clicked() {
                    self.save_settings(); self.login_pending = true;
                    self.login_cancelled = Arc::new(AtomicBool::new(false));
                    self.send(Command::Login(self.settings.client_id.clone(), self.login_cancelled.clone()));
                }
                ui.add_space(12.0);
                ui.label(RichText::new("Spotify Premium is required for native playback. Development apps require a Premium owner; additional accounts must be allowed in the dashboard.").small().color(MUTED));
            });
            ui.add_space(24.0);
            ui.label(RichText::new("Synced lyrics  ·  Playlist tools  ·  Native audio").color(MUTED));
        });
    }

    fn content(&mut self, context: &egui::Context) {
        egui::CentralPanel::default()
            .frame(
                egui::Frame::new()
                    .fill(PANEL)
                    .inner_margin(24)
                    .corner_radius(10),
            )
            .show(context, |ui| {
                if !self.notice.is_empty() {
                    let color = if self.error {
                        Color32::from_rgb(245, 151, 137)
                    } else {
                        GREEN
                    };
                    ui.horizontal_wrapped(|ui| {
                        ui.label(RichText::new(&self.notice).color(color));
                        if ui.small_button("Dismiss").clicked() {
                            self.notice.clear();
                        }
                    });
                    ui.add_space(12.0);
                }
                if self.profile.is_none() {
                    return;
                }
                if self.cinema {
                    self.lyrics_content(ui, true);
                    return;
                }
                let title = if let Some(id) = self.view.strip_prefix("playlist:") {
                    self.playlists
                        .iter()
                        .find(|playlist| playlist.id == id)
                        .map_or("Playlist".to_owned(), |playlist| playlist.name.clone())
                } else if self.view.starts_with("search:") {
                    format!("Results for “{}”", self.search)
                } else {
                    match self.view.as_str() {
                        "liked" => "Liked Songs",
                        "queue" => "Your queue",
                        _ => "Home",
                    }
                    .into()
                };
                ui.add_space(8.0);
                ui.label(RichText::new(&title).size(34.0).strong());
                ui.label(
                    RichText::new(if self.view == "home" {
                        "Recently played, ready to revisit"
                    } else {
                        "Your music on Spotify"
                    })
                    .color(MUTED),
                );
                ui.add_space(14.0);
                if self.view == "home" && !self.playlists.is_empty() {
                    let playlists: Vec<_> = self.playlists.iter().take(6).cloned().collect();
                    ui.horizontal_wrapped(|ui| {
                        for playlist in playlists {
                            let response = egui::Frame::new()
                                .fill(Color32::from_rgb(36, 41, 37))
                                .inner_margin(8)
                                .corner_radius(6)
                                .show(ui, |ui| {
                                    ui.set_width(165.0);
                                    ui.horizontal(|ui| {
                                        artwork(ui, &playlist.images, 44.0);
                                        ui.add(
                                            egui::Label::new(
                                                RichText::new(&playlist.name).strong(),
                                            )
                                            .truncate(),
                                        );
                                    });
                                })
                                .response
                                .interact(Sense::click());
                            if response.clicked() {
                                self.navigate(format!("playlist:{}", playlist.id));
                            }
                        }
                    });
                    ui.add_space(18.0);
                    ui.label(RichText::new("Recently played").size(22.0).strong());
                }
                ui.horizontal(|ui| {
                    if !self.selected.is_empty() {
                        ui.label(format!("{} selected", self.selected.len()));
                        if ui.button("Add to playlist").clicked() {
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
                        }
                        if ui.small_button("Clear").clicked() {
                            self.selected.clear();
                        }
                    }
                    if self.loading {
                        ui.spinner();
                    }
                });
                ui.separator();
                egui::ScrollArea::vertical()
                    .id_salt(("tracks", &self.view))
                    .show(ui, |ui| {
                        let tracks = self.tracks.clone();
                        for (index, track) in tracks.iter().enumerate() {
                            let playing = self
                                .playback
                                .item
                                .as_ref()
                                .is_some_and(|current| current.uri == track.uri);
                            let response = egui::Frame::new()
                                .fill(if self.selected.contains(&index) {
                                    Color32::from_rgb(39, 54, 43)
                                } else {
                                    Color32::TRANSPARENT
                                })
                                .inner_margin(8)
                                .corner_radius(6)
                                .show(ui, |ui| {
                                    ui.horizontal(|ui| {
                                        let mut selected = self.selected.contains(&index);
                                        if ui.checkbox(&mut selected, "").changed() {
                                            if selected {
                                                self.selected.insert(index);
                                            } else {
                                                self.selected.remove(&index);
                                            }
                                        }
                                        if ui
                                            .small_button(if playing && self.playback.is_playing {
                                                "Ⅱ"
                                            } else {
                                                "▶"
                                            })
                                            .clicked()
                                        {
                                            if playing && self.playback.is_playing {
                                                self.action(PlayerAction::Pause);
                                            } else {
                                                self.action(PlayerAction::Play(Some(
                                                    track.uri.clone(),
                                                )));
                                            }
                                        }
                                        artwork(ui, &track.album.images, 42.0);
                                        ui.allocate_ui_with_layout(
                                            Vec2::new(
                                                (ui.available_width() - 80.0).max(80.0),
                                                44.0,
                                            ),
                                            Layout::top_down(Align::Min),
                                            |ui| {
                                                ui.add(
                                                    egui::Label::new(
                                                        RichText::new(&track.name).strong().color(
                                                            if playing {
                                                                GREEN
                                                            } else {
                                                                Color32::WHITE
                                                            },
                                                        ),
                                                    )
                                                    .truncate(),
                                                );
                                                ui.add(
                                                    egui::Label::new(
                                                        RichText::new(format!(
                                                            "{}  ·  {}",
                                                            track.artist(),
                                                            track.album.name
                                                        ))
                                                        .size(12.0)
                                                        .color(MUTED),
                                                    )
                                                    .truncate(),
                                                );
                                            },
                                        );
                                        ui.label(
                                            RichText::new(time_text(track.duration_ms))
                                                .color(MUTED),
                                        );
                                    });
                                })
                                .response
                                .interact(Sense::click());
                            if response.double_clicked() {
                                self.action(PlayerAction::Play(Some(track.uri.clone())));
                            }
                            response.context_menu(|ui| {
                                if ui.button("Add to playlist…").clicked() {
                                    self.picker = Some(if self.selected.contains(&index) {
                                        self.selected_tracks()
                                    } else {
                                        vec![track.clone()]
                                    });
                                    ui.close();
                                }
                                if ui.button("Add to queue").clicked() {
                                    self.action(PlayerAction::Enqueue(track.uri.clone()));
                                    ui.close();
                                }
                                if ui.button("Save to Liked Songs").clicked() {
                                    self.send(Command::SaveTrack(track.uri.clone()));
                                    ui.close();
                                }
                                ui.separator();
                                if ui.button("Copy song and artist").clicked() {
                                    ui.ctx().copy_text(format!(
                                        "{} - {}",
                                        track.name,
                                        track.artist()
                                    ));
                                    ui.close();
                                }
                                if ui.button("Copy ID").clicked() {
                                    ui.ctx().copy_text(track.id.clone().unwrap_or_default());
                                    ui.close();
                                }
                                if ui.button("Copy clean link").clicked() {
                                    if let Some(id) = &track.id {
                                        ui.ctx().copy_text(format!(
                                            "https://open.spotify.com/track/{id}"
                                        ));
                                    }
                                    ui.close();
                                }
                            });
                        }
                        if self.tracks.is_empty() && !self.loading {
                            ui.add_space(26.0);
                            ui.label(RichText::new("No tracks to show.").color(MUTED));
                        }
                        if self.more && !self.loading && ui.button("Load more").clicked() {
                            self.loading = true;
                            self.send(Command::Tracks {
                                key: self.view.clone(),
                                offset: self.tracks.len(),
                            });
                        }
                    });
            });
    }

    fn selected_tracks(&self) -> Vec<Track> {
        self.tracks
            .iter()
            .enumerate()
            .filter(|(index, _)| self.selected.contains(index))
            .map(|(_, track)| track.clone())
            .collect()
    }

    fn player(&mut self, context: &egui::Context) {
        egui::TopBottomPanel::bottom("player")
            .exact_height(110.0)
            .frame(egui::Frame::new().fill(Color32::BLACK).inner_margin(14))
            .show(context, |ui| {
                ui.horizontal(|ui| {
                    ui.allocate_ui_with_layout(
                        Vec2::new(250.0, 72.0),
                        Layout::left_to_right(Align::Center),
                        |ui| {
                            if let Some(track) = &self.playback.item {
                                artwork(ui, &track.album.images, 58.0);
                                ui.vertical(|ui| {
                                    ui.add(
                                        egui::Label::new(RichText::new(&track.name).strong())
                                            .truncate(),
                                    );
                                    ui.add(
                                        egui::Label::new(
                                            RichText::new(track.artist()).small().color(MUTED),
                                        )
                                        .truncate(),
                                    );
                                });
                            } else {
                                ui.label(RichText::new("Choose something to play").color(MUTED));
                            }
                        },
                    );
                    let center_width = (ui.available_width() - 260.0).max(210.0);
                    ui.allocate_ui_with_layout(
                        Vec2::new(center_width, 78.0),
                        Layout::top_down(Align::Center),
                        |ui| {
                            ui.horizontal(|ui| {
                                ui.add_space((center_width - 300.0).max(0.0) / 2.0);
                                if ui
                                    .selectable_label(self.playback.shuffle_state, "⤨")
                                    .on_hover_text("Shuffle")
                                    .clicked()
                                {
                                    self.action(PlayerAction::Shuffle(
                                        !self.playback.shuffle_state,
                                    ));
                                }
                                if ui.button("◀◀").on_hover_text("Previous").clicked() {
                                    self.action(PlayerAction::Previous);
                                }
                                if ui
                                    .add(primary(if self.playback.is_playing {
                                        "Ⅱ"
                                    } else {
                                        "▶"
                                    }))
                                    .on_hover_text("Play / pause · Space")
                                    .clicked()
                                {
                                    self.toggle_play();
                                }
                                if ui.button("▶▶").on_hover_text("Next").clicked() {
                                    self.action(PlayerAction::Next);
                                }
                                if ui
                                    .selectable_label(
                                        self.playback.repeat_state != "off",
                                        if self.playback.repeat_state == "track" {
                                            "↻1"
                                        } else {
                                            "↻"
                                        },
                                    )
                                    .on_hover_text("Repeat")
                                    .clicked()
                                {
                                    self.action(PlayerAction::Repeat(
                                        match self.playback.repeat_state.as_str() {
                                            "off" => "context",
                                            "context" => "track",
                                            _ => "off",
                                        }
                                        .into(),
                                    ));
                                }
                            });
                            ui.horizontal(|ui| {
                                let duration = self
                                    .playback
                                    .item
                                    .as_ref()
                                    .map_or(0, |track| track.duration_ms);
                                let mut position = self.position() as f64;
                                ui.label(
                                    RichText::new(time_text(position as u64))
                                        .size(12.0)
                                        .color(MUTED),
                                );
                                ui.spacing_mut().slider_width = (center_width - 100.0).max(100.0);
                                let slider = ui.add(
                                    egui::Slider::new(&mut position, 0.0..=duration.max(1) as f64)
                                        .show_value(false),
                                );
                                if slider.drag_stopped() || (slider.changed() && !slider.dragged())
                                {
                                    self.action(PlayerAction::Seek(position as u64));
                                }
                                ui.label(
                                    RichText::new(time_text(duration)).size(12.0).color(MUTED),
                                );
                            });
                        },
                    );
                    ui.vertical(|ui| {
                        ui.horizontal(|ui| {
                            if ui
                                .selectable_label(self.settings.show_lyrics, "Lyrics")
                                .clicked()
                            {
                                self.settings.show_lyrics = !self.settings.show_lyrics;
                                self.dirty = true;
                                if self.settings.show_lyrics && self.lyrics.is_none() {
                                    self.fetch_lyrics();
                                }
                                self.save_settings();
                            }
                            if ui.button("Devices").clicked() {
                                self.devices_open = !self.devices_open;
                                if self.profile.is_some() {
                                    self.send(Command::Refresh);
                                }
                            }
                        });
                        let mut volume = self.playback.device.volume_percent.unwrap_or(50) as f32;
                        ui.spacing_mut().slider_width = 130.0;
                        let slider = ui.add(
                            egui::Slider::new(&mut volume, 0.0..=100.0)
                                .text("Volume")
                                .show_value(false),
                        );
                        if slider.drag_stopped() || (slider.changed() && !slider.dragged()) {
                            self.action(PlayerAction::Volume(volume as u8));
                        }
                    });
                });
            });
    }

    fn toggle_play(&self) {
        self.action(if self.playback.is_playing {
            PlayerAction::Pause
        } else {
            PlayerAction::Play(None)
        });
    }

    fn lyrics_content(&mut self, ui: &mut egui::Ui, expanded: bool) {
        ui.horizontal(|ui| {
            ui.label(RichText::new("Lyrics").size(21.0).strong());
            if ui
                .small_button(if expanded { "Exit cinema" } else { "Expand" })
                .clicked()
            {
                self.cinema = !self.cinema;
            }
            if ui.small_button("↻").clicked() {
                self.fetch_lyrics();
            }
        });
        if let Some(track) = &self.playback.item {
            if !expanded {
                artwork(ui, &track.album.images, ui.available_width().min(240.0));
            }
            ui.label(RichText::new(&track.name).strong().size(18.0));
            ui.label(RichText::new(track.artist()).color(MUTED));
        }
        ui.add_space(14.0);
        if self.lyric_loading {
            ui.horizontal(|ui| {
                ui.spinner();
                ui.label("Finding lyrics…");
            });
        }
        if !self.lyric_error.is_empty() {
            ui.label(RichText::new(&self.lyric_error).color(MUTED));
        }
        if self.lyrics.is_none() && self.playback.item.is_none() {
            ui.label(RichText::new("Lyrics follow the music.").color(MUTED));
        }
        let position = self
            .position()
            .saturating_add_signed(self.settings.lyric_offset_ms);
        let lyrics = self.lyrics.clone();
        if let Some(lyrics) = lyrics {
            ui.label(RichText::new(&lyrics.source).small().color(MUTED));
            if lyrics.instrumental {
                ui.heading("Instrumental");
                return;
            }
            let active = lyrics.active_line(position);
            let changed = self.active_line != active;
            self.active_line = active;
            if !self.follow_lyrics && ui.small_button("Follow lyrics").clicked() {
                self.follow_lyrics = true;
            }
            let scroll = egui::ScrollArea::vertical()
                .id_salt(if expanded {
                    "cinema-lyrics"
                } else {
                    "side-lyrics"
                })
                .show(ui, |ui| {
                    ui.add_space(16.0);
                    for (index, line) in lyrics.lines.iter().enumerate() {
                        let is_active = active == Some(index);
                        let color = if is_active {
                            Color32::WHITE
                        } else {
                            Color32::from_rgb(112, 126, 117)
                        };
                        let size = self.settings.lyric_size
                            * if expanded { 1.4 } else { 1.0 }
                            * if line.background { 0.75 } else { 1.0 };
                        let text = if self.settings.romanized && !line.romanization.is_empty() {
                            &line.romanization
                        } else {
                            &line.text
                        };
                        let response = ui
                            .vertical(|ui| {
                                if is_active && !line.words.is_empty() && !self.settings.romanized {
                                    ui.horizontal_wrapped(|ui| {
                                        ui.spacing_mut().item_spacing.x = 0.0;
                                        for word in &line.words {
                                            let progress = (position.saturating_sub(word.start_ms)
                                                as f32
                                                / word.end_ms.saturating_sub(word.start_ms).max(1)
                                                    as f32)
                                                .clamp(0.0, 1.0);
                                            let color = Color32::from_rgb(
                                                (112.0 + 143.0 * progress) as u8,
                                                (126.0 + 129.0 * progress) as u8,
                                                (117.0 + 138.0 * progress) as u8,
                                            );
                                            ui.label(
                                                RichText::new(&word.text)
                                                    .size(size)
                                                    .strong()
                                                    .color(color),
                                            );
                                        }
                                    });
                                } else {
                                    ui.add(
                                        egui::Label::new(
                                            RichText::new(text).size(size).strong().color(color),
                                        )
                                        .wrap(),
                                    );
                                }
                                if !line.translation.is_empty() {
                                    ui.label(
                                        RichText::new(&line.translation).size(15.0).color(MUTED),
                                    );
                                }
                                ui.add_space(13.0);
                            })
                            .response
                            .interact(Sense::click());
                        if response.clicked() && lyrics.synced {
                            self.action(PlayerAction::Seek(line.start_ms));
                            self.follow_lyrics = true;
                        }
                        if is_active
                            && self.follow_lyrics
                            && (changed || !self.settings.reduce_motion)
                        {
                            response.scroll_to_me_animation(
                                Some(Align::Center),
                                if self.settings.reduce_motion {
                                    egui::style::ScrollAnimation::none()
                                } else {
                                    egui::style::ScrollAnimation::default()
                                },
                            );
                        }
                    }
                    ui.add_space(120.0);
                });
            if ui.input(|input| input.raw_scroll_delta.y != 0.0)
                && scroll
                    .inner_rect
                    .contains(ui.input(|input| input.pointer.hover_pos().unwrap_or_default()))
            {
                self.follow_lyrics = false;
            }
        }
        if self.playback.item.is_some() {
            ui.separator();
            ui.collapsing("Import local lyrics", |ui| {
                ui.add(
                    egui::TextEdit::singleline(&mut self.import_path)
                        .hint_text("Path to .lrc or .ttml file"),
                );
                if ui.button("Import for this track").clicked()
                    && let Some(track) = self.playback.item.clone()
                {
                    self.lyric_loading = true;
                    let _ = self.worker.lyrics.send(LyricCommand::Import(
                        track,
                        PathBuf::from(self.import_path.trim().trim_matches('"')),
                    ));
                }
            });
        }
    }

    fn dialogs(&mut self, context: &egui::Context) {
        if self.settings_open {
            let mut open = true;
            egui::Window::new("Settings").open(&mut open).default_width(560.0).resizable(true).vscroll(true).show(context, |ui| {
                ui.heading("Appearance");
                ui.collapsing("Lyrics provider", |ui| {
                    ui.label(if self.provider_configured { "Private provider configured in operating system credential store." } else { "Configure a private lyrics provider, or import local lyric files." });
                    ui.add(egui::TextEdit::singleline(&mut self.provider_input).password(true).hint_text("HTTPS provider host"));
                    ui.checkbox(&mut self.provider_consent, "Allow Spotify access token to this host");
                    ui.label(RichText::new("Only short-lived access tokens are shared. Refresh tokens stay local. Changing the host requires consent again.").small().color(MUTED));
                    if ui.add_enabled(!self.provider_input.trim().is_empty() && self.provider_consent, egui::Button::new("Save protected provider")).clicked() {
                        let host = std::mem::take(&mut self.provider_input);
                        let _ = self.worker.lyrics.send(LyricCommand::Configure { host, consent: self.provider_consent });
                        self.provider_consent = false;
                    }
                });
                self.dirty |= ui.checkbox(&mut self.settings.compact_library, "Compact library rows").changed();
                self.dirty |= ui.checkbox(&mut self.settings.reduce_motion, "Reduce lyric motion").changed();
                self.dirty |= ui.add(egui::Slider::new(&mut self.settings.lyric_size, 18.0..=60.0).text("Lyric size")).changed();
                self.dirty |= ui.add(egui::Slider::new(&mut self.settings.lyric_offset_ms, -10_000..=10_000).text("Lyric offset (ms)")).changed();
                self.dirty |= ui.checkbox(&mut self.settings.romanized, "Show supplied romanization").changed();
                ui.separator(); ui.heading("Audio");
                ui.label(&self.native_status);
                if self.profile.is_some() && ui.button("Reconnect native audio").clicked() { self.native_id = None; self.native_status = "Connecting…".into(); self.send(Command::RetryAudio); }
                ui.separator(); ui.heading("Playlist folders");
                ui.label("Local folders organize the add-to-playlist picker. Assign playlists below.");
                ui.horizontal(|ui| {
                    ui.add(egui::TextEdit::singleline(&mut self.folder_name).hint_text("New folder name"));
                    if ui.button("Create").clicked() && !self.folder_name.trim().is_empty() {
                        self.settings.folders.push(PlaylistFolder { name: self.folder_name.trim().to_owned(), show_in_picker: true, ..PlaylistFolder::default() });
                        self.folder_name.clear(); self.dirty = true;
                    }
                });
                let mut remove = None;
                for (index, folder) in self.settings.folders.iter_mut().enumerate() {
                    ui.push_id(index, |ui| {
                        ui.collapsing(&folder.name, |ui| {
                            self.dirty |= ui.checkbox(&mut folder.show_in_picker, "Show in playlist picker").changed();
                            for playlist in &self.playlists {
                                let mut included = folder.playlist_ids.contains(&playlist.id);
                                if ui.checkbox(&mut included, &playlist.name).changed() {
                                    folder.playlist_ids.retain(|id| id != &playlist.id);
                                    if included { folder.playlist_ids.push(playlist.id.clone()); }
                                    self.dirty = true;
                                }
                            }
                            if ui.button("Remove folder").clicked() { remove = Some(index); }
                        });
                    });
                }
                if let Some(index) = remove { self.settings.folders.remove(index); self.dirty = true; }
                ui.separator();
                if self.profile.is_some() && ui.button("Sign out").clicked() { self.send(Command::Logout); }
                if self.dirty && ui.add(primary("Save settings")).clicked() { self.save_settings(); }
                if self.config_damaged { ui.label("Settings file is damaged. It has been preserved; repair it before saving new settings."); }
            });
            if !open {
                self.settings_open = false;
                self.save_settings();
            }
        }
        if self.devices_open {
            let mut open = true;
            egui::Window::new("Connect to a device")
                .open(&mut open)
                .resizable(false)
                .default_width(300.0)
                .show(context, |ui| {
                    if let Some(id) = self.native_id.clone() {
                        if ui.button("This computer · SpotiFlex").clicked() {
                            self.selected_device = Some(id.clone());
                            self.action(PlayerAction::Transfer(id));
                            self.devices_open = false;
                        }
                    } else {
                        ui.label(RichText::new(&self.native_status).small().color(MUTED));
                    }
                    for device in self.devices.clone() {
                        let Some(id) = device.id else {
                            continue;
                        };
                        if self.native_id.as_ref() == Some(&id) {
                            continue;
                        }
                        if ui
                            .selectable_label(device.is_active, &device.name)
                            .clicked()
                        {
                            self.selected_device = Some(id.clone());
                            self.action(PlayerAction::Transfer(id));
                            self.devices_open = false;
                        }
                    }
                    if ui.button("Refresh devices").clicked() && self.profile.is_some() {
                        self.send(Command::Refresh);
                    }
                });
            if !open {
                self.devices_open = false;
            }
        }
        if let Some(tracks) = self.picker.clone() {
            let mut open = true;
            egui::Window::new("Add to playlist")
                .open(&mut open)
                .default_width(380.0)
                .vscroll(true)
                .show(context, |ui| {
                    ui.label(format!("{} tracks · duplicates skipped", tracks.len()));
                    ui.add(
                        egui::TextEdit::singleline(&mut self.picker_filter)
                            .hint_text("Find playlist"),
                    );
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
                    for playlist in self.playlists.clone().iter().filter(|playlist| {
                        playlist.editable_by(user)
                            && playlist.name.to_lowercase().contains(&filter)
                            && (visible.is_empty() || visible.contains(&playlist.id))
                    }) {
                        if ui.button(&playlist.name).clicked() {
                            self.send(Command::Add {
                                playlist: playlist.clone(),
                                tracks: tracks.clone(),
                            });
                            self.picker = None;
                        }
                    }
                });
            if !open {
                self.picker = None;
            }
        }
    }
}

impl eframe::App for SpotiFlex {
    fn update(&mut self, context: &egui::Context, _frame: &mut eframe::Frame) {
        self.receive();
        if !context.wants_keyboard_input() {
            if context.input(|input| input.key_pressed(egui::Key::Space)) && self.profile.is_some()
            {
                self.toggle_play();
            }
            if context.input(|input| input.key_pressed(egui::Key::F5)) && self.profile.is_some() {
                self.send(Command::Refresh);
                self.navigate(self.view.clone());
            }
            if context.input(|input| input.key_pressed(egui::Key::Escape)) {
                self.cinema = false;
            }
        }
        self.top_bar(context);
        self.player(context);
        self.sidebar(context);
        if self.settings.show_lyrics && !self.cinema && self.profile.is_some() {
            egui::SidePanel::right("lyrics")
                .resizable(true)
                .default_width(330.0)
                .width_range(260.0..=650.0)
                .frame(
                    egui::Frame::new()
                        .fill(Color32::from_rgb(24, 34, 27))
                        .inner_margin(20)
                        .corner_radius(10),
                )
                .show(context, |ui| {
                    self.lyrics_content(ui, false);
                });
        }
        self.content(context);
        self.dialogs(context);
        if self.profile.is_none() {
            // Deliberately do not act on ModalResponse::should_close(): the
            // initial setup cannot be dismissed until sign-in succeeds.
            egui::Modal::new(egui::Id::new("required-spotify-setup")).show(context, |ui| {
                ui.set_width(650.0_f32.min(context.content_rect().width() - 64.0));
                ui.set_max_height((context.content_rect().height() - 100.0).max(300.0));
                ui.label(
                    RichText::new("Spotify Premium required")
                        .strong()
                        .size(24.0)
                        .color(GREEN),
                );
                ui.label("Complete developer app setup and Spotify sign-in to use SpotiFlex.");
                if !self.notice.is_empty() {
                    ui.label(RichText::new(&self.notice).color(if self.error {
                        Color32::from_rgb(245, 151, 137)
                    } else {
                        MUTED
                    }));
                }
                self.setup(ui);
            });
        }
        if self.playback.is_playing {
            context.request_repaint_after(Duration::from_millis(if self.settings.reduce_motion {
                100
            } else {
                33
            }));
        }
    }

    fn on_exit(&mut self, _gl: Option<&eframe::glow::Context>) {
        self.login_cancelled.store(true, Ordering::Relaxed);
        self.save_settings();
    }
}

fn primary(text: &str) -> egui::Button<'_> {
    egui::Button::new(RichText::new(text).strong().color(Color32::BLACK))
        .fill(GREEN)
        .corner_radius(24)
}

fn artwork(ui: &mut egui::Ui, images: &[crate::model::Artwork], size: f32) {
    if let Some(image) = images
        .first()
        .filter(|image| image.url.starts_with("https://"))
    {
        ui.add(
            egui::Image::new(&image.url)
                .fit_to_exact_size(Vec2::splat(size))
                .corner_radius(5),
        );
    } else {
        let (rectangle, _) = ui.allocate_exact_size(Vec2::splat(size), Sense::hover());
        ui.painter()
            .rect_filled(rectangle, 5, Color32::from_rgb(43, 51, 46));
        ui.painter().text(
            rectangle.center(),
            egui::Align2::CENTER_CENTER,
            "♪",
            FontId::proportional(size * 0.4),
            MUTED,
        );
    }
}

fn brand(ui: &mut egui::Ui, size: f32) {
    let (rectangle, _) = ui.allocate_exact_size(Vec2::splat(size), Sense::hover());
    ui.painter()
        .circle_filled(rectangle.center(), size / 2.0, GREEN);
    for index in 0..3 {
        let y = rectangle.top() + size * (0.31 + index as f32 * 0.18);
        let points = (0..=16)
            .map(|step| {
                let t = step as f32 / 16.0;
                egui::pos2(
                    rectangle.left() + size * (0.22 + t * 0.56),
                    y - (t * std::f32::consts::PI).sin() * size * 0.04,
                )
            })
            .collect();
        ui.painter().add(egui::Shape::line(
            points,
            Stroke::new(size * 0.065, Color32::BLACK),
        ));
    }
}

fn time_text(milliseconds: u64) -> String {
    let seconds = milliseconds / 1000;
    format!("{}:{:02}", seconds / 60, seconds % 60)
}
