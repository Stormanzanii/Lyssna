//! Optional catalogue statistics, enriched independently of playback and browsing.
use crate::{model::Track, native::NativeControls, spotify::Spotify};
use serde::Serialize;
use serde_json::Value;
use std::collections::{HashMap, HashSet};
#[derive(Clone, Default, Serialize)]
pub struct Facts {
    pub plays: Option<u64>,
    pub genres: Vec<String>,
    pub release_date: String,
}
/// Albums fetched at once while enriching.
const ALBUM_FETCHES: usize = 8;

/// One album's facts by song, following its pages. None when it fails.
fn load_album(native: &NativeControls, id: &str) -> Option<HashMap<String, Facts>> {
    let album = native.catalogue("album", id, 0).ok()?;
    let total = album["tracksV2"]["totalCount"].as_u64().unwrap_or_default() as usize;
    let mut offset = album["tracksV2"]["items"].as_array().map_or(0, Vec::len);
    let mut entries = album_facts(&album);
    while offset > 0 && offset < total && offset < 5000 {
        let Ok(page) = native.catalogue("album", id, offset) else {
            break;
        };
        let count = page["tracksV2"]["items"].as_array().map_or(0, Vec::len);
        if count == 0 {
            break;
        }
        let before = entries.len();
        entries.extend(album_facts(&page));
        if before == entries.len() {
            break;
        }
        offset += count;
    }
    Some(entries)
}

#[derive(Default)]
pub struct Catalogue {
    albums: HashMap<String, HashMap<String, Facts>>,
    genres: HashMap<String, Vec<String>>,
}
fn album_facts(album: &Value) -> HashMap<String, Facts> {
    let date = &album["date"];
    let year = date["year"].as_u64();
    let release_date = year
        .map(|year| {
            format!(
                "{year:04}-{:02}-{:02}",
                date["month"].as_u64().unwrap_or(1),
                date["day"].as_u64().unwrap_or(1)
            )
        })
        .unwrap_or_default();
    album["tracksV2"]["items"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|item| {
            let track = &item["track"];
            let uri = track["uri"].as_str()?;
            Some((
                uri.into(),
                Facts {
                    plays: track["playcount"]
                        .as_u64()
                        .or_else(|| track["playcount"].as_str()?.parse().ok()),
                    release_date: release_date.clone(),
                    ..Facts::default()
                },
            ))
        })
        .collect()
}
impl Catalogue {
    pub fn enrich(
        &mut self,
        native: &NativeControls,
        spotify: &mut Spotify,
        tracks: Vec<Track>,
    ) -> HashMap<String, Facts> {
        let mut result = HashMap::new();
        let mut artist_attempts = HashSet::new();
        let mut genre_budget = 3;
        // Albums load several at a time; one by one, a long playlist's
        // release dates and play counts trickled in for a minute.
        let missing: Vec<String> = tracks
            .iter()
            .filter_map(|track| track.album.id.clone())
            .filter(|id| id.len() == 22 && !self.albums.contains_key(id))
            .collect::<HashSet<_>>()
            .into_iter()
            .collect();
        if self.albums.len() + missing.len() > 2048 {
            self.albums.clear();
        }
        for batch in missing.chunks(ALBUM_FETCHES) {
            let loaded: Vec<(String, HashMap<String, Facts>)> = std::thread::scope(|scope| {
                let handles: Vec<_> = batch
                    .iter()
                    .map(|id| scope.spawn(move || (id.clone(), load_album(native, id))))
                    .collect();
                handles
                    .into_iter()
                    .filter_map(|handle| handle.join().ok())
                    .filter_map(|(id, entries)| Some((id, entries?)))
                    .collect()
            });
            self.albums.extend(loaded);
        }
        for track in tracks {
            let mut facts = Facts {
                release_date: track.album.release_date.clone(),
                ..Facts::default()
            };
            if let Some(value) = track
                .album
                .id
                .as_deref()
                .and_then(|id| self.albums.get(id))
                .and_then(|album| album.get(&track.uri))
            {
                facts = value.clone();
            }
            for artist in &track.artists {
                facts.genres.extend(artist.genres.clone());
                if let Some(id) = artist.id.as_deref() {
                    if !self.genres.contains_key(id)
                        && genre_budget > 0
                        && !spotify.cooling_down()
                        && artist_attempts.insert(id.to_owned())
                    {
                        genre_budget -= 1;
                        if let Ok(artist) = spotify.artist(id) {
                            self.genres.insert(id.into(), artist.genres);
                        }
                    }
                    if let Some(genres) = self.genres.get(id) {
                        facts.genres.extend(genres.iter().cloned());
                    }
                }
            }
            facts.genres.sort();
            facts.genres.dedup();
            result.insert(track.uri, facts);
        }
        result
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn unknown_counts_stay_unknown_instead_of_becoming_zero() {
        let facts = album_facts(
            &json!({"date":{"year":2020},"tracksV2":{"items":[{"track":{"uri":"a","playcount":"12345"}},{"track":{"uri":"b"}}]}}),
        );
        assert_eq!(facts["a"].plays, Some(12345));
        assert_eq!(facts["b"].plays, None);
        assert_eq!(facts["a"].release_date, "2020-01-01");
    }
}
