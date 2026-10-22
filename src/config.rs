use std::{fs, path::PathBuf};

use anyhow::{Context, Result};
use directories::ProjectDirs;
use serde::{Deserialize, Serialize};

pub const REDIRECT_URI: &str = "http://127.0.0.1:43821/callback";
pub const DASHBOARD_URL: &str = "https://developer.spotify.com/dashboard";
/// Song sort choices a playlist, album or Liked Songs page can remember.
pub const SONG_SORTS: [&str; 5] = ["recent", "added_oldest", "newest", "oldest", "popular"];
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
    pub liquid_glass: bool,
    /// Real-time refraction on Liquid Glass controls; uses more GPU.
    pub liquid_glass_refraction: bool,
    pub canvas_lyrics: bool,
    /// Space Gravity lyrics; replaced the earlier floating lyrics option.
    #[serde(alias = "floating_lyrics")]
    pub space_gravity: bool,
    pub experimental_word_sync: bool,
    /// Lyrics page layout toggles from the lyrics toolbar.
    pub lyrics_hide_artwork: bool,
    pub lyrics_artwork_right: bool,
    pub lyrics_compact: bool,
    /// Lyrics display options from Spicy Lyrics' settings panel.
    pub lyrics_right_align: bool,
    pub lyrics_flip_duet: bool,
    pub lyrics_wide_duet: bool,
    pub lyrics_simple: bool,
    pub lyrics_line_hover: bool,
    pub lyrics_early_scroll: bool,
    pub lyrics_hide_year: bool,
    pub lyrics_hide_npv: bool,
    pub lyrics_hide_npv_empty: bool,
    /// Lyrics page background: "animated", "static" or "color".
    pub lyrics_background: String,
    pub lyrics_pinned_footer: PinnedLyricsFooter,
    /// Lyric sources in the order they are tried, and the ones turned off.
    pub lyrics_source_order: Vec<String>,
    pub lyrics_sources_disabled: Vec<String>,
    pub ui_font: String,
    pub ui_zoom_percent: u16,
    pub lyric_font: String,
    pub volume_percent: u8,
    pub audio_output: Option<String>,
    pub auto_download_updates: bool,
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
            liquid_glass: false,
            liquid_glass_refraction: false,
            canvas_lyrics: true,
            space_gravity: false,
            experimental_word_sync: false,
            lyrics_hide_artwork: false,
            lyrics_artwork_right: false,
            lyrics_compact: false,
            lyrics_right_align: false,
            lyrics_flip_duet: false,
            lyrics_wide_duet: true,
            lyrics_simple: false,
            lyrics_line_hover: false,
            lyrics_early_scroll: false,
            lyrics_hide_year: false,
            lyrics_hide_npv: false,
            lyrics_hide_npv_empty: false,
            lyrics_background: "animated".into(),
            lyrics_pinned_footer: PinnedLyricsFooter::Off,
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
            folders: Vec::new(),
            now_playing_open: true,
            song_sorts: Default::default(),
            spotify_plus: SpotifyPlus::default(),
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
    use super::{PinnedLyricsFooter, Settings};

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
    fn saved_floating_lyrics_choice_becomes_space_gravity() {
        let settings: Settings = serde_json::from_str(r#"{"floating_lyrics":true}"#).unwrap();
        assert!(settings.space_gravity);
        assert!(!settings.experimental_word_sync);
        let saved = serde_json::to_value(&settings).unwrap();
        assert_eq!(saved["space_gravity"], true);
        assert!(saved.get("floating_lyrics").is_none());
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
