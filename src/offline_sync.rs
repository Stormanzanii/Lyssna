use crate::offline::{Collection, Download, Manifest, Store};
use anyhow::{Context, Result, bail};
use librespot_audio::AudioFile;
use librespot_core::{Session, SpotifyId, SpotifyUri};
use librespot_metadata::audio::{AudioFileFormat, AudioItem};
use serde::Serialize;
use std::{
    collections::HashMap,
    io::Read,
    sync::{
        LazyLock, Mutex, RwLock,
        atomic::{AtomicUsize, Ordering},
    },
};

struct Loaded {
    account: String,
    store: Store,
    manifest: Manifest,
}

static LOADED: Mutex<Option<Loaded>> = Mutex::new(None);
static TRACKS: LazyLock<RwLock<HashMap<String, crate::model::Track>>> =
    LazyLock::new(Default::default);
static DOWNLOADING: Mutex<()> = Mutex::new(());
static SIGN_OUTS: AtomicUsize = AtomicUsize::new(0);

fn with<R>(account: &str, change: impl FnOnce(&Store, &mut Manifest) -> R) -> Result<R> {
    let mut loaded = LOADED
        .lock()
        .map_err(|_| anyhow::anyhow!("Downloads unavailable"))?;
    if loaded.as_ref().is_none_or(|kept| kept.account != account) {
        let store = Store::for_account(account)?;
        let manifest = store.load();
        *loaded = Some(Loaded {
            account: account.to_owned(),
            store,
            manifest,
        });
    }
    let kept = loaded.as_mut().context("Downloads unavailable")?;
    Ok(change(&kept.store, &mut kept.manifest))
}

fn format_name(format: AudioFileFormat) -> String {
    format!("{format:?}")
}

fn format_named(name: &str) -> Option<AudioFileFormat> {
    crate::waveform::FORMATS
        .iter()
        .map(|(format, _)| *format)
        .find(|format| format_name(*format) == name)
}

/// Hands the player every song it may play from disk right now.
pub fn publish(account: &str) {
    let now = crate::offline::now();
    let Ok((playable, tracks)) = with(account, |store, manifest| {
        let mut playable = HashMap::new();
        let mut tracks = HashMap::new();
        if !manifest.locked(now) {
            for (uri, download) in &manifest.tracks {
                let (Ok(id), Some(path), Some(format), Ok(key)) = (
                    SpotifyUri::from_uri(uri),
                    store.file_path(&download.file_id),
                    format_named(&download.format),
                    crate::offline::open_key(&download.sealed_key),
                ) else {
                    continue;
                };
                playable.insert(
                    id,
                    librespot_playback::Downloaded {
                        path,
                        key,
                        format,
                        name: download.track.name.clone(),
                        duration_ms: u32::try_from(download.track.duration_ms).unwrap_or(0),
                    },
                );
                tracks.insert(uri.clone(), download.track.clone());
            }
        }
        (playable, tracks)
    }) else {
        return;
    };
    librespot_playback::set_downloads(playable);
    if let Ok(mut shared) = TRACKS.write() {
        *shared = tracks;
    }
}

pub fn track(uri: &str) -> Option<crate::model::Track> {
    TRACKS.read().ok()?.get(uri).cloned()
}

/// Removes every account's downloads, as Spotify does when you sign out.
pub fn forget_all() -> Result<()> {
    SIGN_OUTS.fetch_add(1, Ordering::AcqRel);
    if let Ok(mut loaded) = LOADED.lock() {
        *loaded = None;
    }
    librespot_playback::set_downloads(HashMap::new());
    if let Ok(mut shared) = TRACKS.write() {
        shared.clear();
    }
    crate::offline::wipe_all()
}

#[derive(Clone, Serialize)]
pub struct Progress {
    pub uri: String,
    pub done: usize,
    pub total: usize,
}

#[derive(Clone, Serialize)]
pub struct Status {
    pub collections: Vec<Progress>,
    pub locked: bool,
    pub songs: usize,
    pub bytes: u64,
}

pub fn status(account: &str) -> Result<Status> {
    let now = crate::offline::now();
    with(account, |store, manifest| Status {
        collections: manifest
            .collections
            .iter()
            .filter_map(|collection| {
                let (done, total) = manifest.is_downloaded(&collection.uri)?;
                Some(Progress {
                    uri: collection.uri.clone(),
                    done,
                    total,
                })
            })
            .collect(),
        locked: manifest.locked(now),
        songs: manifest.tracks.len(),
        bytes: store.size(),
    })
}

pub fn remove(account: &str, uri: &str) -> Result<()> {
    with(account, |store, manifest| {
        let unused = manifest.remove_collection(uri);
        store.remove_files(&unused);
        store.save(manifest)
    })??;
    publish(account);
    Ok(())
}

/// Downloads a collection's songs not yet on disk, one at a time.
pub fn download(
    session: &Session,
    collection: Collection,
    mut progress: impl FnMut(),
) -> Result<()> {
    let signed_in = SIGN_OUTS.load(Ordering::Acquire);
    let cancelled = || SIGN_OUTS.load(Ordering::Acquire) != signed_in;
    let account = session.username();
    let uri = collection.uri.clone();
    let missing = with(&account, |store, manifest| {
        if manifest.last_online == 0 {
            manifest.last_online = crate::offline::now();
        }
        let missing = manifest.add_collection(collection)?;
        store.save(manifest)?;
        anyhow::Ok(missing)
    })??;
    progress();
    let _turn = DOWNLOADING
        .lock()
        .map_err(|_| anyhow::anyhow!("Downloads unavailable"))?;
    let mut failures = 0;
    for track in missing {
        if cancelled() {
            return Ok(());
        }
        let wanted = with(&account, |_, manifest| {
            manifest.is_downloaded(&uri).is_some() && !manifest.tracks.contains_key(&track)
        })?;
        if !wanted {
            continue;
        }
        match fetch(session, &track) {
            Ok(_) if cancelled() => return Ok(()),
            Ok((file_id, bytes, download)) => {
                with(&account, |store, manifest| {
                    store.write_file(&file_id, &bytes)?;
                    if manifest.record(&track, download) {
                        store.save(manifest)?;
                    }
                    anyhow::Ok(())
                })??;
                publish(&account);
                progress();
            }
            Err(error) => {
                failures += 1;
                crate::native::diagnostic(&format!("event download skipped {track}: {error:#}"));
            }
        }
    }
    if failures > 0 {
        bail!("{failures} songs could not be downloaded");
    }
    Ok(())
}

fn fetch(session: &Session, uri: &str) -> Result<(String, Vec<u8>, Download)> {
    let track_uri = SpotifyUri::from_uri(uri).context("Not a Spotify song")?;
    if !matches!(track_uri, SpotifyUri::Track { .. }) {
        bail!("Only Spotify songs download");
    }
    let track_id = SpotifyId::try_from(&track_uri).context("Not a Spotify song")?;
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()?;
    let (item, format, file_id, file, key) = runtime.block_on(async {
        let item = AudioItem::get_file(session, track_uri).await?;
        item.availability
            .map_err(|_| anyhow::anyhow!("Song unavailable"))?;
        let (format, file_id, rate) = crate::waveform::FORMATS
            .iter()
            .find_map(|&(format, rate)| item.files.get(&format).map(|&id| (format, id, rate)))
            .context("No playable audio file")?;
        let (file, key) = tokio::join!(
            AudioFile::open(session, file_id, rate),
            session.audio_key().request(track_id, file_id),
        );
        anyhow::Ok((item, format, file_id, file?, key?))
    })?;
    drop(runtime);
    let length = file.get_stream_loader_controller()?.len();
    let mut bytes = Vec::with_capacity(length);
    file.take(length as u64)
        .read_to_end(&mut bytes)
        .context("Audio download stopped")?;
    if bytes.len() != length {
        bail!("Audio download stopped");
    }
    let track = crate::native::public_track(&item).unwrap_or_else(|| crate::model::Track {
        uri: uri.to_owned(),
        name: item.name.clone(),
        duration_ms: item.duration_ms.into(),
        ..crate::model::Track::default()
    });
    Ok((
        file_id.to_base16(),
        bytes,
        Download {
            track,
            file_id: file_id.to_base16(),
            format: format_name(format),
            sealed_key: crate::offline::seal_key(&key.0)?,
        },
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stored_format_names_round_trip() {
        for (format, _) in crate::waveform::FORMATS {
            assert_eq!(format_named(&format_name(format)), Some(format));
        }
        assert_eq!(format_named("FLAC_FLAC"), None);
    }
}
