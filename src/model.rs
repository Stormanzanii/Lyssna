use serde::{Deserialize, Serialize};
use std::collections::HashSet;

#[derive(Clone, Default, Deserialize, Serialize)]
pub struct Artist {
    #[serde(default)]
    pub name: String,
}

#[derive(Clone, Default, Deserialize, Serialize)]
pub struct Artwork {
    pub url: String,
}

#[derive(Clone, Default, Deserialize, Serialize)]
pub struct Album {
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub images: Vec<Artwork>,
}

#[derive(Clone, Default, Deserialize, Serialize)]
pub struct Track {
    pub id: Option<String>,
    #[serde(default)]
    pub uri: String,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub artists: Vec<Artist>,
    #[serde(default)]
    pub album: Album,
    #[serde(default)]
    pub duration_ms: u64,
    #[serde(default)]
    pub is_local: bool,
}

impl Track {
    pub fn artist(&self) -> String {
        self.artists
            .iter()
            .map(|artist| artist.name.as_str())
            .collect::<Vec<_>>()
            .join(", ")
    }

    pub fn addable(&self) -> bool {
        !self.is_local && self.id.is_some() && self.uri.starts_with("spotify:track:")
    }
}

#[derive(Clone, Default, Deserialize)]
pub struct Profile {
    pub id: String,
    pub display_name: Option<String>,
}

#[derive(Clone, Default, Deserialize)]
pub struct Owner {
    #[serde(default)]
    pub id: String,
}

#[derive(Clone, Default, Deserialize)]
pub struct Playlist {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub images: Vec<Artwork>,
    #[serde(default)]
    pub owner: Owner,
    #[serde(default)]
    pub collaborative: bool,
}

impl Playlist {
    pub fn editable_by(&self, user_id: &str) -> bool {
        !user_id.is_empty() && (self.owner.id == user_id || self.collaborative)
    }
}

#[derive(Clone, Default, Deserialize)]
pub struct Device {
    pub id: Option<String>,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub is_active: bool,
    #[serde(default)]
    pub volume_percent: Option<u8>,
}

#[derive(Clone, Default, Deserialize)]
pub struct Playback {
    pub item: Option<Track>,
    #[serde(default)]
    pub is_playing: bool,
    pub progress_ms: Option<u64>,
    #[serde(default)]
    pub shuffle_state: bool,
    #[serde(default)]
    pub repeat_state: String,
    #[serde(default)]
    pub device: Device,
}

/// Preserve selection order, remove existing tracks and duplicates in the selection.
pub fn unique_additions(existing: &HashSet<String>, selected: &[Track]) -> Vec<String> {
    let mut seen = existing.clone();
    selected
        .iter()
        .filter(|track| track.addable())
        .filter_map(|track| seen.insert(track.uri.clone()).then_some(track.uri.clone()))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn track(id: &str) -> Track {
        Track {
            id: Some(id.into()),
            uri: format!("spotify:track:{id}"),
            ..Track::default()
        }
    }

    #[test]
    fn playlist_additions_skip_existing_repeated_and_local_tracks() {
        let existing = HashSet::from(["spotify:track:one".into()]);
        let mut local = track("local");
        local.is_local = true;
        assert_eq!(
            unique_additions(
                &existing,
                &[
                    track("one"),
                    track("two"),
                    track("two"),
                    local,
                    track("three")
                ]
            ),
            vec!["spotify:track:two", "spotify:track:three"]
        );
    }
}
