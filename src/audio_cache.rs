//! On-disk cache of streamed songs, like Spotify's own "Cache" setting.
//! librespot stores each downloaded audio file as Spotify sends it (still
//! encrypted) and replays it from disk. Like Spotify's cache it has no size
//! limit; Settings shows its size and clears it.

use anyhow::{Context, Result};
use std::{fs, path::Path, path::PathBuf};

/// `%LOCALAPPDATA%\Lyssna\cache\audio`: machine-local, kept out of the
/// roaming profile and apart from Spotify's own installation.
pub fn directory() -> Result<PathBuf> {
    let dirs = directories::ProjectDirs::from("", "", "Lyssna")
        .context("Cannot locate the Lyssna cache directory")?;
    Ok(dirs.cache_dir().join("audio"))
}

pub fn cache() -> Result<librespot_core::cache::Cache> {
    let directory = directory()?;
    librespot_core::cache::Cache::new(None, None, Some(directory), None)
        .map_err(|error| anyhow::anyhow!("Audio cache unavailable: {error}"))
}

/// Bytes used by the cache.
pub fn size() -> u64 {
    directory().map_or(0, |directory| size_in(&directory))
}

fn size_in(directory: &Path) -> u64 {
    let Ok(entries) = fs::read_dir(directory) else {
        return 0;
    };
    entries
        .flatten()
        .map(|entry| match entry.file_type() {
            Ok(kind) if kind.is_dir() => size_in(&entry.path()),
            Ok(kind) if kind.is_file() => entry.metadata().map_or(0, |data| data.len()),
            _ => 0,
        })
        .sum()
}

/// Delete every cached song. Files in use are skipped.
pub fn clear() -> Result<u64> {
    let directory = directory()?;
    Ok(clear_in(&directory))
}

fn clear_in(directory: &Path) -> u64 {
    let Ok(entries) = fs::read_dir(directory) else {
        return 0;
    };
    let mut freed = 0;
    for entry in entries.flatten() {
        let path = entry.path();
        // Never follow links out of the cache directory.
        match entry.file_type() {
            Ok(kind) if kind.is_dir() => {
                freed += clear_in(&path);
                let _ = fs::remove_dir(&path);
            }
            Ok(kind) if kind.is_file() => {
                let length = entry.metadata().map_or(0, |data| data.len());
                if fs::remove_file(&path).is_ok() {
                    freed += length;
                }
            }
            _ => {}
        }
    }
    freed
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn size_and_clear_cover_nested_files_and_keep_the_folder() {
        let root = std::env::temp_dir().join(format!("lyssna-cache-test-{}", std::process::id()));
        let nested = root.join("ab");
        fs::create_dir_all(&nested).unwrap();
        fs::write(nested.join("cdef"), vec![0; 300]).unwrap();
        fs::write(root.join("loose"), vec![0; 200]).unwrap();
        assert_eq!(size_in(&root), 500);
        assert_eq!(clear_in(&root), 500);
        assert_eq!(size_in(&root), 0);
        assert!(root.exists());
        let _ = fs::remove_dir_all(&root);
    }
}
