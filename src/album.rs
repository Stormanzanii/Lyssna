use crate::model::{Album, Artwork, Copyright};
use anyhow::Result;
use reqwest::blocking::Client;
use serde::Serialize;
use serde_json::Value;
use std::collections::HashMap;

#[derive(Clone, Default, Serialize)]
pub struct AlbumDetails {
    pub streams: HashMap<String, u64>,
    pub duration_ms: u64,
    pub complete_duration: bool,
    pub copyrights: Vec<Copyright>,
    pub more: Vec<Album>,
}
pub fn fetch(client: &Client, id: &str) -> Result<AlbumDetails> {
    Ok(parse(&crate::artist::public_entity(client, "album", id)?))
}
fn parse(album: &Value) -> AlbumDetails {
    let mut details = AlbumDetails::default();
    if let Some(items) = album["tracksV2"]["items"].as_array() {
        details.complete_duration =
            album["tracksV2"]["totalCount"].as_u64() == Some(items.len() as u64);
        for item in items {
            let track = &item["track"];
            details.duration_ms += track["duration"]["totalMilliseconds"]
                .as_u64()
                .unwrap_or_default();
            if let (Some(uri), Some(count)) = (
                track["uri"].as_str(),
                track["playcount"]
                    .as_u64()
                    .or_else(|| track["playcount"].as_str()?.parse().ok()),
            ) {
                details.streams.insert(uri.into(), count);
            }
        }
    }
    details.copyrights =
        serde_json::from_value(album["copyright"]["items"].clone()).unwrap_or_default();
    if let Some(artists) = album["moreAlbumsByArtist"]["items"].as_array() {
        for artist in artists {
            if let Some(albums) = artist["discography"]["popularReleasesAlbums"]["items"].as_array()
            {
                for album in albums {
                    let Some(uri) = album["uri"]
                        .as_str()
                        .filter(|uri| uri.starts_with("spotify:album:"))
                    else {
                        continue;
                    };
                    if details.more.iter().any(|item| item.uri == uri) {
                        continue;
                    }
                    details.more.push(Album {
                        id: uri.rsplit(':').next().map(str::to_owned),
                        uri: uri.into(),
                        name: album["name"].as_str().unwrap_or_default().into(),
                        release_date: album["date"]["year"]
                            .as_u64()
                            .map(|year| year.to_string())
                            .unwrap_or_default(),
                        album_type: album["type"].as_str().unwrap_or("album").to_lowercase(),
                        images: album["coverArt"]["sources"]
                            .as_array()
                            .map(|images| {
                                images
                                    .iter()
                                    .filter_map(|image| {
                                        let url = image["url"].as_str()?.to_owned();
                                        url.starts_with("https://").then_some(Artwork {
                                            url,
                                            width: image["width"]
                                                .as_u64()
                                                .and_then(|width| width.try_into().ok()),
                                        })
                                    })
                                    .collect()
                            })
                            .unwrap_or_default(),
                        ..Album::default()
                    });
                }
            }
        }
    }
    details
}
#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn preserves_real_counts_and_missing_counts_separately() {
        let result = parse(
            &json!({"tracksV2":{"totalCount":2,"items":[{"track":{"uri":"spotify:track:one","duration":{"totalMilliseconds":1000},"playcount":"1234"}},{"track":{"uri":"spotify:track:two","duration":{"totalMilliseconds":2000}}}]},"copyright":{"items":[{"text":"© Label","type":"C"}]}}),
        );
        assert_eq!(result.streams.len(), 1);
        assert_eq!(result.streams["spotify:track:one"], 1234);
        assert_eq!(result.duration_ms, 3000);
        assert!(result.complete_duration);
        assert_eq!(result.copyrights[0].text, "© Label");
    }
}
