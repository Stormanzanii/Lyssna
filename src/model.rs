use serde::{Deserialize, Serialize};
use std::collections::HashSet;

#[derive(Clone, Default, Deserialize, Serialize)]
pub struct Artist {
    #[serde(default)]
    pub monthly_listeners: Option<u64>,
    pub id: Option<String>,
    #[serde(default)]
    pub uri: String,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub images: Vec<Artwork>,
    #[serde(default)]
    pub genres: Vec<String>,
    pub followers: Option<Followers>,
}

#[derive(Clone, Default, Deserialize, Serialize)]
pub struct Followers {
    pub total: u64,
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
    pub copyrights: Vec<Copyright>,
    pub id: Option<String>,
    #[serde(default)]
    pub uri: String,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub images: Vec<Artwork>,
    #[serde(default)]
    pub artists: Vec<Artist>,
    #[serde(default)]
    pub release_date: String,
    #[serde(default)]
    pub album_type: String,
    #[serde(default)]
    pub total_tracks: u64,
}
#[derive(Clone, Default, Deserialize, Serialize)]
pub struct Copyright {
    pub text: String,
    #[serde(rename = "type")]
    pub kind: String,
}

#[derive(Clone, Default, Deserialize, Serialize)]
pub struct Track {
    #[serde(default)]
    pub added_at: String,
    #[serde(default)]
    pub explicit: bool,
    #[serde(default)]
    pub songwriters: Vec<String>,
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

#[derive(Clone, Default, Deserialize, Serialize)]
pub struct Profile {
    #[serde(default)]
    pub images: Vec<Artwork>,
    pub id: String,
    pub display_name: Option<String>,
}

#[derive(Clone, Default, Deserialize, Serialize)]
pub struct Owner {
    #[serde(default)]
    pub id: String,
    #[serde(default)]
    pub display_name: Option<String>,
}

#[derive(Clone, Default, Deserialize, Serialize)]
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

#[derive(Clone, Default, Deserialize, Serialize)]
pub struct Device {
    pub id: Option<String>,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub is_active: bool,
    #[serde(default)]
    pub volume_percent: Option<u8>,
}

#[derive(Clone, Default, Deserialize, Serialize)]
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

#[derive(Clone, Default, Serialize)]
pub struct PlaylistDetails {
    pub owner: String,
    pub total_tracks: Option<usize>,
    pub format: String,
}

#[derive(Clone, Default, Serialize)]
pub struct BrowseInfo {
    pub playlist: Option<PlaylistDetails>,
    pub album_details: Option<crate::album::AlbumDetails>,
    pub key: String,
    pub title: String,
    pub subtitle: String,
    pub images: Vec<Artwork>,
    pub artist: Option<Artist>,
    pub album: Option<Album>,
    pub albums: Vec<Album>,
    pub overview: Option<crate::artist::ArtistOverview>,
}

#[derive(Clone, Default, Serialize)]
pub struct PlayingDetails {
    pub artists: Vec<Artist>,
    pub queue: Vec<Track>,
}

impl Playback {
    /// Apply native decoder metadata, retaining richer catalogue fields for the same song.
    pub fn load_native_track(
        &mut self,
        track: Track,
        native_id: Option<&str>,
        own_name: &str,
    ) -> bool {
        self.is_playing = false;
        self.device.name = own_name.into();
        self.device.id = native_id.map(str::to_owned);
        self.device.is_active = true;
        if let Some(current) = self
            .item
            .as_mut()
            .filter(|current| current.uri == track.uri)
        {
            current.duration_ms = track.duration_ms;
            if !track.songwriters.is_empty() {
                current.songwriters = track.songwriters;
            }
            return false;
        }
        self.item = Some(track);
        self.progress_ms = Some(0);
        true
    }
    pub fn keep_native_when_empty(
        &self,
        incoming: &Self,
        native_ready: bool,
        native_name: &str,
    ) -> bool {
        (native_ready || !self.is_playing)
            && self.item.is_some()
            && self.device.name == native_name
            && incoming.item.is_none()
    }
    /// Apply a local player event only to the matching track and device.
    pub fn apply_native_position(
        &mut self,
        native_id: Option<&str>,
        own_name: &str,
        uri: &str,
        position_ms: u64,
        playing: Option<bool>,
    ) -> bool {
        if native_id.is_none()
            || !self.item.as_ref().is_some_and(|track| track.uri == uri)
            || (self.device.id.as_deref() != native_id && self.device.name != own_name)
        {
            return false;
        }
        self.progress_ms = Some(position_ms);
        if let Some(playing) = playing {
            self.is_playing = playing;
        }
        true
    }
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
    #[test]
    fn same_song_takeover_accepts_actual_decoder_position() {
        let track = Track {
            uri: "spotify:track:current".into(),
            ..Track::default()
        };
        let mut playback = Playback {
            item: Some(track.clone()),
            progress_ms: Some(77_000),
            is_playing: true,
            device: Device {
                id: Some("spotify-desktop".into()),
                name: "Spotify".into(),
                ..Device::default()
            },
            ..Playback::default()
        };
        assert!(!playback.load_native_track(track, Some("native-session"), "SpotiFlex"));
        assert!(playback.apply_native_position(
            Some("native-session"),
            "SpotiFlex",
            "spotify:track:current",
            1200,
            Some(true)
        ));
        assert_eq!(playback.progress_ms, Some(1200));
        assert_eq!(playback.device.name, "SpotiFlex");
    }

    #[test]
    fn pause_event_updates_web_api_device_alias_without_waiting_for_poll() {
        let mut playback = Playback {
            item: Some(Track {
                uri: "spotify:track:current".into(),
                ..Track::default()
            }),
            is_playing: true,
            device: Device {
                id: Some("web-api-id".into()),
                name: "SpotiFlex (PC)".into(),
                ..Device::default()
            },
            ..Playback::default()
        };
        assert!(playback.apply_native_position(
            Some("session-id"),
            "SpotiFlex (PC)",
            "spotify:track:current",
            1234,
            Some(false)
        ));
        assert!(!playback.is_playing);
        assert_eq!(playback.progress_ms, Some(1234));
        playback.device.name = "Phone".into();
        assert!(!playback.apply_native_position(
            Some("session-id"),
            "SpotiFlex (PC)",
            "spotify:track:current",
            9999,
            Some(true)
        ));
        assert!(!playback.is_playing);
    }

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
