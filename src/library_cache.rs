use crate::home::HomePage;
use crate::model::BrowseInfo;
use crate::model::Playlist;
use crate::model::Track;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

#[derive(Deserialize, Serialize)]
struct CachedInfo {
    account: String,
    info: BrowseInfo,
}
static INFO_WRITE: std::sync::Mutex<()> = std::sync::Mutex::new(());
fn info_path(account: &str, key: &str) -> Option<std::path::PathBuf> {
    let root = account_file("browse-info", account)?.with_extension("");
    let tracks = tracks_path(account, key, 0)?;
    Some(root.join(tracks.file_name()?).with_extension("info.json"))
}
pub fn info(account: &str, key: &str) -> Option<BrowseInfo> {
    let path = info_path(account, key)?;
    if std::fs::metadata(&path).ok()?.len() > 4_000_000 {
        return None;
    }
    decode_info(&std::fs::read(path).ok()?, account, key)
}
fn decode_info(bytes: &[u8], account: &str, key: &str) -> Option<BrowseInfo> {
    if bytes.len() > 4_000_000 {
        return None;
    }
    let value: CachedInfo = serde_json::from_slice(bytes).ok()?;
    (value.account == account && value.info.key == key).then_some(value.info)
}
pub fn info_is_fresh(account: &str, key: &str) -> bool {
    info_path(account, key)
        .and_then(|path| std::fs::metadata(path).ok())
        .and_then(|metadata| metadata.modified().ok())
        .and_then(|modified| modified.elapsed().ok())
        .is_some_and(|age| age < std::time::Duration::from_secs(21600))
}
pub fn merge_info(mut incoming: BrowseInfo, previous: Option<BrowseInfo>) -> BrowseInfo {
    if let Some(previous) = previous.filter(|previous| previous.key == incoming.key) {
        if incoming.title.is_empty() {
            incoming.title = previous.title;
        }
        if incoming.subtitle.is_empty() {
            incoming.subtitle = previous.subtitle;
        }
        incoming.artist = incoming.artist.or(previous.artist);
        if incoming.images.is_empty() {
            incoming.images = previous.images;
        }
        if incoming.albums.is_empty() {
            incoming.albums = previous.albums;
        }
        incoming.overview = incoming.overview.or(previous.overview);
        incoming.album_details = match (incoming.album_details, previous.album_details) {
            (Some(mut fresh), Some(old)) => {
                for (uri, count) in old.streams {
                    fresh.streams.entry(uri).or_insert(count);
                }
                if !fresh.complete_duration && old.complete_duration {
                    fresh.duration_ms = old.duration_ms;
                    fresh.complete_duration = true;
                }
                if fresh.copyrights.is_empty() {
                    fresh.copyrights = old.copyrights;
                }
                if fresh.more.is_empty() {
                    fresh.more = old.more;
                }
                Some(fresh)
            }
            (fresh, old) => fresh.or(old),
        };
        incoming.playlist = incoming.playlist.or(previous.playlist);
        incoming.album = incoming.album.or(previous.album);
    }
    incoming
}
pub fn save_info(account: &str, incoming: BrowseInfo) -> BrowseInfo {
    let Ok(_guard) = INFO_WRITE.lock() else {
        return incoming;
    };
    let value = merge_info(incoming.clone(), info(account, &incoming.key));
    if let Some(path) = info_path(account, &value.key) {
        write(
            &path,
            &CachedInfo {
                account: account.into(),
                info: value.clone(),
            },
        );
        if let Some(parent) = path.parent()
            && let Ok(entries) = std::fs::read_dir(parent)
        {
            let mut files: Vec<_> = entries
                .flatten()
                .filter(|entry| {
                    entry.file_name().to_string_lossy().ends_with(".info.json")
                        && entry.file_type().is_ok_and(|kind| kind.is_file())
                })
                .collect();
            if files.len() > 512 {
                files.sort_by_key(|entry| {
                    entry
                        .metadata()
                        .and_then(|data| data.modified())
                        .unwrap_or(std::time::UNIX_EPOCH)
                });
                let excess = files.len() - 512;
                for entry in files.into_iter().take(excess) {
                    let _ = std::fs::remove_file(entry.path());
                }
            }
        }
    }
    value
}

fn path(account: &str) -> Option<std::path::PathBuf> {
    account_file("library", account)
}
fn account_file(folder: &str, account: &str) -> Option<std::path::PathBuf> {
    let key = Sha256::digest(account)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    Some(
        crate::config::data_dir()
            .ok()?
            .join(folder)
            .join(format!("{key}.json")),
    )
}
pub fn load(account: &str) -> Option<Vec<Playlist>> {
    let path = path(account)?;
    if std::fs::metadata(&path).ok()?.len() > 4_000_000 {
        return None;
    }
    serde_json::from_slice(&std::fs::read(path).ok()?).ok()
}
pub fn save(account: &str, playlists: &[Playlist]) {
    if let Some(path) = path(account) {
        write(&path, playlists);
    }
}
/// Last personalized Home for an account, shown until a fresh feed arrives.
pub fn home(account: &str) -> Option<HomePage> {
    let path = account_file("home", account)?;
    if std::fs::metadata(&path).ok()?.len() > 4_000_000 {
        return None;
    }
    let mut page: HomePage = serde_json::from_slice(&std::fs::read(path).ok()?).ok()?;
    if page.account != account {
        return None;
    }
    page.cached = true;
    Some(page)
}
pub fn save_home(page: &HomePage) {
    if let Some(path) = account_file("home", &page.account) {
        write(&path, page);
    }
}
fn write<T: serde::Serialize + ?Sized>(path: &std::path::Path, value: &T) {
    let Ok(bytes) = serde_json::to_vec(value) else {
        return;
    };
    if bytes.len() > 4_000_000 {
        return;
    }
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let temporary = path.with_extension("tmp");
    if std::fs::write(&temporary, bytes).is_ok() {
        let _ = std::fs::rename(temporary, path);
    }
}
fn tracks_path(account: &str, key: &str, offset: usize) -> Option<std::path::PathBuf> {
    let account = Sha256::digest(account)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    let key = Sha256::digest(key)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    Some(
        crate::config::data_dir()
            .ok()?
            .join("browse-cache")
            .join(account)
            .join(format!("{key}-{offset}.json")),
    )
}
pub fn tracks(account: &str, key: &str, offset: usize) -> Option<Vec<Track>> {
    let path = tracks_path(account, key, offset)?;
    if std::fs::metadata(&path).ok()?.len() > 4_000_000 {
        return None;
    }
    let tracks: Vec<Track> = serde_json::from_slice(&std::fs::read(path).ok()?).ok()?;
    if tracks.len() > 50 {
        return None;
    }
    Some(tracks)
}
/// Every song seen in cached pages, by the SHA-256 of its URI. Used to name
/// lyric imports saved before names and artwork were kept.
pub fn known_tracks() -> std::collections::HashMap<String, Track> {
    let mut known = std::collections::HashMap::new();
    let Some(root) = crate::config::data_dir()
        .ok()
        .map(|dir| dir.join("browse-cache"))
    else {
        return known;
    };
    let accounts = std::fs::read_dir(root).into_iter().flatten().flatten();
    let files = accounts
        .filter_map(|account| std::fs::read_dir(account.path()).ok())
        .flatten()
        .flatten()
        .take(20_000);
    for file in files {
        let path = file.path();
        if path.extension().and_then(|value| value.to_str()) != Some("json")
            || std::fs::metadata(&path).map_or(true, |meta| meta.len() > 4_000_000)
        {
            continue;
        }
        let Ok(tracks) = std::fs::read(&path)
            .map_err(|_| ())
            .and_then(|bytes| serde_json::from_slice::<Vec<Track>>(&bytes).map_err(|_| ()))
        else {
            continue;
        };
        for track in tracks {
            let key = Sha256::digest(track.uri.as_bytes())
                .iter()
                .map(|byte| format!("{byte:02x}"))
                .collect::<String>();
            known.entry(key).or_insert(track);
        }
    }
    known
}
pub fn save_tracks(account: &str, key: &str, offset: usize, tracks: &[Track]) {
    let Some(path) = tracks_path(account, key, offset) else {
        return;
    };
    let Ok(bytes) = serde_json::to_vec(tracks) else {
        return;
    };
    if bytes.len() > 4_000_000 || tracks.len() > 50 {
        return;
    }
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let temporary = path.with_extension("tmp");
    if std::fs::write(&temporary, bytes).is_ok() {
        let _ = std::fs::rename(temporary, path);
    }
}

#[cfg(test)]
mod info_tests {
    use super::*;
    #[test]
    fn cached_metadata_is_bound_to_account_and_route() {
        let value = CachedInfo {
            account: "listener".into(),
            info: BrowseInfo {
                key: "artist:one".into(),
                title: "Artist".into(),
                ..BrowseInfo::default()
            },
        };
        let bytes = serde_json::to_vec(&value).unwrap();
        assert!(decode_info(&bytes, "listener", "artist:one").is_some());
        assert!(decode_info(&bytes, "other", "artist:one").is_none());
        assert!(decode_info(&bytes, "listener", "album:one").is_none());
    }
    #[test]
    fn partial_refresh_keeps_loaded_artwork_and_details() {
        let previous = BrowseInfo {
            key: "artist:one".into(),
            title: "Artist".into(),
            overview: Some(crate::artist::ArtistOverview {
                header_image: Some("https://artwork.example.test/banner.jpg".into()),
                monthly_listeners: Some(1234),
                ..crate::artist::ArtistOverview::default()
            }),
            images: vec![crate::model::Artwork {
                url: "https://artwork.example.test/artist.jpg".into(),
                ..crate::model::Artwork::default()
            }],
            ..BrowseInfo::default()
        };
        let merged = merge_info(
            BrowseInfo {
                key: previous.key.clone(),
                ..BrowseInfo::default()
            },
            Some(previous),
        );
        assert_eq!(merged.title, "Artist");
        assert_eq!(merged.images.len(), 1);
        assert_eq!(merged.overview.unwrap().monthly_listeners, Some(1234));
    }
    #[test]
    fn first_album_page_does_not_erase_cached_duration_or_other_stream_counts() {
        let previous = BrowseInfo {
            key: "album:one".into(),
            album_details: Some(crate::album::AlbumDetails {
                complete_duration: true,
                duration_ms: 123000,
                streams: [
                    ("spotify:track:one".into(), 100),
                    ("spotify:track:two".into(), 200),
                ]
                .into(),
                ..crate::album::AlbumDetails::default()
            }),
            ..BrowseInfo::default()
        };
        let incoming = BrowseInfo {
            key: previous.key.clone(),
            album_details: Some(crate::album::AlbumDetails {
                duration_ms: 12000,
                streams: [("spotify:track:one".into(), 150)].into(),
                ..crate::album::AlbumDetails::default()
            }),
            ..BrowseInfo::default()
        };
        let details = merge_info(incoming, Some(previous)).album_details.unwrap();
        assert!(details.complete_duration);
        assert_eq!(details.duration_ms, 123000);
        assert_eq!(details.streams["spotify:track:one"], 150);
        assert_eq!(details.streams["spotify:track:two"], 200);
    }
}
