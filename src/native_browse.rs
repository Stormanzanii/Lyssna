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
pub async fn playlist_info(session: &Session, id: &str) -> Result<crate::model::BrowseInfo> {
    ensure!(
        id.len() == 22 && id.bytes().all(|byte| byte.is_ascii_alphanumeric()),
        "Invalid playlist ID"
    );
    let uri = SpotifyUri::from_uri(&format!("spotify:playlist:{id}"))?;
    let playlist = tokio::time::timeout(Duration::from_secs(8), Playlist::get(session, &uri))
        .await
        .context("Playlist metadata request timed out")??;
    ensure!(
        !playlist.attributes.name.is_empty(),
        "Playlist name unavailable"
    );
    Ok(playlist_header(id, &playlist))
}
fn playlist_header(id: &str, playlist: &Playlist) -> crate::model::BrowseInfo {
    use crate::model::{Artwork, BrowseInfo, PlaylistDetails};
    let mut images: Vec<_> = playlist
        .attributes
        .picture_sizes
        .iter()
        .filter(|picture| picture.url.starts_with("https://"))
        .map(|picture| Artwork {
            url: picture.url.clone(),
            width: None,
        })
        .collect();
    if images.is_empty() && playlist.attributes.picture.len() == 20 {
        let file: String = playlist
            .attributes
            .picture
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect();
        images.push(Artwork {
            url: format!("https://i.scdn.co/image/{file}"),
            width: None,
        });
    }
    let owner = match &playlist.id {
        SpotifyUri::Playlist { user, .. } => user.clone().unwrap_or_default(),
        _ => String::new(),
    };
    BrowseInfo {
        key: format!("playlist:{id}"),
        title: playlist.attributes.name.clone(),
        subtitle: playlist.attributes.description.clone(),
        images,
        playlist: Some(PlaylistDetails {
            owner,
            total_tracks: usize::try_from(playlist.length).ok(),
            format: playlist.attributes.format.clone(),
        }),
        ..BrowseInfo::default()
    }
}

const ROOTLIST_PAGE: usize = 120;

/// Every saved playlist in Spotify library order, read from the account's
/// rootlist like the desktop client. Folder markers are skipped.
pub async fn library(session: &Session) -> Result<Vec<crate::model::Playlist>> {
    use protobuf::Message;
    let mut playlists = Vec::new();
    let mut ids = HashSet::new();
    let mut from = 0;
    for _ in 0..100 {
        let bytes = tokio::time::timeout(
            Duration::from_secs(10),
            session.spclient().get_rootlist(from, Some(ROOTLIST_PAGE)),
        )
        .await
        .context("Spotify library request timed out")??;
        ensure!(
            bytes.len() <= 8_000_000,
            "Spotify library page is too large"
        );
        let page =
            librespot_protocol::playlist4_external::SelectedListContent::parse_from_bytes(&bytes)
                .context("Invalid Spotify library page")?;
        let count = rootlist_page(&page, &mut ids, &mut playlists)?;
        from += count;
        let total = usize::try_from(page.length()).unwrap_or_default();
        if count == 0 || (from >= total && count < ROOTLIST_PAGE) {
            return Ok(playlists);
        }
    }
    anyhow::bail!("Spotify library has too many pages")
}

/// Adds one rootlist page and returns how many rows it held.
fn rootlist_page(
    page: &librespot_protocol::playlist4_external::SelectedListContent,
    ids: &mut HashSet<String>,
    playlists: &mut Vec<crate::model::Playlist>,
) -> Result<usize> {
    let contents = page.contents.get_or_default();
    ensure!(
        contents.items.len() == contents.meta_items.len(),
        "Spotify library page has no playlist details"
    );
    for (item, meta) in contents.items.iter().zip(&contents.meta_items) {
        let Some(id) = item
            .uri()
            .strip_prefix("spotify:")
            .and_then(|uri| uri.rsplit_once("playlist:"))
            .map(|(_, id)| id)
            .filter(|id| id.len() == 22 && id.bytes().all(|byte| byte.is_ascii_alphanumeric()))
        else {
            continue;
        };
        let attributes = meta.attributes.get_or_default();
        if attributes.name().is_empty() || !ids.insert(id.to_owned()) {
            continue;
        }
        playlists.push(crate::model::Playlist {
            id: id.to_owned(),
            name: attributes.name().to_owned(),
            images: list_images(attributes),
            owner: crate::model::Owner {
                id: meta.owner_username().to_owned(),
                display_name: None,
            },
            collaborative: attributes.collaborative(),
        });
    }
    Ok(contents.items.len())
}

fn list_images(
    attributes: &librespot_protocol::playlist4_external::ListAttributes,
) -> Vec<crate::model::Artwork> {
    let mut images: Vec<_> = attributes
        .picture_size
        .iter()
        .filter(|picture| picture.url().starts_with("https://"))
        .map(|picture| crate::model::Artwork {
            url: picture.url().to_owned(),
            width: None,
        })
        .collect();
    if images.is_empty() && attributes.picture().len() == 20 {
        let file: String = attributes
            .picture()
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect();
        images.push(crate::model::Artwork {
            url: format!("https://i.scdn.co/image/{file}"),
            width: None,
        });
    }
    images
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
    resolve_tracks(session, &uris).await
}

pub(crate) async fn resolve_tracks(session: &Session, uris: &[String]) -> Result<Vec<Track>> {
    ensure!(uris.len() <= 50, "Too many queued tracks");
    let identity = session.username();
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

#[cfg(test)]
mod rootlist_tests {
    use super::*;
    use librespot_protocol::playlist4_external::{
        Item, ListAttributes, ListItems, MetaItem, SelectedListContent,
    };
    fn page(rows: &[(&str, &str, &str)]) -> SelectedListContent {
        let mut contents = ListItems::new();
        for (uri, name, owner) in rows {
            let mut item = Item::new();
            item.set_uri((*uri).into());
            contents.items.push(item);
            let mut meta = MetaItem::new();
            if !name.is_empty() {
                let mut attributes = ListAttributes::new();
                attributes.set_name((*name).into());
                attributes.set_collaborative(*name == "Shared");
                meta.attributes = Some(attributes).into();
                meta.set_owner_username((*owner).into());
            }
            contents.meta_items.push(meta);
        }
        let mut page = SelectedListContent::new();
        page.contents = Some(contents).into();
        page
    }
    #[test]
    fn library_skips_folders_and_keeps_private_and_collaborative_playlists() {
        let (mut ids, mut playlists) = (HashSet::new(), Vec::new());
        let count = rootlist_page(
            &page(&[
                ("spotify:start-group:abc:Folder", "", ""),
                ("spotify:playlist:0123456789abcdefghijkl", "Mine", "me"),
                (
                    "spotify:user:friend:playlist:abcdefghijkl0123456789",
                    "Shared",
                    "friend",
                ),
                ("spotify:end-group:abc", "", ""),
                ("spotify:playlist:0123456789abcdefghijkl", "Mine", "me"),
            ]),
            &mut ids,
            &mut playlists,
        )
        .unwrap();
        assert_eq!(count, 5);
        let names: Vec<_> = playlists.iter().map(|item| item.name.as_str()).collect();
        assert_eq!(names, ["Mine", "Shared"]);
        assert_eq!(playlists[1].id, "abcdefghijkl0123456789");
        assert_eq!(playlists[1].owner.id, "friend");
        assert!(playlists[1].collaborative && !playlists[0].collaborative);
    }
    #[test]
    fn library_page_without_details_is_rejected() {
        let mut broken = page(&[("spotify:playlist:0123456789abcdefghijkl", "Mine", "me")]);
        broken.contents.mut_or_insert_default().meta_items.clear();
        assert!(rootlist_page(&broken, &mut HashSet::new(), &mut Vec::new()).is_err());
    }
}

#[cfg(test)]
mod playlist_header_tests {
    use super::*;
    #[test]
    fn generated_playlist_metadata_is_independent_of_saved_library() {
        let id = "0123456789abcdefghijkl";
        let mut attributes = librespot_protocol::playlist4_external::ListAttributes::new();
        attributes.set_name("Daily Mix 1".into());
        attributes.set_description("Your favorite artists".into());
        attributes.set_format("daily-mix".into());
        let mut picture = librespot_protocol::playlist4_external::PictureSize::new();
        picture.set_url("https://artwork.example.test/mix".into());
        attributes.picture_size.push(picture);
        let mut data = librespot_protocol::playlist4_external::SelectedListContent::new();
        data.attributes = Some(attributes).into();
        data.set_length(50);
        data.set_owner_username("spotify".into());
        data.set_timestamp(1);
        let playlist = Playlist::parse(
            &data,
            &SpotifyUri::from_uri(&format!("spotify:playlist:{id}")).unwrap(),
        )
        .unwrap();
        let info = playlist_header(id, &playlist);
        assert_eq!(info.title, "Daily Mix 1");
        assert_eq!(info.subtitle, "Your favorite artists");
        assert_eq!(info.images[0].url, "https://artwork.example.test/mix");
        let details = info.playlist.unwrap();
        assert_eq!(details.owner, "spotify");
        assert_eq!(details.total_tracks, Some(50));
        assert_eq!(details.format, "daily-mix");
    }
}
