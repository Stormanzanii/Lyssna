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
    /// Spotify's worldwide listener rank, when ranked.
    #[serde(default)]
    pub world_rank: Option<u64>,
    /// A large artist photo for the About card.
    #[serde(default)]
    pub gallery_image: Option<String>,
    /// Every gallery photo, for the About window.
    #[serde(default)]
    pub gallery: Vec<String>,
    /// Cities with the most listeners.
    #[serde(default)]
    pub top_cities: Vec<TopCity>,
    /// The biography with Spotify's links kept, for the About window.
    #[serde(default)]
    pub biography_html: String,
    /// The item the artist pinned to their page ("Artist pick").
    #[serde(default)]
    pub pick: Option<crate::home::HomeItem>,
    /// Featuring, Discovered on, Artist Playlists, Fans also like, Appears On.
    #[serde(default)]
    pub sections: Vec<crate::home::HomeSection>,
    pub source_url: String,
    pub fetched_at: u64,
}
#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct TopCity {
    pub city: String,
    pub country: String,
    pub listeners: u64,
}
#[derive(Clone, Serialize, Deserialize)]
pub struct PopularTrack {
    pub track: Track,
    pub streams: Option<u64>,
}
type Cache = Mutex<HashMap<String, (Instant, ArtistOverview)>>;
static CACHE: OnceLock<Cache> = OnceLock::new();

fn saved_path(id: &str) -> Option<std::path::PathBuf> {
    let valid = id.len() == 22 && id.bytes().all(|byte| byte.is_ascii_alphanumeric());
    valid
        .then(|| crate::config::data_dir().ok())
        .flatten()
        .map(|dir| dir.join("artists").join(format!("{id}.json")))
}

/// The artist's overview from the last visit, of any age: shown at once
/// (for example in Now playing after a restart) while `fetch` refreshes it.
pub fn saved(id: &str) -> Option<ArtistOverview> {
    serde_json::from_slice(&std::fs::read(saved_path(id)?).ok()?).ok()
}

fn save(id: &str, overview: &ArtistOverview) {
    if let Some(path) = saved_path(id)
        && path
            .parent()
            .is_some_and(|dir| std::fs::create_dir_all(dir).is_ok())
        && let Ok(bytes) = serde_json::to_vec(overview)
    {
        let _ = std::fs::write(path, bytes);
    }
}

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
    save(id, &overview);
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

/// Spotify moved the verified flag; read the current place first.
fn verified(artist: &Value) -> Option<bool> {
    artist["onPlatformReputationTrait"]["verification"]["isVerified"]
        .as_bool()
        .or_else(|| artist["profile"]["verified"].as_bool())
        .or_else(|| artist["profile"]["isVerified"].as_bool())
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
        verified: verified(artist),
        biography: plain_text(
            artist["profile"]["biography"]["text"]
                .as_str()
                .unwrap_or_default(),
        ),
        popular,
        world_rank: artist["stats"]["worldRank"]
            .as_u64()
            .filter(|rank| *rank > 0),
        gallery_image: artist["visuals"]["gallery"]["items"][0]["sources"]
            .as_array()
            .and_then(|items| {
                items
                    .iter()
                    .max_by_key(|image| image["width"].as_u64().unwrap_or_default())
            })
            .and_then(|image| image["url"].as_str())
            .filter(|url| url.starts_with("https://"))
            .map(larger_gallery_photo),
        sections: related_sections(artist),
        pick: artist_pick(&artist["profile"]["pinnedItem"]),
        gallery: artist["visuals"]["gallery"]["items"]
            .as_array()
            .map(Vec::as_slice)
            .unwrap_or_default()
            .iter()
            .take(30)
            .filter_map(|item| {
                item["sources"]
                    .as_array()?
                    .iter()
                    .max_by_key(|image| image["width"].as_u64().unwrap_or_default())?["url"]
                    .as_str()
                    .filter(|url| url.starts_with("https://"))
                    .map(larger_gallery_photo)
            })
            .collect(),
        top_cities: artist["stats"]["topCities"]["items"]
            .as_array()
            .map(Vec::as_slice)
            .unwrap_or_default()
            .iter()
            .take(5)
            .filter_map(|item| {
                Some(TopCity {
                    city: item["city"].as_str()?.to_owned(),
                    country: item["country"].as_str().unwrap_or_default().to_owned(),
                    listeners: item["numberOfListeners"].as_u64()?,
                })
            })
            .collect(),
        biography_html: artist["profile"]["biography"]["text"]
            .as_str()
            .unwrap_or_default()
            .chars()
            .take(20_000)
            .collect(),
        source_url: format!("https://open.spotify.com/artist/{id}"),
        fetched_at: SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs(),
    })
}

/// Spotify's related shelves on an artist page, in its order.
fn related_sections(artist: &Value) -> Vec<crate::home::HomeSection> {
    let name = artist["profile"]["name"].as_str().unwrap_or("this artist");
    let list = |path: &str| {
        artist
            .pointer(path)
            .and_then(Value::as_array)
            .map(Vec::as_slice)
            .unwrap_or_default()
            .iter()
            .take(20)
    };
    let playlists = |path: &str| -> Vec<crate::home::HomeItem> {
        list(path)
            .filter_map(|item| {
                let data = &item["data"];
                (data["__typename"].as_str() == Some("Playlist"))
                    .then(|| shelf_item(data, "playlist"))
                    .flatten()
            })
            .collect()
    };
    let related = list("/relatedContent/relatedArtists/items")
        .filter_map(|item| shelf_item(item, "artist"))
        .collect();
    let appears = list("/relatedContent/appearsOn/items")
        .filter_map(|item| shelf_item(&item["releases"]["items"][0], "album"))
        .collect();
    [
        (
            format!("Featuring {name}"),
            playlists("/relatedContent/featuringV2/items"),
        ),
        (
            "Discovered on".into(),
            playlists("/relatedContent/discoveredOnV2/items"),
        ),
        (
            "Artist Playlists".into(),
            playlists("/profile/playlistsV2/items"),
        ),
        ("Fans also like".into(), related),
        ("Appears On".into(), appears),
    ]
    .into_iter()
    .filter(|(_, items)| !items.is_empty())
    .map(|(title, items)| crate::home::HomeSection {
        uri: format!("artist-section:{title}"),
        title,
        subtitle: String::new(),
        items,
        header_images: Vec::new(),
    })
    .collect()
}

/// The pinned "Artist pick": Spotify's own subtitle ("Album • New Release",
/// "Playlist") and the item's artwork, falling back to the pick thumbnail.
fn artist_pick(pin: &Value) -> Option<crate::home::HomeItem> {
    let data = &pin["itemV2"]["data"];
    let uri = data["uri"].as_str()?;
    let kind = uri.strip_prefix("spotify:")?.split(':').next()?.to_owned();
    let mut images = crate::home::images(data);
    if images.is_empty() {
        images = pin["thumbnailImage"]["data"]["sources"]
            .as_array()
            .map(Vec::as_slice)
            .unwrap_or_default()
            .iter()
            .filter_map(|image| image["url"].as_str())
            .filter(|url| url.starts_with("https://"))
            .map(|url| Artwork {
                url: url.to_owned(),
                width: None,
            })
            .collect();
    }
    Some(crate::home::HomeItem {
        uri: uri.to_owned(),
        route: crate::home::route(uri)?,
        name: data["name"]
            .as_str()
            .filter(|name| !name.is_empty())?
            .to_owned(),
        subtitle: pin["subtitle"]
            .as_str()
            .filter(|text| !text.is_empty())
            .map_or_else(
                || {
                    let mut kind = kind.clone();
                    if let Some(first) = kind.get_mut(..1) {
                        first.make_ascii_uppercase();
                    }
                    kind
                },
                str::to_owned,
            ),
        images,
        playable: kind != "artist",
        kind,
        format: String::new(),
    })
}

fn shelf_item(data: &Value, kind: &str) -> Option<crate::home::HomeItem> {
    let uri = data["uri"].as_str()?;
    let route = crate::home::route(uri)?;
    let name = data["name"]
        .as_str()
        .or_else(|| data["profile"]["name"].as_str())
        .filter(|name| !name.is_empty())?;
    let subtitle = match kind {
        "artist" => "Artist".to_owned(),
        "album" => {
            let kind = data["type"].as_str().unwrap_or("ALBUM").to_lowercase();
            let kind = match kind.as_str() {
                "single" => "Single",
                "compilation" => "Compilation",
                "ep" => "EP",
                _ => "Album",
            };
            match data["date"]["year"].as_u64() {
                Some(year) => format!("{year} • {kind}"),
                None => kind.to_owned(),
            }
        }
        _ => {
            let description = plain_text(data["description"].as_str().unwrap_or_default());
            if description.is_empty() {
                data["ownerV2"]["data"]["name"]
                    .as_str()
                    .map(|owner| format!("By {owner}"))
                    .unwrap_or_default()
            } else {
                description
            }
        }
    };
    Some(crate::home::HomeItem {
        uri: uri.to_owned(),
        route,
        name: name.to_owned(),
        subtitle,
        images: crate::home::images(data),
        kind: kind.to_owned(),
        playable: kind != "artist",
        format: String::new(),
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
    decode_entities(&text.split_whitespace().collect::<Vec<_>>().join(" "))
}

/// Decode HTML character references Spotify leaves in biographies, such as
/// `&#64;` ("@") and `&#34;` ("\""), as well as the common named ones.
fn decode_entities(text: &str) -> String {
    let mut decoded = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(start) = rest.find('&') {
        decoded.push_str(&rest[..start]);
        let tail = &rest[start..];
        let reference = tail
            .find(';')
            .filter(|end| *end <= 10)
            .map(|end| (&tail[1..end], end));
        let character = reference.and_then(|(name, _)| match name {
            "amp" => Some('&'),
            "quot" => Some('"'),
            "apos" => Some('\''),
            "lt" => Some('<'),
            "gt" => Some('>'),
            "nbsp" => Some(' '),
            _ => name
                .strip_prefix("#x")
                .or_else(|| name.strip_prefix("#X"))
                .map_or_else(
                    || name.strip_prefix('#').and_then(|n| n.parse().ok()),
                    |hex| u32::from_str_radix(hex, 16).ok(),
                )
                .and_then(char::from_u32)
                .filter(|c| !c.is_control()),
        });
        match (character, reference) {
            (Some(character), Some((_, end))) => {
                decoded.push(character);
                rest = &tail[end + 1..];
            }
            _ => {
                decoded.push('&');
                rest = &tail[1..];
            }
        }
    }
    decoded.push_str(rest);
    decoded
}

/// Spotify serves gallery photos at 640 px (`dd22`) and 1000 px (`c46c`)
/// under the same image ID; the About card and window use the sharper one.
fn larger_gallery_photo(url: &str) -> String {
    url.replacen(
        "https://i.scdn.co/image/ab6772690000dd22",
        "https://i.scdn.co/image/ab6772690000c46c",
        1,
    )
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

#[cfg(test)]
mod section_tests {
    use super::*;
    #[test]
    fn biographies_decode_character_references() {
        assert_eq!(
            plain_text(
                "&#64;johnmichaelhowell Hi! &#34;Nuvo&#34; &amp; <b>more</b> &#x2764; &bogus; a & b"
            ),
            "@johnmichaelhowell Hi! \"Nuvo\" & more \u{2764} &bogus; a & b"
        );
    }
    #[test]
    fn gallery_photos_use_the_sharper_size() {
        assert_eq!(
            larger_gallery_photo(
                "https://i.scdn.co/image/ab6772690000dd2206766a59ddd2f3a14f80328f"
            ),
            "https://i.scdn.co/image/ab6772690000c46c06766a59ddd2f3a14f80328f"
        );
        let old = "https://i.scdn.co/image/184c822d252ceb7561539063a904ef433ac43562";
        assert_eq!(larger_gallery_photo(old), old);
    }
    use serde_json::json;
    #[test]
    fn artist_pick_keeps_spotify_subtitle_and_artwork() {
        let pin = json!({"subtitle": "Album • New Release", "comment": "Hi",
            "itemV2": {"data": {"uri": "spotify:album:0123456789abcdefghij09", "name": "Showgirl",
                "coverArt": {"sources": [{"url": "https://i.scdn.co/image/cover"}]}}}});
        let pick = artist_pick(&pin).unwrap();
        assert_eq!(pick.name, "Showgirl");
        assert_eq!(pick.subtitle, "Album • New Release");
        assert_eq!(pick.route, "album:0123456789abcdefghij09");
        assert_eq!(pick.images[0].url, "https://i.scdn.co/image/cover");
        let bare = json!({"itemV2": {"data": {"uri": "spotify:playlist:0123456789abcdefghij08", "name": "Essentials"}},
            "thumbnailImage": {"data": {"sources": [{"url": "https://image-cdn-ak.spotifycdn.com/thumb"}]}}});
        let pick = artist_pick(&bare).unwrap();
        assert_eq!(pick.subtitle, "Playlist");
        assert_eq!(pick.images.len(), 1);
        assert!(artist_pick(&serde_json::Value::Null).is_none());
    }
    #[test]
    fn verified_reads_the_reputation_trait_then_older_fields() {
        let current = json!({"onPlatformReputationTrait": {"verification": {"isVerified": true}}});
        assert_eq!(verified(&current), Some(true));
        assert_eq!(
            verified(&json!({"profile": {"verified": false}})),
            Some(false)
        );
        assert_eq!(verified(&json!({})), None);
    }
    #[test]
    fn related_shelves_follow_spotify_order_and_skip_errors() {
        let playlist = |id: &str, name: &str, description: &str| {
            json!({"data": {"__typename": "Playlist", "uri": format!("spotify:playlist:{id}"),
                "name": name, "description": description,
                "ownerV2": {"data": {"name": "Spotify"}},
                "images": {"items": [{"sources": [{"url": "https://i.scdn.co/image/p"}]}]}}})
        };
        let artist = json!({
            "profile": {"name": "Test Artist", "playlistsV2": {"items": [playlist("0123456789abcdefghij03", "Best Of", "")]}},
            "relatedContent": {
                "featuringV2": {"items": [playlist("0123456789abcdefghij01", "This Is Test Artist", "The <b>essential</b> tracks")]},
                "discoveredOnV2": {"items": [{"data": {"__typename": "GenericError"}}, playlist("0123456789abcdefghij02", "Hits", "")]},
                "relatedArtists": {"items": [{"uri": "spotify:artist:0123456789abcdefghij04", "profile": {"name": "Other Artist"},
                    "visuals": {"avatarImage": {"sources": [{"url": "https://i.scdn.co/image/a"}]}}}]},
                "appearsOn": {"items": [{"releases": {"items": [{"uri": "spotify:album:0123456789abcdefghij05",
                    "name": "Loud", "type": "ALBUM", "date": {"year": 2010},
                    "coverArt": {"sources": [{"url": "https://i.scdn.co/image/c"}]}}]}}]}
            }
        });
        let sections = related_sections(&artist);
        let titles: Vec<_> = sections
            .iter()
            .map(|section| section.title.as_str())
            .collect();
        assert_eq!(
            titles,
            [
                "Featuring Test Artist",
                "Discovered on",
                "Artist Playlists",
                "Fans also like",
                "Appears On"
            ]
        );
        assert_eq!(sections[0].items[0].subtitle, "The essential tracks");
        assert_eq!(sections[1].items.len(), 1);
        assert_eq!(sections[2].items[0].subtitle, "By Spotify");
        assert_eq!(sections[3].items[0].kind, "artist");
        assert!(!sections[3].items[0].playable);
        assert_eq!(sections[4].items[0].subtitle, "2010 • Album");
        assert_eq!(sections[4].items[0].route, "album:0123456789abcdefghij05");
    }
}

#[cfg(test)]
mod live_tests {
    #[test]
    #[ignore = "Reads one public artist page through the saved native sign-in"]
    fn live_artist_page_has_related_shelves() {
        crate::native::with_live_session(async |session: &librespot_core::Session| {
            // Eminem: a large catalogue with every related shelf.
            let id = "7dGJo4pcD2V6oG8kP0tJRR";
            let entity = crate::catalogue::entity(session, "artist", id)
                .await
                .expect("Artist query failed");
            let overview = super::from_entity(&entity, id).expect("Artist page parse failed");
            let shelves: Vec<_> = overview
                .sections
                .iter()
                .map(|section| format!("{} ({})", section.title, section.items.len()))
                .collect();
            assert!(overview.world_rank.is_some(), "Expected a world rank");
            assert!(overview.gallery_image.is_some(), "Expected a gallery photo");
            assert!(
                overview.gallery.len() > 1,
                "Expected several gallery photos"
            );
            assert!(!overview.top_cities.is_empty(), "Expected top cities");
            assert!(
                overview.biography_html.contains("spotify:artist:"),
                "Expected linked artists in the biography"
            );
            assert_eq!(overview.verified, Some(true), "Expected a verified artist");
            assert!(shelves.len() >= 4, "Expected related shelves: {shelves:?}");
            eprintln!(
                "Artist page: rank #{:?}, shelves {shelves:?}",
                overview.world_rank
            );
        });
    }
}
