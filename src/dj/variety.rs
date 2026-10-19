//! Artist-request ordering, separate from UI and Spotify's playlist transport.
use librespot_protocol::context_track::ContextTrack;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, VecDeque},
    fs,
    sync::Mutex,
    time::{SystemTime, UNIX_EPOCH},
};

static HISTORY_LOCK: Mutex<()> = Mutex::new(());
const KEEP: usize = 6;
#[derive(Default, Serialize, Deserialize)]
struct Recent {
    starts: VecDeque<String>,
    updated: u64,
}
type History = BTreeMap<String, Recent>;
#[derive(Clone)]
pub(crate) struct Selection {
    key: String,
    song: String,
}

fn fold(value: &str) -> String {
    value
        .chars()
        .flat_map(char::to_lowercase)
        .filter(|c| c.is_alphanumeric())
        .collect()
}
fn artist(track: &ContextTrack) -> String {
    track
        .metadata
        .get("artist_name")
        .map(|name| fold(name))
        .unwrap_or_default()
}
fn song(track: &ContextTrack) -> String {
    track
        .metadata
        .get("title")
        .or_else(|| track.metadata.get("track_name"))
        .filter(|name| !name.is_empty() && name.len() <= 240)
        .map(|name| format!("name:{}", fold(name)))
        .unwrap_or_else(|| track.uri.clone().unwrap_or_default())
}
fn requested_artist(prompt: &str, tracks: &[ContextTrack]) -> Option<String> {
    let text = prompt.trim().to_lowercase();
    let raw = text
        .strip_prefix("play ")?
        .trim()
        .trim_end_matches(['.', '!', '?']);
    let mut forms = vec![raw];
    for prefix in ["some ", "music by ", "songs by ", "the artist "] {
        if let Some(value) = raw.strip_prefix(prefix) {
            forms.push(value);
        }
    }
    let variants = forms.clone();
    for value in variants {
        for suffix in [" songs", " music"] {
            if let Some(value) = value.strip_suffix(suffix) {
                forms.push(value);
            }
        }
    }
    forms.into_iter().map(fold).find(|name| {
        !name.is_empty() && {
            let matches = tracks.iter().filter(|track| artist(track) == *name).count();
            matches >= 3 && matches * 2 >= tracks.len()
        }
    })
}
fn history() -> History {
    let Ok(directory) = crate::config::data_dir() else {
        return Default::default();
    };
    let path = directory.join("dj-recent-starts.json");
    if !fs::metadata(&path).is_ok_and(|m| m.len() <= 128_000) {
        return Default::default();
    }
    fs::read(path)
        .ok()
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        .unwrap_or_default()
}
fn order(
    tracks: &mut [ContextTrack],
    requested: &str,
    recent: &VecDeque<String>,
    mut random: impl FnMut(usize) -> usize,
) -> Option<String> {
    let candidates = tracks
        .iter()
        .enumerate()
        .filter(|(_, track)| artist(track) == requested)
        .collect::<Vec<_>>();
    let mut eligible = candidates
        .iter()
        .filter(|(_, track)| !recent.contains(&song(track)))
        .map(|(index, _)| *index)
        .collect::<Vec<_>>();
    if eligible.is_empty() {
        eligible = candidates
            .iter()
            .filter(|(_, track)| recent.front() != Some(&song(track)))
            .map(|(index, _)| *index)
            .collect();
    }
    if eligible.is_empty() {
        eligible = candidates.iter().map(|(index, _)| *index).collect();
    }
    if eligible.is_empty() {
        return None;
    }
    let first = eligible[random(eligible.len()) % eligible.len()];
    tracks.swap(0, first);
    // Move whole track records so their UID and song-specific narration stay together.
    for end in (2..tracks.len()).rev() {
        let index = 1 + random(end) % end;
        tracks.swap(end, index);
    }
    Some(song(&tracks[0]))
}

pub(crate) fn apply(prompt: &str, account: &str, tracks: &mut [ContextTrack]) -> Option<Selection> {
    let requested = requested_artist(prompt, tracks)?;
    let key = format!("{:x}", Sha256::digest(format!("{account}\0{requested}")));
    let mut seed = [0u8; 8];
    getrandom::fill(&mut seed).ok()?;
    let mut state = u64::from_le_bytes(seed).max(1);
    let _guard = HISTORY_LOCK.lock().ok()?;
    let saved = history();
    let recent = saved
        .get(&key)
        .map(|entry| entry.starts.clone())
        .unwrap_or_default();
    let song = order(tracks, &requested, &recent, |limit| {
        state ^= state << 13;
        state ^= state >> 7;
        state ^= state << 17;
        (state % limit as u64) as usize
    })?;
    Some(Selection { key, song })
}
impl Selection {
    /// Called only after the current account's playback command has been queued.
    pub(crate) fn remember(self) {
        let Ok(_guard) = HISTORY_LOCK.lock() else {
            return;
        };
        let mut saved = history();
        let entry = saved.entry(self.key).or_default();
        entry.starts.retain(|song| song != &self.song);
        entry.starts.push_front(self.song);
        entry.starts.truncate(KEEP);
        entry.updated = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs();
        while saved.len() > 128 {
            let Some(oldest) = saved
                .iter()
                .min_by_key(|(_, entry)| entry.updated)
                .map(|(key, _)| key.clone())
            else {
                break;
            };
            saved.remove(&oldest);
        }
        let write = || -> anyhow::Result<()> {
            let directory = crate::config::data_dir()?;
            fs::create_dir_all(&directory)?;
            let temporary = directory.join("dj-recent-starts.json.tmp");
            fs::write(&temporary, serde_json::to_vec(&saved)?)?;
            fs::rename(temporary, directory.join("dj-recent-starts.json"))?;
            Ok(())
        };
        let _ = write();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn tracks() -> Vec<ContextTrack> {
        (0..8)
            .map(|index| ContextTrack {
                uri: Some(format!("spotify:track:{index}")),
                uid: Some(format!("item-{index}")),
                metadata: [
                    ("artist_name".into(), "Example Artist".into()),
                    ("title".into(), format!("Song {index}")),
                    (
                        "narration.intro.ssml".into(),
                        format!("Announce song {index}"),
                    ),
                ]
                .into(),
                ..Default::default()
            })
            .collect()
    }
    #[test]
    fn repeated_artist_requests_avoid_recent_openings_and_preserve_metadata() {
        let original = tracks();
        let mut recent = VecDeque::new();
        for _ in 0..6 {
            let mut page = original.clone();
            let selected = order(&mut page, "exampleartist", &recent, |_| 0).unwrap();
            assert!(!recent.contains(&selected));
            recent.push_front(selected);
            for track in page {
                let expected = original
                    .iter()
                    .find(|candidate| candidate.uri == track.uri)
                    .unwrap();
                assert_eq!(track, *expected);
            }
        }
    }
    #[test]
    fn an_exhausted_pool_still_avoids_the_immediately_previous_song() {
        let mut page = tracks();
        let recent = page.iter().map(song).collect::<VecDeque<_>>();
        order(&mut page, "exampleartist", &recent, |_| 0).unwrap();
        assert_ne!(song(&page[0]), recent[0]);
    }
    #[test]
    fn only_verified_artist_requests_are_reordered() {
        let page = tracks();
        assert_eq!(
            requested_artist("Play Example Artist!", &page),
            Some("exampleartist".into())
        );
        for request in [
            "Play jazz",
            "Play Song 1",
            "Example Artist and other artists",
            "Play another artist",
        ] {
            assert!(requested_artist(request, &page).is_none());
        }
        let mut mixed = page;
        for track in mixed.iter_mut().take(6) {
            track
                .metadata
                .insert("artist_name".into(), "Other Artist".into());
        }
        assert!(requested_artist("Play Example Artist", &mixed).is_none());
    }
}
