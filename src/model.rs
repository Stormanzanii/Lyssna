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
    #[serde(default)]
    pub width: Option<u32>,
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
    #[serde(default)]
    pub display_name: Option<String>,
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

/// Pick the Web API device to play on: the requested ID when Spotify lists
/// it, else this computer's SpotiFlex player (matched by name). With no
/// requested device, fall back to the active device.
pub fn resolve_device(
    devices: &[Device],
    requested: Option<&str>,
    own_name: &str,
) -> Option<String> {
    let listed = |id: &str| {
        devices
            .iter()
            .any(|device| device.id.as_deref() == Some(id))
    };
    requested
        .filter(|id| listed(id))
        .map(str::to_owned)
        .or_else(|| {
            devices
                .iter()
                .find(|device| device.name == own_name)
                .and_then(|device| device.id.clone())
        })
        .or_else(|| {
            if requested.is_some() {
                return None;
            }
            devices
                .iter()
                .find(|device| device.is_active)
                .and_then(|device| device.id.clone())
        })
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

/// Playable URIs around `index` (at most `limit`), with the clicked track's
/// position inside the window. Local files cannot be started through the Web API.
pub fn play_window(tracks: &[Track], index: usize, limit: usize) -> Option<(Vec<String>, usize)> {
    let playable: Vec<(usize, &str)> = tracks
        .iter()
        .enumerate()
        .filter(|(_, track)| {
            track.uri.starts_with("spotify:track:") || track.uri.starts_with("spotify:episode:")
        })
        .map(|(position, track)| (position, track.uri.as_str()))
        .collect();
    let clicked = playable
        .iter()
        .position(|(position, _)| *position == index)?;
    let start = clicked
        .saturating_sub(limit / 5)
        .min(playable.len().saturating_sub(limit));
    let end = (start + limit).min(playable.len());
    Some((
        playable[start..end]
            .iter()
            .map(|(_, uri)| (*uri).to_owned())
            .collect(),
        clicked - start,
    ))
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

    #[test]
    fn device_resolution_prefers_listed_request_then_own_player() {
        let device = |id: &str, name: &str, active: bool| Device {
            id: Some(id.into()),
            name: name.into(),
            is_active: active,
            volume_percent: None,
        };
        let devices = vec![
            device("phone", "Phone", true),
            device("web-id", "SpotiFlex (PC)", false),
        ];
        assert_eq!(
            resolve_device(&devices, Some("phone"), "SpotiFlex (PC)").as_deref(),
            Some("phone")
        );
        // librespot's own ID is not what the Web API lists: match by name.
        assert_eq!(
            resolve_device(&devices, Some("librespot-id"), "SpotiFlex (PC)").as_deref(),
            Some("web-id")
        );
        assert_eq!(
            resolve_device(&devices, None, "SpotiFlex (PC)").as_deref(),
            Some("web-id")
        );
        assert_eq!(
            resolve_device(&devices[..1], None, "SpotiFlex (PC)").as_deref(),
            Some("phone")
        );
        assert_eq!(resolve_device(&[], None, "SpotiFlex (PC)"), None);
    }

    #[test]
    fn waiting_for_native_device_does_not_transfer_playback_to_another_device() {
        let devices = vec![Device {
            id: Some("phone".into()),
            name: "Phone".into(),
            is_active: true,
            volume_percent: None,
        }];
        assert_eq!(
            resolve_device(&devices, Some("not-yet-listed-native-id"), "SpotiFlex (PC)"),
            None
        );
    }

    #[test]
    fn play_window_keeps_clicked_track_and_skips_local_files() {
        let mut tracks: Vec<Track> = (0..10).map(|n| track(&n.to_string())).collect();
        tracks[1].uri = "spotify:local:a".into();
        let (uris, offset) = play_window(&tracks, 6, 5).unwrap();
        assert_eq!(uris.len(), 5);
        assert_eq!(uris[offset], "spotify:track:6");
        assert!(!uris.iter().any(|uri| uri.starts_with("spotify:local")));
        let (uris, offset) = play_window(&tracks, 0, 100).unwrap();
        assert_eq!((uris.len(), offset), (9, 0));
        assert!(play_window(&tracks, 1, 5).is_none());
    }
}
