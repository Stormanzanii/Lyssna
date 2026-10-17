use crate::home::HomePage;
use crate::model::Playlist;
use crate::model::Track;
use sha2::{Digest, Sha256};
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
