use std::{fs, path::PathBuf};

use anyhow::{Context, Result};
use directories::ProjectDirs;
use serde::{Deserialize, Serialize};

pub const REDIRECT_URI: &str = "http://127.0.0.1:43821/callback";
pub const DASHBOARD_URL: &str = "https://developer.spotify.com/dashboard";
/// Song sort choices a playlist, album or Liked Songs page can remember.
pub const SONG_SORTS: [&str; 9] = [
    "recent",
    "added_oldest",
    "newest",
    "oldest",
    "popular",
    "title_asc",
    "title_desc",
    "album_asc",
    "album_desc",
];
pub const MAX_SONG_SORTS: usize = 500;

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PinnedLyricsFooter {
    NoWriters,
    Full,
    #[default]
    #[serde(other)]
    Off,
}

/// What full screen lyrics keep on screen while the rest hides on idle:
/// the fork's Always Show In Fullscreen.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FullscreenAlwaysShow {
    Controls,
    Time,
    Both,
    #[default]
    #[serde(other)]
    None,
}

/// Where full screen lyrics put a volume slider: the fork's Fullscreen
/// Volume Slider.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FullscreenVolume {
    Left,
    Right,
    Below,
    #[default]
    #[serde(other)]
    Off,
}

/// Keep remembered sorts that name a known choice for a short page key,
/// capped so the settings file stays small.
pub fn clean_song_sorts(sorts: &mut std::collections::BTreeMap<String, String>) {
    sorts.retain(|key, sort| {
        !key.is_empty()
            && key.len() <= 80
            && key.bytes().all(|byte| byte.is_ascii_graphic())
            && SONG_SORTS.contains(&sort.as_str())
    });
    while sorts.len() > MAX_SONG_SORTS {
        sorts.pop_last();
    }
}

/// Animator preset and Custom tuning, as the Spicy Lyrics fork's Animator
/// Behavior panel. The frontend validates values; this keeps the file bounded.
#[derive(Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct LyricsAnimator {
    pub preset: String,
    pub detail: String,
    pub custom: std::collections::BTreeMap<String, f64>,
    pub saved: Vec<SavedAnimatorPreset>,
    pub selected: Option<String>,
}

#[derive(Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct SavedAnimatorPreset {
    pub id: String,
    pub name: String,
    pub values: std::collections::BTreeMap<String, f64>,
}

impl Default for LyricsAnimator {
    fn default() -> Self {
        Self {
            preset: "Default".into(),
            detail: "Basic".into(),
            custom: Default::default(),
            saved: Vec::new(),
            selected: None,
        }
    }
}

const ANIMATOR_VALUES: usize = 32;
const ANIMATOR_PRESETS: usize = 200;
/// The built-in saved-preset choice holding upstream values.
const DEFAULT_ANIMATOR_PRESET: &str = "default";

fn clean_animator_values(values: &mut std::collections::BTreeMap<String, f64>) {
    values.retain(|key, value| {
        !key.is_empty()
            && key.len() <= 32
            && key.bytes().all(|byte| byte.is_ascii_alphanumeric())
            && value.is_finite()
    });
    while values.len() > ANIMATOR_VALUES {
        values.pop_last();
    }
}

impl LyricsAnimator {
    pub fn clean(&mut self) {
        if !["Default", "Custom"].contains(&self.preset.as_str()) {
            self.preset = "Default".into();
        }
        if !["Basic", "Advanced", "Full", "Full + Extras"].contains(&self.detail.as_str()) {
            self.detail = "Basic".into();
        }
        clean_animator_values(&mut self.custom);
        self.saved.retain(|preset| {
            !preset.id.is_empty()
                && preset.id.len() <= 64
                && !preset.name.trim().is_empty()
                && preset.name.chars().count() <= 80
        });
        self.saved.truncate(ANIMATOR_PRESETS);
        for preset in &mut self.saved {
            clean_animator_values(&mut preset.values);
        }
        if self.selected.as_ref().is_some_and(|id| {
            id != DEFAULT_ANIMATOR_PRESET && !self.saved.iter().any(|preset| &preset.id == id)
        }) {
            self.selected = None;
        }
    }
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct Settings {
    pub library_order: std::collections::BTreeMap<String, LibraryOrder>,
    pub client_id: String,
    pub last_view: String,
    pub show_lyrics: bool,
    pub compact_library: bool,
    pub lyric_size: f32,
    pub lyric_offset_ms: i64,
    pub romanized: bool,
    pub reduce_motion: bool,
    /// The lyrics page artwork crossfades when the song changes.
    pub cover_animation: bool,
    pub liquid_glass: bool,
    pub canvas_lyrics: bool,
    /// Space Gravity lyrics; replaced the earlier floating lyrics option.
    #[serde(alias = "floating_lyrics")]
    pub space_gravity: bool,
    /// Translations bundled with lyrics; hidden unless asked for.
    pub lyrics_translations: bool,
    pub experimental_word_sync: bool,
    /// Lyrics page layout toggles from the lyrics toolbar.
    pub lyrics_hide_artwork: bool,
    pub lyrics_artwork_right: bool,
    pub lyrics_compact: bool,
    /// The lyrics toolbar sits at the bottom of the page instead of the top.
    pub lyrics_toolbar_bottom: bool,
    /// Lyrics display options from Spicy Lyrics' settings panel.
    pub lyrics_right_align: bool,
    pub lyrics_flip_duet: bool,
    pub lyrics_wide_duet: bool,
    /// Credits sit on the side of the song's last lead line.
    pub lyrics_credits_follow: bool,
    pub lyrics_simple: bool,
    /// In full screen, sung lines fade away and the rest dim, as in Spicy
    /// Lyrics' Minimal Lyrics Mode.
    pub lyrics_minimal: bool,
    pub lyrics_line_hover: bool,
    /// Placeholder lines while lyrics load, instead of a message.
    pub lyrics_skeleton: bool,
    pub lyrics_early_scroll: bool,
    /// How far ahead Early scroll moves, in milliseconds: 0 to 800.
    pub lyrics_early_scroll_ms: u16,
    pub lyrics_hide_year: bool,
    pub lyrics_hide_npv: bool,
    pub lyrics_hide_npv_empty: bool,
    /// Lyrics page background: "animated", "static" or "color".
    pub lyrics_background: String,
    pub lyrics_pinned_footer: PinnedLyricsFooter,
    pub fullscreen_always_show: FullscreenAlwaysShow,
    pub fullscreen_volume: FullscreenVolume,
    /// Lyrics slide down out of view before full screen closes.
    pub fullscreen_animate_close: bool,
    pub lyrics_animator: LyricsAnimator,
    /// Lyric sources in the order they are tried, and the ones turned off.
    pub lyrics_source_order: Vec<String>,
    pub lyrics_sources_disabled: Vec<String>,
    pub ui_font: String,
    pub ui_zoom_percent: u16,
    pub lyric_font: String,
    pub volume_percent: u8,
    pub audio_output: Option<String>,
    pub auto_download_updates: bool,
    /// The close button hides SpotiFlex to the notification area and music
    /// keeps playing; Quit in the tray menu exits. Off by default. Replaces
    /// an earlier `close_to_tray` that was on by default.
    pub keep_playing_on_close: bool,
    /// Songs overlap when one runs into the next, as Spotify's Crossfade
    /// songs: off by default, 1 to 12 seconds, 5 unless chosen.
    pub crossfade: bool,
    pub crossfade_seconds: u8,
    /// Community lyrics credit people by Discord username, not display name.
    pub lyrics_discord_usernames: bool,
    pub folders: Vec<PlaylistFolder>,
    /// Whether the Now playing panel is open, kept across restarts.
    pub now_playing_open: bool,
    /// Song sort chosen per page (route key); pages missing use playlist order.
    pub song_sorts: std::collections::BTreeMap<String, String>,
    /// Interface options modelled on the Spotify+ extension.
    pub spotify_plus: SpotifyPlus,
}

/// Spotify+ options. Older hide-menu fields in saved settings are ignored.
#[derive(Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct SpotifyPlus {
    /// Spotify folder IDs whose playlists Add to playlist offers; empty
    /// offers every editable playlist.
    pub playlist_folders: Vec<String>,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            library_order: Default::default(),
            client_id: String::new(),
            last_view: "home".into(),
            show_lyrics: true,
            compact_library: false,
            lyric_size: 36.0,
            lyric_offset_ms: 0,
            romanized: false,
            reduce_motion: false,
            cover_animation: true,
            liquid_glass: false,
            canvas_lyrics: true,
            space_gravity: false,
            lyrics_translations: false,
            experimental_word_sync: false,
            lyrics_hide_artwork: false,
            lyrics_artwork_right: false,
            lyrics_compact: false,
            lyrics_toolbar_bottom: false,
            lyrics_right_align: false,
            lyrics_flip_duet: false,
            lyrics_wide_duet: true,
            lyrics_credits_follow: false,
            lyrics_simple: false,
            lyrics_minimal: false,
            lyrics_line_hover: false,
            lyrics_skeleton: true,
            lyrics_early_scroll: false,
            lyrics_early_scroll_ms: 250,
            lyrics_hide_year: false,
            lyrics_hide_npv: false,
            lyrics_hide_npv_empty: false,
            lyrics_background: "animated".into(),
            lyrics_pinned_footer: PinnedLyricsFooter::Off,
            fullscreen_always_show: FullscreenAlwaysShow::None,
            fullscreen_volume: FullscreenVolume::Off,
            fullscreen_animate_close: false,
            lyrics_source_order: crate::lyric_sources::DEFAULT_ORDER
                .iter()
                .map(|id| (*id).into())
                .collect(),
            lyrics_sources_disabled: crate::lyric_sources::DEFAULT_DISABLED
                .iter()
                .map(|id| (*id).into())
                .collect(),
            ui_font: String::new(),
            ui_zoom_percent: 100,
            lyric_font: String::new(),
            volume_percent: 100,
            audio_output: None,
            auto_download_updates: true,
            keep_playing_on_close: false,
            crossfade: false,
            crossfade_seconds: 5,
            lyrics_discord_usernames: true,
            folders: Vec::new(),
            now_playing_open: true,
            song_sorts: Default::default(),
            spotify_plus: SpotifyPlus::default(),
            lyrics_animator: LyricsAnimator::default(),
        }
    }
}

#[derive(Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct LibraryOrder {
    pub pinned: Vec<String>,
    pub recent: Vec<String>,
    pub items: Vec<crate::model::Playlist>,
}

#[derive(Clone, Default, Serialize, Deserialize)]
pub struct PlaylistFolder {
    pub name: String,
    pub playlist_ids: Vec<String>,
    pub show_in_picker: bool,
}

pub fn data_dir() -> Result<PathBuf> {
    let dirs = ProjectDirs::from("", "", "SpotiFlex")
        .context("Cannot locate SpotiFlex application data directory")?;
    Ok(dirs.config_dir().to_path_buf())
}

impl Settings {
    /// Crossfade length in seconds, or 0 while Crossfade songs is off.
    pub fn active_crossfade_seconds(&self) -> u8 {
        if self.crossfade {
            self.crossfade_seconds.clamp(1, 12)
        } else {
            0
        }
    }
    /// Keeps Spicy Lyrics display options inside the ranges Settings offers.
    pub fn clean_lyrics_options(&mut self) {
        self.lyrics_early_scroll_ms = self.lyrics_early_scroll_ms.min(800);
    }
    pub fn load() -> Result<Self> {
        let path = data_dir()?.join("settings.json");
        let mut settings: Self = if path.exists() {
            serde_json::from_slice(&fs::read(&path)?)
                .context("Cannot read settings.json; existing file was preserved")?
        } else {
            Self::default()
        };
        if settings.client_id.is_empty() {
            settings.client_id = std::env::var("SPOTIFY_CLIENT_ID").unwrap_or_default();
        }
        settings.lyric_size = settings.lyric_size.clamp(18.0, 60.0);
        settings.ui_zoom_percent = settings.ui_zoom_percent.clamp(75, 200);
        settings.lyric_offset_ms = settings.lyric_offset_ms.clamp(-10_000, 10_000);
        settings.clean_lyrics_options();
        if !["animated", "static", "color"].contains(&settings.lyrics_background.as_str()) {
            settings.lyrics_background = "animated".into();
        }
        settings.lyrics_source_order = crate::lyric_sources::migrate(
            &settings.lyrics_source_order,
            &mut settings.lyrics_sources_disabled,
        );
        settings.audio_output = settings
            .audio_output
            .filter(|name| crate::audio_output::valid_name(name));
        clean_song_sorts(&mut settings.song_sorts);
        settings.lyrics_animator.clean();
        Ok(settings)
    }

    pub fn save(&self) -> Result<()> {
        anyhow::ensure!(
            self.audio_output
                .as_deref()
                .is_none_or(crate::audio_output::valid_name),
            "Choose a valid audio output"
        );
        anyhow::ensure!(self.library_order.len() <= 16, "Too many library accounts");
        for order in self.library_order.values() {
            anyhow::ensure!(
                order.pinned.len() <= 3 && order.recent.len() <= 40 && order.items.len() <= 43,
                "Library order exceeds limits"
            );
            anyhow::ensure!(order.pinned.iter().chain(order.recent.iter()).chain(order.items.iter().map(|item|&item.id)).all(|id|id.len()==22&&id.bytes().all(|byte|byte.is_ascii_alphanumeric())),"Invalid playlist ID in library order");
        }
        let directory = data_dir()?;
        fs::create_dir_all(&directory)?;
        let temporary = directory.join("settings.json.tmp");
        fs::write(&temporary, serde_json::to_vec_pretty(self)?)?;
        fs::rename(temporary, directory.join("settings.json"))
            .context("Cannot save SpotiFlex settings")
    }
}

pub fn valid_client_id(value: &str) -> bool {
    value.len() == 32 && value.bytes().all(|byte| byte.is_ascii_hexdigit())
}

#[cfg(test)]
mod tests {
    use super::{
        FullscreenAlwaysShow, FullscreenVolume, LyricsAnimator, PinnedLyricsFooter, Settings,
    };

    #[test]
    fn pinned_lyrics_footer_survives_settings_restore_and_unknown_modes() {
        for (value, expected) in [
            ("off", PinnedLyricsFooter::Off),
            ("no_writers", PinnedLyricsFooter::NoWriters),
            ("full", PinnedLyricsFooter::Full),
            ("unknown", PinnedLyricsFooter::Off),
        ] {
            let settings: Settings = serde_json::from_value(serde_json::json!({
                "lyrics_pinned_footer": value
            }))
            .unwrap();
            assert_eq!(settings.lyrics_pinned_footer, expected);
            let restored: Settings =
                serde_json::from_value(serde_json::to_value(settings).unwrap()).unwrap();
            assert_eq!(restored.lyrics_pinned_footer, expected);
        }
        let older: Settings = serde_json::from_str("{}").unwrap();
        assert_eq!(older.lyrics_pinned_footer, PinnedLyricsFooter::Off);
    }

    #[test]
    fn animator_settings_keep_known_presets_and_bounded_values() {
        let mut settings: Settings = serde_json::from_str(
            r#"{"lyrics_animator":{"preset":"Pixel","detail":"Full + Extras",
            "custom":{"wordPeakScale":1.2,"bad key":2},
            "saved":[{"id":"a","name":"Mine","values":{"glowStrength":2}},{"id":"","name":"x"}],
            "selected":"gone"}}"#,
        )
        .unwrap();
        settings.lyrics_animator.clean();
        let animator = &settings.lyrics_animator;
        assert_eq!(animator.preset, "Default");
        assert_eq!(animator.detail, "Full + Extras");
        assert_eq!(animator.custom.len(), 1);
        assert_eq!(animator.saved.len(), 1);
        assert_eq!(animator.selected, None);
        assert_eq!(Settings::default().lyrics_animator.preset, "Default");
        let mut chosen = LyricsAnimator {
            selected: Some("default".into()),
            ..LyricsAnimator::default()
        };
        chosen.clean();
        assert_eq!(chosen.selected.as_deref(), Some("default"));
    }

    #[test]
    fn saved_floating_lyrics_choice_becomes_space_gravity() {
        let settings: Settings = serde_json::from_str(r#"{"floating_lyrics":true}"#).unwrap();
        assert!(settings.space_gravity);
        assert!(!settings.experimental_word_sync);
        let saved = serde_json::to_value(&settings).unwrap();
        assert_eq!(saved["space_gravity"], true);
        assert!(saved.get("floating_lyrics").is_none());
    }

    #[test]
    fn lyrics_options_default_like_spicy_lyrics_and_stay_in_range() {
        let older: Settings = serde_json::from_str("{}").unwrap();
        assert_eq!(older.lyrics_early_scroll_ms, 250);
        assert!(older.lyrics_skeleton);
        assert!(older.cover_animation);
        assert_eq!(older.fullscreen_always_show, FullscreenAlwaysShow::None);
        let chosen: Settings =
            serde_json::from_str(r#"{"fullscreen_always_show":"both"}"#).unwrap();
        assert_eq!(chosen.fullscreen_always_show, FullscreenAlwaysShow::Both);
        let unknown: Settings =
            serde_json::from_str(r#"{"fullscreen_always_show":"all"}"#).unwrap();
        assert_eq!(unknown.fullscreen_always_show, FullscreenAlwaysShow::None);
        assert_eq!(older.fullscreen_volume, FullscreenVolume::Off);
        let below: Settings = serde_json::from_str(r#"{"fullscreen_volume":"below"}"#).unwrap();
        assert_eq!(below.fullscreen_volume, FullscreenVolume::Below);
        let mut wild: Settings =
            serde_json::from_str(r#"{"lyrics_early_scroll_ms":5000}"#).unwrap();
        wild.clean_lyrics_options();
        assert_eq!(wild.lyrics_early_scroll_ms, 800);
    }

    #[test]
    fn older_settings_keep_now_playing_open_and_default_sorts() {
        let settings: Settings = serde_json::from_str("{}").unwrap();
        assert!(settings.now_playing_open);
        assert!(settings.song_sorts.is_empty());
    }

    #[test]
    fn song_sorts_keep_only_known_choices_within_limits() {
        let mut sorts = std::collections::BTreeMap::from([
            ("playlist:abc".to_owned(), "recent".to_owned()),
            ("liked".to_owned(), "bogus".to_owned()),
            ("x".repeat(200), "recent".to_owned()),
        ]);
        super::clean_song_sorts(&mut sorts);
        assert_eq!(sorts.len(), 1);
        assert_eq!(sorts["playlist:abc"], "recent");
        let mut many: std::collections::BTreeMap<_, _> = (0..900)
            .map(|index| (format!("playlist:{index}"), "popular".to_owned()))
            .collect();
        super::clean_song_sorts(&mut many);
        assert_eq!(many.len(), super::MAX_SONG_SORTS);
    }
}
