//! Account-bound music shelves from Spotify's native Home feed.
use crate::model::Artwork;
use anyhow::{Context, Result, ensure};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

pub const DJ_URI: &str = "spotify:playlist:37i9dQZF1EYkqdzj48dyYq";
#[derive(Clone, Default, Deserialize, Serialize)]
pub struct HomePage {
    pub account: String,
    pub greeting: String,
    pub sections: Vec<HomeSection>,
    /// Restored from disk; refresh once native audio connects.
    #[serde(default)]
    pub cached: bool,
}
#[derive(Clone, Default, Deserialize, Serialize)]
pub struct HomeSection {
    pub uri: String,
    pub title: String,
    pub subtitle: String,
    pub items: Vec<HomeItem>,
}
#[derive(Clone, Default, Deserialize, Serialize)]
pub struct HomeItem {
    pub uri: String,
    pub route: String,
    pub name: String,
    pub subtitle: String,
    pub images: Vec<Artwork>,
    pub kind: String,
    pub playable: bool,
    pub format: String,
}

pub fn route(uri: &str) -> Option<String> {
    if uri == "spotify:collection:tracks" {
        return Some("liked".into());
    }
    let mut parts = uri.strip_prefix("spotify:")?.split(':');
    let kind = parts.next()?;
    let id = parts.next()?;
    if parts.next().is_some()
        || !["album", "artist", "playlist", "track"].contains(&kind)
        || id.len() != 22
        || !id.bytes().all(|c| c.is_ascii_alphanumeric())
    {
        return None;
    }
    Some(format!("{kind}:{id}"))
}
fn text(value: &Value) -> String {
    value
        .as_str()
        .or_else(|| value["transformedLabel"].as_str())
        .or_else(|| value["text"].as_str())
        .unwrap_or_default()
        .to_owned()
}
fn images(data: &Value) -> Vec<Artwork> {
    let paths = [
        "/coverArt/sources",
        "/images/items/0/sources",
        "/visuals/avatarImage/sources",
        "/visualIdentityTrait/squareCoverImage/image/data/sources",
    ];
    paths
        .iter()
        .filter_map(|path| data.pointer(path).and_then(Value::as_array))
        .flatten()
        .filter_map(|image| {
            let url = image["url"].as_str()?;
            if !url.starts_with("https://") {
                return None;
            }
            Some(Artwork {
                url: url.into(),
                width: image["width"]
                    .as_u64()
                    .or_else(|| image["maxWidth"].as_u64())
                    .and_then(|width| u32::try_from(width).ok()),
            })
        })
        .collect()
}
fn card(data: &Value) -> Option<HomeItem> {
    let uri = data["uri"].as_str()?;
    let route = route(uri)?;
    let name = data["name"]
        .as_str()
        .or_else(|| data["profile"]["name"].as_str())
        .or_else(|| data["identityTrait"]["name"].as_str())?;
    let description = data["description"]
        .as_str()
        .filter(|value| !value.is_empty());
    let artists = data
        .pointer("/artists/items")
        .or_else(|| data.pointer("/identityTrait/contributors/items"))
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(|artist| {
                    artist["profile"]["name"]
                        .as_str()
                        .or_else(|| artist["name"].as_str())
                })
                .collect::<Vec<_>>()
                .join(", ")
        })
        .unwrap_or_default();
    let subtitle = description
        .map(str::to_owned)
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| {
            if artists.is_empty() {
                text(&data["ownerV2"]["data"]["name"])
            } else {
                artists
            }
        });
    Some(HomeItem {
        uri: uri.into(),
        kind: route.split(':').next().unwrap_or("playlist").into(),
        route,
        name: name.into(),
        subtitle,
        images: images(data),
        playable: data["playability"]["playable"].as_bool().unwrap_or(true),
        format: text(&data["format"]),
    })
}
fn cards(value: &Value, depth: usize, items: &mut Vec<HomeItem>) {
    if depth > 5 || items.len() >= 50 {
        return;
    }
    if let Some(item) = card(value) {
        if !items.iter().any(|old| old.uri == item.uri) {
            items.push(item)
        }
        return;
    }
    for key in ["content", "data", "entity"] {
        if value[key].is_object() {
            cards(&value[key], depth + 1, items)
        }
    }
    if let Some(children) = value.pointer("/items/items").and_then(Value::as_array) {
        for child in children.iter().take(50) {
            cards(child, depth + 1, items)
        }
    }
}
pub fn parse(account: &str, value: &Value) -> Result<HomePage> {
    let home = &value["data"]["home"];
    let sections = home
        .pointer("/sectionContainer/sections/items")
        .and_then(Value::as_array)
        .context("Personalized Home unavailable")?;
    let mut result = HomePage {
        account: account.into(),
        greeting: text(&home["greeting"]),
        ..Default::default()
    };
    for section in sections.iter().take(50) {
        let title = text(&section["data"]["title"]);
        if title.is_empty() {
            continue;
        }
        let mut items = Vec::new();
        if let Some(children) = section
            .pointer("/sectionItems/items")
            .and_then(Value::as_array)
        {
            for child in children.iter().take(50) {
                cards(child, 0, &mut items)
            }
        }
        if !items.is_empty() {
            result.sections.push(HomeSection {
                uri: text(&section["uri"]),
                title,
                subtitle: text(&section["data"]["subtitle"]),
                items,
            })
        }
    }
    ensure!(
        !result.sections.is_empty(),
        "Personalized music shelves unavailable"
    );
    Ok(result)
}
pub async fn fetch(session: &librespot_core::Session, timezone: &str) -> Result<HomePage> {
    let value=crate::catalogue::query(session,"home","76243c78b0e20ecdbe41b794dec8cbe73f75e585b0a7201b8d2e84578412847a",json!({"homeEndUserIntegration":"INTEGRATION_DESKTOP","timeZone":timezone,"sp_t":"","facet":"","sectionItemsLimit":50,"includeEpisodeContentRatingsV2":false})).await?;
    parse(&session.username(), &value)
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn parses_account_mix_and_recent_entity_without_unrelated_media() {
        let playlist = json!({"uri":"spotify:playlist:1234567890123456789012","name":"Daily Mix 1","format":"daily-mix","description":"Personal artists","images":{"items":[{"sources":[{"url":"https://artwork.example.test/mix"}]}]}});
        let recent = json!({"uri":"spotify:album:2234567890123456789012","identityTrait":{"name":"Recent album","contributors":{"items":[{"name":"Artist"}]}},"visualIdentityTrait":{"squareCoverImage":{"image":{"data":{"sources":[{"url":"https://artwork.example.test/album"}]}}}}});
        let value = json!({"data":{"home":{"greeting":{"text":"Hello"},"sectionContainer":{"sections":{"items":[{"uri":"spotify:section:personal","data":{"title":{"transformedLabel":"Made for listener"}},"sectionItems":{"items":[{"content":{"data":playlist}}]}},{"uri":"spotify:section:recent","data":{"title":{"transformedLabel":"Recents"}},"sectionItems":{"items":[{"content":{"data":{"items":{"items":[{"entity":{"data":recent}},{"entity":{"data":{"uri":"spotify:episode:3234567890123456789012","name":"Podcast"}}}]}}}}]}}]}}}}});
        let page = parse("account-a", &value).unwrap();
        assert_eq!(page.account, "account-a");
        // Daily Mixes stay inside Spotify's own shelf, not a copied row.
        assert_eq!(page.sections.len(), 2);
        assert_eq!(page.sections[0].title, "Made for listener");
        assert_eq!(page.sections[0].items[0].images.len(), 1);
        assert_eq!(page.sections[1].items.len(), 1);
        assert_eq!(page.sections[1].items[0].name, "Recent album");
        assert_eq!(
            page.sections[1].items[0].route,
            "album:2234567890123456789012"
        );
    }
    #[test]
    fn rejects_non_music_and_malformed_contexts() {
        assert!(route("spotify:playlist:../unsafe").is_none());
        assert!(route("https://example.test").is_none());
        assert!(route("spotify:episode:1234567890123456789012").is_none());
        assert_eq!(route("spotify:collection:tracks").as_deref(), Some("liked"));
    }
}
