//! Optional catalogue statistics, enriched independently of playback and browsing.
use crate::{api::Spotify, model::Track, native::NativeControls};
use serde::Serialize;
use serde_json::Value;
use std::collections::{HashMap, HashSet};
#[derive(Clone, Default, Serialize)]
pub struct Facts {
    pub plays: Option<u64>,
    pub genres: Vec<String>,
    pub release_date: String,
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
        let mut attempted = HashSet::new();
        for track in tracks {
            let mut facts = Facts {
                release_date: track.album.release_date.clone(),
                ..Facts::default()
            };
            if let Some(id) = track.album.id.as_deref().filter(|id| id.len() == 22) {
                if !self.albums.contains_key(id)
                    && attempted.insert(id.to_owned())
                    && let Ok(album) = native.catalogue("album", id, 0)
                {
                    let total =
                        album["tracksV2"]["totalCount"].as_u64().unwrap_or_default() as usize;
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
                    if self.albums.len() >= 512 {
                        self.albums.clear();
                    }
                    self.albums.insert(id.into(), entries);
                }
                if let Some(value) = self.albums.get(id).and_then(|album| album.get(&track.uri)) {
                    facts = value.clone();
                }
            }
            for artist in &track.artists {
                facts.genres.extend(artist.genres.clone());
                if let Some(id) = artist.id.as_deref() {
                    let genres = self.genres.entry(id.into()).or_insert_with(|| {
                        spotify
                            .artist(id)
                            .map(|artist| artist.genres)
                            .unwrap_or_default()
                    });
                    facts.genres.extend(genres.iter().cloned());
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
