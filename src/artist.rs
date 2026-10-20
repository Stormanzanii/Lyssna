//! Optional artist enrichment from Spotify's public page. No authentication headers.
use crate::model::{Album, Artist, Artwork, Track};
use anyhow::{Context, Result, ensure};
use base64::{Engine, engine::general_purpose::STANDARD};
use reqwest::blocking::Client;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    collections::HashMap,
    io::Read,
    sync::{Mutex, OnceLock},
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

#[derive(Clone, Default, Serialize, Deserialize)]
pub struct ArtistOverview {
    pub monthly_listeners: Option<u64>,
    /// Profile picture, for artists without a header photo.
    #[serde(default)]
    pub avatar_image: Option<String>,
    pub followers: Option<u64>,
    pub header_image: Option<String>,
    pub verified: Option<bool>,
    pub details_loaded: bool,
    pub biography: String,
    pub popular: Vec<PopularTrack>,
    pub source_url: String,
    pub fetched_at: u64,
}
#[derive(Clone, Serialize, Deserialize)]
pub struct PopularTrack {
    pub track: Track,
    pub streams: Option<u64>,
}
type Cache = Mutex<HashMap<String, (Instant, ArtistOverview)>>;
static CACHE: OnceLock<Cache> = OnceLock::new();

pub fn fetch(client: &Client, id: &str) -> Result<ArtistOverview> {
    ensure!(
        id.len() == 22 && id.bytes().all(|byte| byte.is_ascii_alphanumeric()),
        "Invalid artist ID"
    );
    let cache = CACHE.get_or_init(Mutex::default);
    if let Ok(cache) = cache.lock()
        && let Some((when, overview)) = cache.get(id)
        && when.elapsed() < Duration::from_secs(21_600)
    {
        return Ok(overview.clone());
    }
    let mut html = String::new();
    client
        .get(format!("https://open.spotify.com/artist/{id}"))
        .header(reqwest::header::ACCEPT_LANGUAGE, "en-US")
        .timeout(Duration::from_secs(8))
        .send()
        .context("Artist page unavailable")?
        .error_for_status()
        .context("Artist page unavailable")?
        .take(2_000_001)
        .read_to_string(&mut html)?;
    ensure!(html.len() <= 2_000_000, "Artist page too large");
    let overview = parse_page(&html, id)?;
    if let Ok(mut cache) = cache.lock() {
        if cache.len() >= 128 {
            cache.clear();
        }
        cache.insert(id.to_owned(), (Instant::now(), overview.clone()));
    }
    Ok(overview)
}

fn parse_page(html: &str, id: &str) -> Result<ArtistOverview> {
    parse_artist(&page_state(html)?, id)
}
fn page_state(html: &str) -> Result<Value> {
    let start = html
        .find("id=\"initialState\"")
        .context("Artist page data unavailable")?;
    let start = start + html[start..].find('>').context("Invalid artist page")? + 1;
    let end = start
        + html[start..]
            .find("</script>")
            .context("Invalid artist page")?;
    let bytes = STANDARD
        .decode(html[start..end].trim())
        .context("Invalid artist page data")?;
    let data: Value = serde_json::from_slice(&bytes).context("Invalid artist page data")?;
    Ok(data)
}
pub(crate) fn public_entity(client: &Client, kind: &str, id: &str) -> Result<Value> {
    ensure!(
        matches!(kind, "album" | "artist")
            && id.len() == 22
            && id.bytes().all(|byte| byte.is_ascii_alphanumeric()),
        "Invalid catalogue page"
    );
    let mut html = String::new();
    client
        .get(format!("https://open.spotify.com/{kind}/{id}"))
        .header(reqwest::header::ACCEPT_LANGUAGE, "en-US")
        .timeout(Duration::from_secs(8))
        .send()?
        .error_for_status()?
        .take(2_000_001)
        .read_to_string(&mut html)?;
    ensure!(html.len() <= 2_000_000, "Catalogue page too large");
    let mut state = page_state(&html)?;
    let entity = state["entities"]["items"][format!("spotify:{kind}:{id}")].take();
    ensure!(
        entity["uri"].as_str() == Some(format!("spotify:{kind}:{id}").as_str()),
        "Catalogue page does not match request"
    );
    Ok(entity)
}

fn parse_artist(data: &Value, id: &str) -> Result<ArtistOverview> {
    let artist = &data["entities"]["items"][format!("spotify:artist:{id}")];
    from_entity(artist, id)
}
pub(crate) fn basic(client: &Client, id: &str) -> Result<Artist> {
    let entity = public_entity(client, "artist", id)?;
    Ok(Artist {
        id: Some(id.into()),
        uri: format!("spotify:artist:{id}"),
        name: entity["profile"]["name"]
            .as_str()
            .context("Artist name unavailable")?
            .into(),
        monthly_listeners: entity["stats"]["monthlyListeners"].as_u64(),
        images: entity["visuals"]["avatarImage"]["sources"]
            .as_array()
            .map(|items| {
                items
                    .iter()
                    .filter_map(|item| {
                        let url = item["url"].as_str()?.to_owned();
                        url.starts_with("https://").then_some(Artwork {
                            url,
                            width: item["width"]
                                .as_u64()
                                .and_then(|width| width.try_into().ok()),
                        })
                    })
                    .collect()
            })
            .unwrap_or_default(),
        ..Artist::default()
    })
}
pub(crate) fn from_entity(artist: &Value, id: &str) -> Result<ArtistOverview> {
    ensure!(
        artist["uri"].as_str() == Some(format!("spotify:artist:{id}").as_str()),
        "Artist page does not match request"
    );
    let images = |value: &Value| -> Vec<Artwork> {
        value
            .as_array()
            .map(|items| {
                items
                    .iter()
                    .filter_map(|item| {
                        let url = item["url"].as_str()?;
                        if !url.starts_with("https://") {
                            return None;
                        }
                        Some(Artwork {
                            url: url.to_owned(),
                            width: item["width"]
                                .as_u64()
                                .and_then(|width| width.try_into().ok()),
                        })
                    })
                    .collect()
            })
            .unwrap_or_default()
    };
    let popular = artist["discography"]["topTracks"]["items"]
        .as_array()
        .map(|items| {
            items
                .iter()
                .take(10)
                .filter_map(|item| {
                    let value = &item["track"];
                    let uri = value["uri"].as_str()?.strip_prefix("spotify:track:")?;
                    if uri.len() != 22 || !uri.bytes().all(|byte| byte.is_ascii_alphanumeric()) {
                        return None;
                    }
                    let album = &value["albumOfTrack"];
                    let artists = value["artists"]["items"]
                        .as_array()
                        .map(|artists| {
                            artists
                                .iter()
                                .filter_map(|value| {
                                    let uri = value["uri"].as_str()?.to_owned();
                                    let id = uri.strip_prefix("spotify:artist:")?.to_owned();
                                    Some(Artist {
                                        id: Some(id),
                                        uri,
                                        name: value["profile"]["name"].as_str()?.to_owned(),
                                        ..Artist::default()
                                    })
                                })
                                .collect()
                        })
                        .unwrap_or_default();
                    Some(PopularTrack {
                        track: Track {
                            explicit: value["contentRating"]["label"].as_str() == Some("EXPLICIT"),
                            id: Some(uri.into()),
                            uri: format!("spotify:track:{uri}"),
                            name: value["name"].as_str()?.into(),
                            artists,
                            album: Album {
                                id: album["uri"]
                                    .as_str()
                                    .and_then(|uri| uri.strip_prefix("spotify:album:"))
                                    .map(str::to_owned),
                                uri: album["uri"].as_str().unwrap_or_default().into(),
                                name: album["name"].as_str().unwrap_or_default().into(),
                                images: images(&album["coverArt"]["sources"]),
                                ..Album::default()
                            },
                            ..Track::default()
                        },
                        streams: value["playcount"]
                            .as_str()
                            .and_then(|count| count.parse().ok())
                            .or_else(|| value["playcount"].as_u64()),
                    })
                })
                .collect()
        })
        .unwrap_or_default();
    Ok(ArtistOverview {
        details_loaded: false,
        monthly_listeners: artist["stats"]["monthlyListeners"].as_u64(),
        followers: artist["stats"]["followers"].as_u64(),
        avatar_image: artist["visuals"]["avatarImage"]["sources"]
            .as_array()
            .and_then(|items| {
                items
                    .iter()
                    .max_by_key(|image| image["width"].as_u64().unwrap_or_default())
            })
            .and_then(|image| image["url"].as_str())
            .filter(|url| url.starts_with("https://"))
            .map(str::to_owned),
        header_image: artist["headerImage"]["data"]["sources"]
            .as_array()
            .or_else(|| artist["visuals"]["headerImage"]["sources"].as_array())
            .and_then(|items| {
                items.iter().max_by_key(|image| {
                    image["maxWidth"]
                        .as_u64()
                        .or_else(|| image["width"].as_u64())
                        .unwrap_or_default()
                })
            })
            .and_then(|image| image["url"].as_str())
            .filter(|url| url.starts_with("https://"))
            .map(str::to_owned),
        verified: artist["profile"]["verified"]
            .as_bool()
            .or_else(|| artist["profile"]["isVerified"].as_bool()),
        biography: plain_text(
            artist["profile"]["biography"]["text"]
                .as_str()
                .unwrap_or_default(),
        ),
        popular,
        source_url: format!("https://open.spotify.com/artist/{id}"),
        fetched_at: SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs(),
    })
}

fn plain_text(html: &str) -> String {
    let mut inside = false;
    let mut text = String::new();
    for character in html.chars().take(20_000) {
        match character {
            '<' => inside = true,
            '>' => {
                inside = false;
                text.push(' ');
            }
            _ if !inside => text.push(character),
            _ => {}
        }
    }
    text.split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .replace("&amp;", "&")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn desktop_banner_uses_the_current_header_field_and_largest_source() {
        let id = "0123456789abcdefghijkl";
        let entity = json!({"uri":format!("spotify:artist:{id}"),"headerImage":{"data":{"sources":[{"url":"https://i.scdn.co/image/small","maxWidth":640},{"url":"https://i.scdn.co/image/banner","maxWidth":2660}]}},"visuals":{"avatarImage":{"sources":[{"url":"https://i.scdn.co/image/avatar"}]}}});
        assert_eq!(
            from_entity(&entity, id).unwrap().header_image.as_deref(),
            Some("https://i.scdn.co/image/banner")
        );
    }
    #[test]
    fn extracts_only_public_artist_data_and_rejects_other_artists() {
        let id = "0123456789abcdefghijkl";
        let mut data =
            json!({"session":{"accessToken":"never expose this"},"entities":{"items":{}}});
        data["entities"]["items"][format!("spotify:artist:{id}")] = json!({
            "uri":format!("spotify:artist:{id}"),
            "stats":{"monthlyListeners":123456,"followers":1234},
            "profile":{"biography":{"text":"Hello <b>world</b> &amp; music"}},
            "discography":{"topTracks":{"items":[]}}
        });
        data["entities"]["items"][format!("spotify:artist:{id}")]["discography"]["topTracks"]["items"] = json!([{"track":{
            "uri":format!("spotify:track:{id}"),"name":"Test song","playcount":"987654321",
            "artists":{"items":[{"uri":format!("spotify:artist:{id}"),"profile":{"name":"Test artist"}}]},
            "albumOfTrack":{"uri":format!("spotify:album:{id}"),"name":"Test album","coverArt":{"sources":[{"url":"https://i.scdn.co/image/test","width":300}]}}
        }}]);
        let html = format!(
            "<script id=\"initialState\" type=\"text/plain\">{}</script>",
            STANDARD.encode(serde_json::to_vec(&data).unwrap())
        );
        let overview = parse_page(&html, id).unwrap();
        assert_eq!(overview.monthly_listeners, Some(123456));
        assert_eq!(overview.biography, "Hello world & music");
        assert_eq!(overview.popular[0].streams, Some(987654321));
        assert_eq!(overview.popular[0].track.artists[0].name, "Test artist");
        assert_eq!(overview.popular[0].track.album.images.len(), 1);
        assert!(
            !serde_json::to_string(&overview)
                .unwrap()
                .contains("accessToken")
        );
        assert!(parse_page(&html, "abcdefghijkl0123456789").is_err());
    }
}
