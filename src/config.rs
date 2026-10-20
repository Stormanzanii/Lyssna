use std::{fs, path::PathBuf};

use anyhow::{Context, Result};
use directories::ProjectDirs;
use serde::{Deserialize, Serialize};

pub const REDIRECT_URI: &str = "http://127.0.0.1:43821/callback";
pub const DASHBOARD_URL: &str = "https://developer.spotify.com/dashboard";

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
    pub canvas_lyrics: bool,
    /// Space Gravity lyrics; replaced the earlier floating lyrics option.
    #[serde(alias = "floating_lyrics")]
    pub space_gravity: bool,
    pub experimental_word_sync: bool,
    /// Lyrics page layout toggles from the lyrics toolbar.
    pub lyrics_hide_artwork: bool,
    pub lyrics_artwork_right: bool,
    pub lyrics_compact: bool,
    pub ui_font: String,
    pub ui_zoom_percent: u16,
    pub lyric_font: String,
    pub volume_percent: u8,
    pub audio_output: Option<String>,
    pub auto_download_updates: bool,
    pub folders: Vec<PlaylistFolder>,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            library_order: Default::default(),
            client_id: String::new(),
            last_view: "home".into(),
            show_lyrics: true,
            compact_library: false,
            lyric_size: 32.0,
            lyric_offset_ms: 0,
            romanized: false,
            reduce_motion: false,
            liquid_glass: false,
            canvas_lyrics: true,
            space_gravity: false,
            experimental_word_sync: false,
            lyrics_hide_artwork: false,
            lyrics_artwork_right: false,
            lyrics_compact: false,
            ui_font: String::new(),
            ui_zoom_percent: 100,
            lyric_font: String::new(),
            volume_percent: 100,
            audio_output: None,
            auto_download_updates: true,
            folders: Vec::new(),
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
        settings.audio_output = settings
            .audio_output
            .filter(|name| crate::audio_output::valid_name(name));
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
    use super::Settings;

    #[test]
    fn saved_floating_lyrics_choice_becomes_space_gravity() {
        let settings: Settings = serde_json::from_str(r#"{"floating_lyrics":true}"#).unwrap();
        assert!(settings.space_gravity);
        assert!(!settings.experimental_word_sync);
        let saved = serde_json::to_value(&settings).unwrap();
        assert_eq!(saved["space_gravity"], true);
        assert!(saved.get("floating_lyrics").is_none());
    }
}
