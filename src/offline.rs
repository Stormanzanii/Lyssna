//! Downloaded songs, under Spotify's offline rules: only chosen playlists and
//! albums, at most 10,000 songs, playable while the account has been online
//! within the last 30 days, and removed on sign-out. Audio stays encrypted as
//! Spotify sends it; its keys are sealed to the Windows account.

use anyhow::{Context, Result, bail};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};

pub const MAX_SONGS: usize = 10_000;
pub const ONLINE_EVERY_SECS: u64 = 30 * 24 * 60 * 60;

#[derive(Clone, Default, Deserialize, Serialize)]
pub struct Collection {
    pub uri: String,
    pub name: String,
    #[serde(default)]
    pub image: Option<String>,
    pub tracks: Vec<String>,
}

#[derive(Clone, Deserialize, Serialize)]
pub struct Download {
    pub track: crate::model::Track,
    pub file_id: String,
    pub format: String,
    pub sealed_key: String,
}

#[derive(Default, Deserialize, Serialize)]
pub struct Manifest {
    #[serde(default)]
    pub last_online: u64,
    #[serde(default)]
    pub collections: Vec<Collection>,
    #[serde(default)]
    pub tracks: BTreeMap<String, Download>,
}

impl Manifest {
    pub fn locked(&self, now: u64) -> bool {
        now.saturating_sub(self.last_online) > ONLINE_EVERY_SECS
    }

    fn wanted(&self) -> BTreeSet<&str> {
        self.collections
            .iter()
            .flat_map(|collection| collection.tracks.iter().map(String::as_str))
            .collect()
    }

    /// Adds or refreshes a collection; returns its songs not yet on disk.
    pub fn add_collection(&mut self, collection: Collection) -> Result<Vec<String>> {
        let mut wanted: BTreeSet<&str> = self
            .collections
            .iter()
            .filter(|kept| kept.uri != collection.uri)
            .flat_map(|kept| kept.tracks.iter().map(String::as_str))
            .collect();
        wanted.extend(collection.tracks.iter().map(String::as_str));
        if wanted.len() > MAX_SONGS {
            bail!("Spotify allows {MAX_SONGS} downloaded songs on a device");
        }
        let missing = collection
            .tracks
            .iter()
            .filter(|uri| !self.tracks.contains_key(*uri))
            .cloned()
            .collect::<BTreeSet<_>>()
            .into_iter()
            .collect();
        match self
            .collections
            .iter_mut()
            .find(|kept| kept.uri == collection.uri)
        {
            Some(kept) => *kept = collection,
            None => self.collections.push(collection),
        }
        Ok(missing)
    }

    /// Removes a collection; returns audio files no other collection needs.
    pub fn remove_collection(&mut self, uri: &str) -> Vec<String> {
        self.collections.retain(|collection| collection.uri != uri);
        self.prune()
    }

    fn prune(&mut self) -> Vec<String> {
        let wanted: BTreeSet<String> = self.wanted().into_iter().map(str::to_owned).collect();
        let mut unused = Vec::new();
        self.tracks.retain(|uri, download| {
            let keep = wanted.contains(uri);
            if !keep {
                unused.push(download.file_id.clone());
            }
            keep
        });
        let kept: BTreeSet<&str> = self
            .tracks
            .values()
            .map(|download| download.file_id.as_str())
            .collect();
        unused.retain(|file| !kept.contains(file.as_str()));
        unused
    }

    pub fn record(&mut self, uri: &str, download: Download) -> bool {
        if !self.wanted().contains(uri) {
            return false;
        }
        self.tracks.insert(uri.to_owned(), download);
        true
    }

    pub fn playable(&self, uri: &str, now: u64) -> Option<&Download> {
        if self.locked(now) {
            return None;
        }
        self.tracks.get(uri)
    }

    pub fn is_downloaded(&self, collection: &str) -> Option<(usize, usize)> {
        let collection = self
            .collections
            .iter()
            .find(|kept| kept.uri == collection)?;
        let done = collection
            .tracks
            .iter()
            .filter(|uri| self.tracks.contains_key(*uri))
            .count();
        Some((done, collection.tracks.len()))
    }
}

pub fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |elapsed| elapsed.as_secs())
}

pub fn base_directory() -> Result<PathBuf> {
    let chosen = crate::config::Settings::load()
        .ok()
        .and_then(|settings| settings.offline_location);
    match chosen {
        Some(folder) => Ok(inside(Path::new(&folder))),
        None => default_directory(),
    }
}

pub fn default_directory() -> Result<PathBuf> {
    let dirs = directories::ProjectDirs::from("", "", "Lyssna")
        .context("Cannot locate the Lyssna data directory")?;
    Ok(dirs.data_local_dir().join("offline"))
}

/// Downloads live in their own subfolder of a chosen folder, so removing
/// them on sign-out never touches the listener's other files.
pub fn inside(folder: &Path) -> PathBuf {
    folder.join("Lyssna Downloads")
}

/// Moves every download to `to`, copying when it is on another drive.
pub fn move_all(from: &Path, to: &Path) -> Result<()> {
    if from == to || !from.exists() {
        return Ok(());
    }
    if to
        .read_dir()
        .is_ok_and(|mut entries| entries.next().is_some())
    {
        bail!("That folder already holds Lyssna downloads");
    }
    if let Some(parent) = to.parent() {
        fs::create_dir_all(parent)?;
    }
    let _ = fs::remove_dir(to);
    if fs::rename(from, to).is_ok() {
        return Ok(());
    }
    copy_tree(from, to).inspect_err(|_| {
        let _ = fs::remove_dir_all(to);
    })?;
    fs::remove_dir_all(from)?;
    Ok(())
}

fn copy_tree(from: &Path, to: &Path) -> Result<()> {
    fs::create_dir_all(to)?;
    for entry in fs::read_dir(from)? {
        let entry = entry?;
        let target = to.join(entry.file_name());
        if entry.file_type()?.is_dir() {
            copy_tree(&entry.path(), &target)?;
        } else {
            fs::copy(entry.path(), &target)?;
        }
    }
    Ok(())
}

pub struct Store {
    root: PathBuf,
}

impl Store {
    pub fn for_account(account: &str) -> Result<Self> {
        Ok(Self::at(base_directory()?, account))
    }

    fn at(base: PathBuf, account: &str) -> Self {
        let digest = Sha256::digest(account.as_bytes());
        let key: String = digest.iter().map(|byte| format!("{byte:02x}")).collect();
        Self {
            root: base.join(key),
        }
    }

    fn manifest_path(&self) -> PathBuf {
        self.root.join("manifest.json")
    }

    pub fn file_path(&self, file_id: &str) -> Option<PathBuf> {
        (!file_id.is_empty() && file_id.bytes().all(|byte| byte.is_ascii_hexdigit()))
            .then(|| self.root.join("files").join(file_id))
    }

    pub fn load(&self) -> Manifest {
        fs::read(self.manifest_path())
            .ok()
            .and_then(|bytes| serde_json::from_slice(&bytes).ok())
            .unwrap_or_default()
    }

    pub fn save(&self, manifest: &Manifest) -> Result<()> {
        fs::create_dir_all(&self.root)?;
        let temporary = self.root.join("manifest.json.tmp");
        fs::write(&temporary, serde_json::to_vec(manifest)?)?;
        fs::rename(&temporary, self.manifest_path())?;
        Ok(())
    }

    pub fn write_file(&self, file_id: &str, bytes: &[u8]) -> Result<()> {
        let path = self.file_path(file_id).context("Invalid audio file id")?;
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)?;
        }
        let temporary = path.with_extension("part");
        fs::write(&temporary, bytes)?;
        fs::rename(&temporary, &path)?;
        Ok(())
    }

    pub fn remove_files(&self, file_ids: &[String]) {
        for path in file_ids.iter().filter_map(|id| self.file_path(id)) {
            let _ = fs::remove_file(path);
        }
    }

    pub fn seen_online(&self) -> Result<()> {
        let mut manifest = self.load();
        if manifest.collections.is_empty() && manifest.last_online == 0 {
            return Ok(());
        }
        manifest.last_online = now();
        self.save(&manifest)
    }

    pub fn wipe(&self) -> Result<()> {
        match fs::remove_dir_all(&self.root) {
            Err(error) if error.kind() != std::io::ErrorKind::NotFound => Err(error.into()),
            _ => Ok(()),
        }
    }

    pub fn size(&self) -> u64 {
        size_in(&self.root.join("files"))
    }
}

fn size_in(directory: &Path) -> u64 {
    fs::read_dir(directory).map_or(0, |entries| {
        entries
            .flatten()
            .filter_map(|entry| entry.metadata().ok())
            .filter(fs::Metadata::is_file)
            .map(|data| data.len())
            .sum()
    })
}

/// Removes every account's downloads, as Spotify does when you sign out.
pub fn wipe_all() -> Result<()> {
    match fs::remove_dir_all(base_directory()?) {
        Err(error) if error.kind() != std::io::ErrorKind::NotFound => Err(error.into()),
        _ => Ok(()),
    }
}

pub fn seal_key(key: &[u8; 16]) -> Result<String> {
    use base64::Engine;
    Ok(base64::engine::general_purpose::STANDARD.encode(dpapi::protect(key)?))
}

pub fn open_key(sealed: &str) -> Result<[u8; 16]> {
    use base64::Engine;
    let blob = base64::engine::general_purpose::STANDARD.decode(sealed)?;
    dpapi::unprotect(&blob)?
        .try_into()
        .map_err(|_| anyhow::anyhow!("Downloaded song key is damaged"))
}

#[cfg(windows)]
mod dpapi {
    use anyhow::{Result, anyhow};
    use windows::Win32::{
        Foundation::{HLOCAL, LocalFree},
        Security::Cryptography::{
            CRYPT_INTEGER_BLOB, CRYPTPROTECT_UI_FORBIDDEN, CryptProtectData, CryptUnprotectData,
        },
    };

    fn take(blob: CRYPT_INTEGER_BLOB) -> Vec<u8> {
        // SAFETY: the blob was allocated by DPAPI and is freed exactly once here.
        unsafe {
            let bytes = std::slice::from_raw_parts(blob.pbData, blob.cbData as usize).to_vec();
            LocalFree(Some(HLOCAL(blob.pbData.cast())));
            bytes
        }
    }

    pub fn protect(data: &[u8]) -> Result<Vec<u8>> {
        let input = CRYPT_INTEGER_BLOB {
            cbData: data.len() as u32,
            pbData: data.as_ptr().cast_mut(),
        };
        let mut output = CRYPT_INTEGER_BLOB::default();
        // SAFETY: input outlives the call; output is freed by `take`.
        unsafe {
            CryptProtectData(
                &input,
                None,
                None,
                None,
                None,
                CRYPTPROTECT_UI_FORBIDDEN,
                &mut output,
            )
        }
        .map_err(|error| anyhow!("Cannot seal downloaded song key: {error}"))?;
        Ok(take(output))
    }

    pub fn unprotect(data: &[u8]) -> Result<Vec<u8>> {
        let input = CRYPT_INTEGER_BLOB {
            cbData: data.len() as u32,
            pbData: data.as_ptr().cast_mut(),
        };
        let mut output = CRYPT_INTEGER_BLOB::default();
        // SAFETY: input outlives the call; output is freed by `take`.
        unsafe {
            CryptUnprotectData(
                &input,
                None,
                None,
                None,
                None,
                CRYPTPROTECT_UI_FORBIDDEN,
                &mut output,
            )
        }
        .map_err(|error| anyhow!("Cannot open downloaded song key: {error}"))?;
        Ok(take(output))
    }
}

#[cfg(not(windows))]
mod dpapi {
    use anyhow::{Result, bail};

    pub fn protect(_: &[u8]) -> Result<Vec<u8>> {
        bail!("Downloads need Windows")
    }

    pub fn unprotect(_: &[u8]) -> Result<Vec<u8>> {
        bail!("Downloads need Windows")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn collection(uri: &str, tracks: &[&str]) -> Collection {
        Collection {
            uri: uri.into(),
            name: uri.into(),
            image: None,
            tracks: tracks.iter().map(|track| (*track).into()).collect(),
        }
    }

    fn download(file_id: &str) -> Download {
        Download {
            track: crate::model::Track::default(),
            file_id: file_id.into(),
            format: "OGG_VORBIS_160".into(),
            sealed_key: String::new(),
        }
    }

    #[test]
    fn songs_shared_by_two_downloads_stay_until_both_are_removed() {
        let mut manifest = Manifest::default();
        assert_eq!(
            manifest
                .add_collection(collection("spotify:album:a", &["t1", "t2"]))
                .unwrap(),
            ["t1", "t2"]
        );
        assert!(manifest.record("t1", download("aa")));
        assert!(manifest.record("t2", download("bb")));
        assert_eq!(
            manifest
                .add_collection(collection("spotify:playlist:p", &["t2", "t3"]))
                .unwrap(),
            ["t3"]
        );
        assert_eq!(manifest.remove_collection("spotify:album:a"), ["aa"]);
        assert!(manifest.tracks.contains_key("t2"));
        assert_eq!(manifest.remove_collection("spotify:playlist:p"), ["bb"]);
        assert!(manifest.tracks.is_empty());
    }

    #[test]
    fn a_song_from_a_removed_download_is_not_recorded() {
        let mut manifest = Manifest::default();
        assert!(!manifest.record("t1", download("aa")));
    }

    #[test]
    fn downloads_beyond_ten_thousand_songs_are_refused() {
        let mut manifest = Manifest::default();
        let many: Vec<String> = (0..MAX_SONGS).map(|index| format!("t{index}")).collect();
        let refs: Vec<&str> = many.iter().map(String::as_str).collect();
        manifest
            .add_collection(collection("spotify:playlist:big", &refs))
            .unwrap();
        assert!(
            manifest
                .add_collection(collection("spotify:album:one", &["extra"]))
                .is_err()
        );
        assert!(
            manifest
                .add_collection(collection("spotify:album:same", &["t0"]))
                .is_ok(),
            "songs already counted do not count twice"
        );
    }

    #[test]
    fn downloads_lock_after_thirty_days_offline() {
        let mut manifest = Manifest {
            last_online: 1_000,
            ..Manifest::default()
        };
        manifest
            .add_collection(collection("spotify:album:a", &["t1"]))
            .unwrap();
        manifest.record("t1", download("aa"));
        assert!(manifest.playable("t1", 1_000 + ONLINE_EVERY_SECS).is_some());
        assert!(manifest.playable("t1", 1_001 + ONLINE_EVERY_SECS).is_none());
    }

    #[test]
    fn signing_out_removes_the_downloads() {
        let base = std::env::temp_dir().join(format!("lyssna-offline-{}", std::process::id()));
        let store = Store::at(base.clone(), "listener");
        let mut manifest = Manifest::default();
        manifest
            .add_collection(collection("spotify:album:a", &["t1"]))
            .unwrap();
        store.save(&manifest).unwrap();
        store.write_file("abcd", b"audio").unwrap();
        assert_eq!(store.size(), 5);
        assert_eq!(store.load().collections.len(), 1);
        store.wipe().unwrap();
        assert!(store.load().collections.is_empty());
        assert_eq!(store.size(), 0);
        let _ = fs::remove_dir_all(base);
    }

    #[test]
    fn moving_downloads_keeps_them_and_refuses_a_used_folder() {
        let base = std::env::temp_dir().join(format!("lyssna-move-{}", std::process::id()));
        let from = base.join("old");
        let store = Store::at(from.clone(), "listener");
        store.write_file("abcd", b"audio").unwrap();
        let to = inside(&base.join("chosen"));
        move_all(&from, &to).unwrap();
        assert!(!from.exists());
        assert_eq!(Store::at(to.clone(), "listener").size(), 5);
        let other = base.join("other");
        Store::at(other.clone(), "listener")
            .write_file("ef", b"x")
            .unwrap();
        assert!(move_all(&other, &to).is_err());
        assert_eq!(Store::at(to, "listener").size(), 5);
        let _ = fs::remove_dir_all(base);
    }

    #[test]
    fn file_ids_cannot_leave_the_download_folder() {
        let store = Store::at(PathBuf::from("base"), "listener");
        assert!(store.file_path("..\\x").is_none());
        assert!(store.file_path("").is_none());
        assert!(store.file_path("0aF9").is_some());
    }

    #[cfg(windows)]
    #[test]
    fn song_keys_are_sealed_to_the_windows_account() {
        let key = [7u8; 16];
        let sealed = seal_key(&key).unwrap();
        assert!(!sealed.contains("BwcHBwcH"));
        assert_eq!(open_key(&sealed).unwrap(), key);
    }
}
