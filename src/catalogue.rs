//! Read-only desktop catalogue queries. Native credentials stay inside Rust.
use anyhow::{Context, Result, ensure};
use librespot_core::Session;
use serde_json::{Value, json};
use std::time::Duration;
pub fn base_info(entity: &Value, kind: &str, id: &str) -> Result<crate::model::BrowseInfo> {
    use crate::model::{Album, Artist, BrowseInfo};
    fn images(value: &Value) -> Vec<crate::model::Artwork> {
        serde_json::from_value(value.clone()).unwrap_or_default()
    }
    fn artist(value: &Value) -> Artist {
        let uri = value["uri"].as_str().unwrap_or_default();
        Artist {
            id: uri.strip_prefix("spotify:artist:").map(str::to_owned),
            uri: uri.to_owned(),
            name: value["profile"]["name"]
                .as_str()
                .or_else(|| value["name"].as_str())
                .unwrap_or_default()
                .to_owned(),
            images: images(&value["visuals"]["avatarImage"]["sources"]),
            ..Artist::default()
        }
    }
    let mut info = BrowseInfo {
        key: format!("{kind}:{id}"),
        ..BrowseInfo::default()
    };
    if kind == "artist" {
        let artist = artist(entity);
        ensure!(!artist.name.is_empty(), "Artist name unavailable");
        info.title = artist.name.clone();
        info.images = artist.images.clone();
        info.artist = Some(artist);
    } else if kind == "album" {
        let name = entity["name"].as_str().context("Album name unavailable")?;
        let artists = entity["artists"]["items"]
            .as_array()
            .map(|items| items.iter().map(artist).collect::<Vec<_>>())
            .unwrap_or_default();
        let album = Album {
            id: Some(id.to_owned()),
            uri: format!("spotify:album:{id}"),
            name: name.to_owned(),
            images: images(&entity["coverArt"]["sources"]),
            artists,
            release_date: entity["date"]["isoString"]
                .as_str()
                .unwrap_or_default()
                .chars()
                .take(10)
                .collect(),
            album_type: entity["type"].as_str().unwrap_or_default().to_owned(),
            total_tracks: entity["tracksV2"]["totalCount"]
                .as_u64()
                .unwrap_or_default(),
            ..Album::default()
        };
        info.title = album.name.clone();
        info.images = album.images.clone();
        info.subtitle = album
            .artists
            .iter()
            .map(|artist| artist.name.as_str())
            .collect::<Vec<_>>()
            .join(", ");
        info.album = Some(album);
    } else {
        anyhow::bail!("Unsupported catalogue entity");
    }
    Ok(info)
}

pub async fn entity(session: &Session, kind: &str, id: &str) -> Result<Value> {
    page(session, kind, id, 0).await
}
pub async fn page(session: &Session, kind: &str, id: &str, offset: usize) -> Result<Value> {
    ensure!(
        id.len() == 22 && id.bytes().all(|byte| byte.is_ascii_alphanumeric()),
        "Invalid catalogue ID"
    );
    // Persisted query identifiers verified against Spotify's desktop web client.
    let (operation, hash, field) = match kind {
        "artist" => (
            "queryArtistOverview",
            "9f8134ef565e78621f1e1793555bd6633c5ac144ae0f89604ed3ae3f80b3c8e6",
            "artistUnion",
        ),
        "album" => (
            "getAlbum",
            "0b6ce3511e1b02e4a40fa95440f992acbe85080eb308af9194322d708fc1914f",
            "albumUnion",
        ),
        _ => anyhow::bail!("Unsupported catalogue query"),
    };
    let mut data=query(session,operation,hash,json!({"uri":format!("spotify:{kind}:{id}"),"locale":"","preReleaseV2":false,"offset":offset,"limit":50})).await?;
    let entity = data["data"][field].take();
    ensure!(
        entity["uri"].as_str() == Some(format!("spotify:{kind}:{id}").as_str()),
        "Desktop catalogue data unavailable"
    );
    entity.as_object().context("Invalid catalogue data")?;
    Ok(entity)
}
pub(crate) async fn query(
    session: &Session,
    operation: &str,
    hash: &str,
    variables: Value,
) -> Result<Value> {
    let token = session.login5().auth_token().await?;
    let client_token = session.spclient().client_token().await?;
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(8))
        .build()?;
    let mut response=client.post("https://api-partner.spotify.com/pathfinder/v2/query").bearer_auth(token.access_token).header("client-token",client_token).header("app-platform","WebPlayer").header("spotify-app-version","896000000").json(&json!({"operationName":operation,"variables":variables,"extensions":{"persistedQuery":{"version":1,"sha256Hash":hash}}})).send().await?.error_for_status()?;
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await? {
        ensure!(
            bytes.len() + chunk.len() <= 2_000_000,
            "Catalogue response too large"
        );
        bytes.extend_from_slice(&chunk);
    }
    Ok(serde_json::from_slice(&bytes)?)
}
#[cfg(test)]
mod base_tests {
    use super::*;
    #[test]
    fn native_album_supplies_header_without_public_api() {
        let value = json!({"name":"Album title","coverArt":{"sources":[{"url":"https://artwork.example.test/cover","width":640,"height":640}]},"artists":{"items":[{"uri":"spotify:artist:artist","profile":{"name":"Album artist"}}]},"tracksV2":{"totalCount":13},"date":{"isoString":"2026-05-04T00:00:00Z"}});
        let info = base_info(&value, "album", "album").unwrap();
        assert_eq!(info.title, "Album title");
        assert_eq!(info.images.len(), 1);
        let album = info.album.unwrap();
        assert_eq!(album.artists[0].name, "Album artist");
        assert_eq!(album.total_tracks, 13);
        assert_eq!(album.release_date, "2026-05-04");
        assert!(info.album_details.is_none());
    }
}
