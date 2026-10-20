//! Playlist discovery through Spotify's native catalogue, with a Web API fallback.
use anyhow::{Context, Result, ensure};
use librespot_core::Session;
use serde_json::{Value, json};
use std::collections::HashSet;

use crate::model::{Artwork, Owner, Playlist};

pub async fn playlists(session: &Session, query: &str) -> Result<Vec<Playlist>> {
    ensure!(
        !query.trim().is_empty() && query.len() <= 600 && !query.chars().any(char::is_control),
        "Invalid search query"
    );
    // Persisted query identifier from Spotify's search page, checked 2026-10-20.
    let response = crate::catalogue::query(
        session,
        "searchPlaylists",
        "d520014e748f9ea44f7707d8df1819867ac1205e8b7f3e28f22fe5fc858921b1",
        json!({
            "searchTerm": query,
            "offset": 0,
            "limit": 20,
            "numberOfTopResults": 20,
            "includePreReleases": false,
            "includeAlbumPreReleases": false,
            "includeAudiobooks": false,
            "includeAuthors": false
        }),
    )
    .await?;
    parse_native(&response)
}

fn parse_native(response: &Value) -> Result<Vec<Playlist>> {
    let items = response
        .pointer("/data/searchV2/playlists/items")
        .and_then(Value::as_array)
        .context("Spotify playlist search unavailable")?;
    let mut seen = HashSet::new();
    Ok(items
        .iter()
        .filter_map(|item| {
            let data = &item["data"];
            if data["__typename"].as_str() != Some("Playlist") {
                return None;
            }
            let uri = data["uri"].as_str()?;
            let id = uri.strip_prefix("spotify:playlist:")?;
            crate::home::route(uri)?;
            let name = data["name"].as_str().filter(|name| !name.is_empty())?;
            if !seen.insert(id.to_owned()) {
                return None;
            }
            let owner = &data["ownerV2"]["data"];
            let images = data["images"]["items"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(|image| image["sources"].as_array())
                .flatten()
                .filter_map(|image| {
                    let url = image["url"]
                        .as_str()
                        .filter(|url| url.starts_with("https://"))?;
                    Some(Artwork {
                        url: url.into(),
                        width: image["width"]
                            .as_u64()
                            .and_then(|width| width.try_into().ok()),
                    })
                })
                .collect();
            Some(Playlist {
                id: id.into(),
                name: name.into(),
                images,
                owner: Owner {
                    id: owner["username"]
                        .as_str()
                        .or_else(|| owner["uri"].as_str()?.strip_prefix("spotify:user:"))
                        .unwrap_or_default()
                        .into(),
                    display_name: owner["name"].as_str().map(str::to_owned),
                },
                collaborative: false,
            })
        })
        .collect())
}

pub(crate) fn parse_public(response: &Value) -> Result<Vec<Playlist>> {
    let items = response["playlists"]["items"]
        .as_array()
        .context("Spotify playlist search unavailable")?;
    let mut seen = HashSet::new();
    Ok(items
        .iter()
        .filter_map(|item| serde_json::from_value::<Playlist>(item.clone()).ok())
        .filter(|playlist| {
            crate::home::route(&format!("spotify:playlist:{}", playlist.id)).is_some()
                && !playlist.name.is_empty()
                && seen.insert(playlist.id.clone())
        })
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn native_search_keeps_public_and_curated_playlists_and_skips_unavailable_entries() {
        let item = |id: &str, owner: &str| {
            json!({"data": {
                "__typename": "Playlist", "uri": format!("spotify:playlist:{id}"),
                "name": "Workout", "ownerV2": {"data": {"username": owner, "name": owner}},
                "images": {"items": [{"sources": [{"url": "https://i.scdn.co/image/test", "width": 300}]}]}
            }})
        };
        let user = item("0123456789abcdefghijkl", "listener");
        let response = json!({"data": {"searchV2": {"playlists": {"items": [
            null, {"data": {"__typename": "NotFound"}}, user, user,
            item("1123456789abcdefghijkl", "spotify"), item("bad/id", "other")
        ]}}}});
        let results = parse_native(&response).unwrap();
        assert_eq!(results.len(), 2);
        assert_eq!(results[0].owner.id, "listener");
        assert_eq!(results[1].owner.id, "spotify");
        assert_eq!(results[1].images[0].width, Some(300));
        assert!(parse_native(&json!({"errors": [{"message": "unavailable"}]})).is_err());
    }

    #[test]
    fn public_search_skips_null_items_and_accepts_missing_owner_names() {
        let response = json!({"playlists": {"items": [null,
            {"id": "0123456789abcdefghijkl", "name": "Public", "owner": {"display_name": null}},
            {"id": "1123456789abcdefghijkl", "name": "Curated", "owner": {"id": "spotify"}},
            {"id": "invalid", "name": "Unavailable"}
        ]}});
        let results = parse_public(&response).unwrap();
        assert_eq!(results.len(), 2);
        assert!(results[0].owner.display_name.is_none());
        assert_eq!(results[1].owner.id, "spotify");
        assert!(parse_public(&json!({})).is_err());
    }
}
