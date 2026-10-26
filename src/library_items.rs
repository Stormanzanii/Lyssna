//! Saved albums and followed artists for Your Library. The collection service
//! lists them; Spotify's metadata service names them, as the desktop client
//! does, so no Web API scope or quota is involved.
use crate::model::{Album, Artist, Artwork};
use anyhow::Result;
use librespot_core::{Session, SpotifyUri};
use librespot_metadata::{Metadata, image::Images};
use serde::Serialize;
use std::{
    collections::HashMap,
    sync::{LazyLock, Mutex},
};

/// Items named at most, newest first; a library rarely holds more.
const LIMIT: usize = 1000;
/// Metadata requests in flight at once.
const PARALLEL: usize = 8;

#[derive(Clone, Default, Serialize)]
pub struct LibraryItems {
    pub albums: Vec<Album>,
    pub artists: Vec<Artist>,
    /// When each library item was last played or added, whichever is later,
    /// in Unix milliseconds: Spotify's Recents order. Playlists appear here
    /// only once played; their added time comes with the playlist.
    pub recency: HashMap<String, i64>,
}

#[derive(Clone)]
enum Named {
    Album(Album),
    Artist(Artist),
}

/// Names already read this run, so reopening the library is instant.
static NAMED: LazyLock<Mutex<HashMap<String, Named>>> = LazyLock::new(Default::default);

pub async fn fetch(session: &Session) -> Result<LibraryItems> {
    let mut items = LibraryItems {
        // Without play history the order falls back to when items were added.
        recency: crate::native_browse::played_contexts(session)
            .await
            .unwrap_or_default(),
        ..LibraryItems::default()
    };
    for kind in ["album", "artist"] {
        let listed: Vec<(String, i32)> = crate::collection::listed(session, kind)
            .await?
            .into_iter()
            .take(LIMIT)
            .collect();
        for (uri, added) in &listed {
            let at = items.recency.entry(uri.clone()).or_insert(0);
            *at = (*at).max(i64::from(*added) * 1000);
        }
        let uris: Vec<String> = listed.into_iter().map(|(uri, _)| uri).collect();
        let named = name_all(session, &uris).await;
        for uri in &uris {
            match named.get(uri) {
                Some(Named::Album(album)) => items.albums.push(album.clone()),
                Some(Named::Artist(artist)) => items.artists.push(artist.clone()),
                None => {}
            }
        }
    }
    Ok(items)
}

async fn name_all(session: &Session, uris: &[String]) -> HashMap<String, Named> {
    let mut named: HashMap<String, Named> = {
        let cache = NAMED.lock().unwrap_or_else(|poison| poison.into_inner());
        uris.iter()
            .filter_map(|uri| Some((uri.clone(), cache.get(uri)?.clone())))
            .collect()
    };
    let missing: Vec<String> = uris
        .iter()
        .filter(|uri| !named.contains_key(*uri))
        .cloned()
        .collect();
    for chunk in missing.chunks(PARALLEL) {
        let mut tasks = tokio::task::JoinSet::new();
        for uri in chunk {
            let (session, uri) = (session.clone(), uri.clone());
            tasks.spawn(async move { (name(&session, &uri).await, uri) });
        }
        while let Some(Ok((result, uri))) = tasks.join_next().await {
            // An item Spotify cannot name is left out rather than shown blank.
            if let Ok(item) = result {
                named.insert(uri, item);
            }
        }
    }
    let mut cache = NAMED.lock().unwrap_or_else(|poison| poison.into_inner());
    if cache.len() > 20_000 {
        cache.clear();
    }
    cache.extend(named.iter().map(|(uri, item)| (uri.clone(), item.clone())));
    named
}

async fn name(session: &Session, uri: &str) -> Result<Named> {
    let id = SpotifyUri::from_uri(uri)?;
    Ok(match id {
        SpotifyUri::Album { .. } => {
            let album = librespot_metadata::Album::get(session, &id).await?;
            Named::Album(Album {
                id: Some(id.to_id()),
                uri: uri.to_owned(),
                name: album.name,
                images: artwork(if album.covers.is_empty() {
                    &album.cover_group
                } else {
                    &album.covers
                }),
                artists: album
                    .artists
                    .iter()
                    .map(|artist| artist_link(&artist.id, &artist.name))
                    .collect(),
                album_type: album.type_str,
                ..Album::default()
            })
        }
        SpotifyUri::Artist { .. } => {
            let artist = librespot_metadata::Artist::get(session, &id).await?;
            Named::Artist(Artist {
                images: artwork(if artist.portrait_group.is_empty() {
                    &artist.portraits
                } else {
                    &artist.portrait_group
                }),
                ..artist_link(&id, &artist.name)
            })
        }
        _ => anyhow::bail!("Choose an album or artist"),
    })
}

fn artist_link(id: &SpotifyUri, name: &str) -> Artist {
    Artist {
        id: Some(id.to_id()),
        uri: id.to_uri(),
        name: name.to_owned(),
        ..Artist::default()
    }
}

/// Spotify image IDs as CDN links, largest first.
fn artwork(images: &Images) -> Vec<Artwork> {
    let mut artwork: Vec<Artwork> = images
        .iter()
        .map(|image| Artwork {
            url: format!("https://i.scdn.co/image/{}", image.id.to_base16()),
            width: u32::try_from(image.width).ok().filter(|width| *width > 0),
        })
        .collect();
    artwork.sort_by_key(|image| std::cmp::Reverse(image.width));
    artwork
}
