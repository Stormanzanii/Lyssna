use crate::model::Track;
use anyhow::{Context, Result, ensure};
use librespot_core::{Session, SpotifyUri};
use librespot_metadata::{Metadata, playlist::Playlist};
use serde_json::{Value, json};
use std::{
    collections::{HashMap, HashSet, VecDeque},
    sync::OnceLock,
    time::{Duration, Instant},
};
struct Listing {
    uris: Vec<String>,
    pages: VecDeque<Value>,
    visited: HashSet<String>,
    created: Instant,
}
type Key = (String, String);
static LISTINGS: OnceLock<tokio::sync::Mutex<HashMap<Key, Listing>>> = OnceLock::new();
static TRACKS: OnceLock<std::sync::Mutex<HashMap<Key, Track>>> = OnceLock::new();
fn listing_pages(context: librespot_protocol::context::Context) -> VecDeque<Value> {
    context.pages.into_iter().map(|page|json!({"tracks":page.tracks.into_iter().filter_map(|track|track.uri).map(|uri|json!({"uri":uri})).collect::<Vec<_>>(),"page_url":page.page_url,"next_page_url":page.next_page_url})).collect()
}
pub async fn read(session: &Session, key: &str, offset: usize) -> Result<Vec<Track>> {
    let identity = session.username();
    let cache_key = (identity.clone(), key.to_owned());
    let wanted = offset.checked_add(50).context("Invalid page offset")?;
    ensure!(wanted <= 100_000, "Playlist exceeds browsing limit");
    let uris = {
        let mut cache = LISTINGS.get_or_init(Default::default).lock().await;
        if offset == 0
            || cache
                .get(&cache_key)
                .is_some_and(|list| list.created.elapsed() > Duration::from_secs(300))
        {
            cache.remove(&cache_key);
        }
        if !cache.contains_key(&cache_key) {
            if cache.len() >= 16 {
                cache.clear();
            }
            let mut listing = Listing {
                uris: Vec::new(),
                pages: VecDeque::new(),
                visited: HashSet::new(),
                created: Instant::now(),
            };
            if key.len() == 22 {
                let uri = SpotifyUri::from_uri(&format!("spotify:playlist:{key}"))?;
                let playlist = Playlist::get(session, &uri)
                    .await
                    .context("Spotify cannot open this playlist")?;
                ensure!(
                    playlist.contents.position == 0 && !playlist.contents.is_truncated,
                    "Spotify returned an incomplete playlist"
                );
                listing.uris = playlist.tracks().map(|uri| uri.to_uri()).collect();
            } else {
                let uri = if key == "liked" {
                    format!("spotify:user:{identity}:collection")
                } else if let Some(query) = key.strip_prefix("search:") {
                    let encoded = url::form_urlencoded::Serializer::new(String::new())
                        .append_pair("q", query)
                        .finish();
                    format!(
                        "spotify:search:{}",
                        encoded.strip_prefix("q=").unwrap_or_default()
                    )
                } else {
                    format!("spotify:{key}")
                };
                listing.pages = listing_pages(
                    session
                        .spclient()
                        .get_context(&uri)
                        .await
                        .context("Spotify browsing context unavailable")?,
                );
            }
            cache.insert(cache_key.clone(), listing);
        }
        let listing = cache
            .get_mut(&cache_key)
            .context("Browse cache unavailable")?;
        let mut visited = 0;
        while listing.uris.len() < wanted {
            let Some(page) = listing.pages.pop_front() else {
                break;
            };
            visited += 1;
            ensure!(visited <= 512, "Spotify returned too many empty pages");
            let rows = page["tracks"].as_array();
            if rows.is_none_or(Vec::is_empty)
                && let Some(url) = page["page_url"].as_str().filter(|url| !url.is_empty())
                && listing.visited.insert(url.to_owned())
            {
                ensure!(
                    url.starts_with("hm://") || url.starts_with('/'),
                    "Rejected unexpected Spotify page URL"
                );
                let bytes = session.spclient().get_next_page(url).await?;
                ensure!(bytes.len() <= 4_000_000, "Spotify page is too large");
                listing.pages.push_front(serde_json::from_slice(&bytes)?);
                continue;
            }
            if let Some(rows) = rows {
                listing.uris.extend(
                    rows.iter()
                        .filter_map(|row| row["uri"].as_str())
                        .filter(|uri| SpotifyUri::from_uri(uri).is_ok())
                        .map(str::to_owned),
                );
            }
            let next = page["next_page_url"].as_str();
            if let Some(next) = next.filter(|url| !url.is_empty())
                && !listing.visited.contains(next)
            {
                ensure!(
                    next.starts_with("hm://") || next.starts_with('/'),
                    "Rejected unexpected Spotify page URL"
                );
                listing.pages.push_back(json!({"page_url":next}));
            }
        }
        listing
            .uris
            .iter()
            .skip(offset)
            .take(50)
            .cloned()
            .collect::<Vec<_>>()
    };
    let mut result = Vec::with_capacity(uris.len());
    for batch in uris.chunks(10) {
        let mut requests = tokio::task::JoinSet::new();
        for (index, uri) in batch.iter().cloned().enumerate() {
            let session = session.clone();
            let identity = identity.clone();
            requests.spawn(async move {
                let cache_key = (identity, uri.clone());
                let cached = TRACKS
                    .get_or_init(Default::default)
                    .lock()
                    .ok()
                    .and_then(|cache| cache.get(&cache_key).cloned());
                let track = if let Some(track) = cached {
                    track
                } else {
                    let fallback = Track {
                        uri: uri.clone(),
                        name: "Unavailable track".into(),
                        is_local: true,
                        ..Track::default()
                    };
                    let value = match SpotifyUri::from_uri(&uri) {
                        Ok(uri) => librespot_metadata::Track::get(&session, &uri)
                            .await
                            .ok()
                            .and_then(|item| crate::native::metadata_track(&item))
                            .unwrap_or(fallback),
                        Err(_) => fallback,
                    };
                    if !value.is_local
                        && let Ok(mut cache) = TRACKS.get_or_init(Default::default).lock()
                    {
                        if cache.len() >= 8192 {
                            cache.clear();
                        }
                        cache.insert(cache_key, value.clone());
                    }
                    value
                };
                (index, track)
            });
        }
        let mut ordered = Vec::new();
        while let Some(item) = requests.join_next().await {
            ordered.push(item.context("Track metadata request interrupted")?);
        }
        ordered.sort_by_key(|(index, _)| *index);
        result.extend(ordered.into_iter().map(|(_, track)| track));
    }
    Ok(result)
}
