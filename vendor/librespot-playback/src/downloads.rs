use std::{
    collections::HashMap,
    path::PathBuf,
    sync::{LazyLock, RwLock},
};

use crate::{core::SpotifyUri, metadata::audio::AudioFileFormat};

#[derive(Clone, Debug)]
pub struct Downloaded {
    pub path: PathBuf,
    pub key: [u8; 16],
    pub format: AudioFileFormat,
    pub name: String,
    pub duration_ms: u32,
}

static SHARED: LazyLock<RwLock<HashMap<SpotifyUri, Downloaded>>> = LazyLock::new(Default::default);

/// Songs the application has downloaded and may play now; they load from
/// disk instead of Spotify, so they play without a connection.
pub fn set_downloads(downloads: HashMap<SpotifyUri, Downloaded>) {
    if let Ok(mut shared) = SHARED.write() {
        *shared = downloads;
    }
}

pub(crate) fn downloaded(uri: &SpotifyUri) -> Option<Downloaded> {
    SHARED.read().ok()?.get(uri).cloned()
}
