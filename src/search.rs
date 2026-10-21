//! Ranked music search through Spotify's native catalogue, with a Web API fallback.
use anyhow::{Context, Result, ensure};
use librespot_core::Session;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::HashSet;

use crate::model::{Album, Artist, Artwork, Owner, Playlist, Track};

#[derive(Clone, Default, Deserialize, Serialize)]
pub struct SearchResults {
    pub tracks: Vec<Track>,
    pub artists: Vec<Artist>,
    pub albums: Vec<Album>,
    pub playlists: Vec<Playlist>,
    pub top_results: Vec<String>,
}

pub async fn catalogue(session: &Session, query: &str) -> Result<SearchResults> {
    ensure!(
        !query.trim().is_empty() && query.len() <= 600 && !query.chars().any(char::is_control),
        "Invalid search query"
    );
    let response = crate::catalogue::query(
        session,
        "searchDesktop",
        "eef7cc54888d91bdd6802623477873caa3948ae173a0c34fd86827b267e94c03",
        json!({
            "searchTerm": query, "offset": 0, "limit": 20, "numberOfTopResults": 8,
            "includeAudiobooks": false, "includeArtistHasConcertsField": false,
            "includePreReleases": false, "includeAlbumPreReleases": false,
            "includeAuthors": false, "includeEpisodeContentRatingsV2": false
        }),
    )
    .await?;
    parse_catalogue(&response)
}

fn data(value: &Value) -> &Value {
    if let Some(item) = value.get("item") {
        return data(item);
    }
    value.get("data").unwrap_or(value)
}

fn native_images(value: &Value) -> Vec<Artwork> {
    value
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|image| {
            Some(Artwork {
                url: image["url"]
                    .as_str()
                    .filter(|url| url.starts_with("https://"))?
                    .into(),
                width: image["width"]
                    .as_u64()
                    .and_then(|width| width.try_into().ok()),
            })
        })
        .collect()
}

fn native_artist(value: &Value) -> Option<Artist> {
    let value = data(value);
    let uri = value["uri"].as_str()?;
    let id = uri.strip_prefix("spotify:artist:")?;
    crate::home::route(uri)?;
    Some(Artist {
        id: Some(id.into()),
        uri: uri.into(),
        name: value["profile"]["name"]
            .as_str()
            .or_else(|| value["name"].as_str())?
            .into(),
        images: native_images(&value["visuals"]["avatarImage"]["sources"]),
        ..Artist::default()
    })
}

fn native_album(value: &Value) -> Option<Album> {
    let value = data(value);
    let uri = value["uri"].as_str()?;
    let id = uri.strip_prefix("spotify:album:")?;
    crate::home::route(uri)?;
    Some(Album {
        id: Some(id.into()),
        uri: uri.into(),
        name: value["name"].as_str()?.into(),
        images: native_images(&value["coverArt"]["sources"]),
        artists: value["artists"]["items"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(native_artist)
            .collect(),
        release_date: value["date"]["isoString"]
            .as_str()
            .unwrap_or_default()
            .chars()
            .take(10)
            .collect(),
        album_type: value["type"].as_str().unwrap_or_default().to_lowercase(),
        ..Album::default()
    })
}

fn native_track(value: &Value) -> Option<Track> {
    let value = data(value);
    let uri = value["uri"].as_str()?;
    let id = uri.strip_prefix("spotify:track:")?;
    crate::home::route(uri)?;
    Some(Track {
        id: Some(id.into()),
        uri: uri.into(),
        name: value["name"].as_str()?.into(),
        explicit: value["contentRating"]["label"].as_str() == Some("EXPLICIT"),
        duration_ms: value["duration"]["totalMilliseconds"]
            .as_u64()
            .unwrap_or_default(),
        artists: value["artists"]["items"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(native_artist)
            .collect(),
        album: native_album(&value["albumOfTrack"]).unwrap_or_default(),
        ..Track::default()
    })
}

fn parse_catalogue(response: &Value) -> Result<SearchResults> {
    let search = &response["data"]["searchV2"];
    ensure!(
        search["tracksV2"]["items"].is_array(),
        "Spotify search unavailable"
    );
    let mut results = SearchResults {
        tracks: search["tracksV2"]["items"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(native_track)
            .collect(),
        artists: search["artists"]["items"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(native_artist)
            .collect(),
        albums: search["albumsV2"]["items"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(native_album)
            .collect(),
        playlists: parse_native(response).unwrap_or_default(),
        top_results: search["topResultsV2"]["itemsV2"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|item| data(item)["uri"].as_str())
            .filter(|uri| crate::home::route(uri).is_some())
            .map(str::to_owned)
            .collect(),
    };
    // The first-ranked entity can be outside its category's initial page.
    for item in search["topResultsV2"]["itemsV2"]
        .as_array()
        .into_iter()
        .flatten()
    {
        if let Some(track) = native_track(item)
            && !results.tracks.iter().any(|value| value.uri == track.uri)
        {
            results.tracks.push(track);
        }
        if let Some(artist) = native_artist(item)
            && !results.artists.iter().any(|value| value.uri == artist.uri)
        {
            results.artists.push(artist);
        }
        if let Some(album) = native_album(item)
            && !results.albums.iter().any(|value| value.uri == album.uri)
        {
            results.albums.push(album);
        }
    }
    Ok(results)
}

pub(crate) fn parse_public_catalogue(response: &Value) -> Result<SearchResults> {
    ensure!(
        response["tracks"]["items"].is_array(),
        "Spotify search unavailable"
    );
    fn items<T: serde::de::DeserializeOwned>(value: &Value) -> Vec<T> {
        value
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|item| serde_json::from_value(item.clone()).ok())
            .collect()
    }
    Ok(SearchResults {
        tracks: items(&response["tracks"]["items"]),
        artists: items(&response["artists"]["items"]),
        albums: items(&response["albums"]["items"]),
        playlists: parse_public(response).unwrap_or_default(),
        ..SearchResults::default()
    })
}

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
                folders: Vec::new(),
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
    fn catalogue_preserves_music_types_rankings_and_track_metadata() {
        let id = "0123456789abcdefghijkl";
        let artist = json!({"uri": format!("spotify:artist:{id}"), "profile": {"name": "Artist"}, "visuals": {"avatarImage": {"sources": [{"url": "https://i.scdn.co/artist", "width": 300}]}}});
        let album = json!({"uri": format!("spotify:album:{id}"), "name": "Album", "coverArt": {"sources": [{"url": "https://i.scdn.co/album"}]}, "artists": {"items": [artist]}});
        let track = json!({"uri": format!("spotify:track:{id}"), "name": "Song", "duration": {"totalMilliseconds": 180000}, "contentRating": {"label": "EXPLICIT"}, "albumOfTrack": album, "artists": {"items": [artist]}});
        let response = json!({"data": {"searchV2": {
            "tracksV2": {"items": [null, {"item": {"data": track}}]},
            "artists": {"items": [{"data": artist}]},
            "albumsV2": {"items": [{"data": album}]},
            "playlists": {"items": []},
            "topResultsV2": {"itemsV2": [{"data": artist}, {"item": {"data": track}}, {"data": {"uri": "spotify:episode:invalid"}}]}
        }}});
        let results = parse_catalogue(&response).unwrap();
        assert_eq!(results.tracks.len(), 1);
        assert_eq!(results.tracks[0].duration_ms, 180000);
        assert!(results.tracks[0].explicit);
        assert_eq!(results.tracks[0].album.name, "Album");
        assert_eq!(results.tracks[0].artists[0].name, "Artist");
        assert_eq!(results.artists.len(), 1);
        assert_eq!(results.albums.len(), 1);
        assert_eq!(
            results.top_results,
            [
                format!("spotify:artist:{id}"),
                format!("spotify:track:{id}")
            ]
        );
        assert!(parse_catalogue(&json!({"errors": []})).is_err());
    }

    #[test]
    fn public_catalogue_ignores_unavailable_items_and_preserves_empty_categories() {
        let results = parse_public_catalogue(&json!({"tracks": {"items": [null, {"id": "song", "uri": "spotify:track:song", "name": "Song"}]}, "artists": {"items": [null]}, "playlists": {"items": []}})).unwrap();
        assert_eq!(results.tracks.len(), 1);
        assert!(results.artists.is_empty());
        assert!(results.albums.is_empty());
        assert!(results.playlists.is_empty());
        assert!(parse_public_catalogue(&json!({})).is_err());
    }

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
