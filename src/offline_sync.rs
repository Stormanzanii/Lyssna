use crate::offline::{Collection, Download, Manifest, Store};
use anyhow::{Context, Result, bail};
use librespot_audio::AudioFile;
use librespot_core::{Session, SpotifyId, SpotifyUri};
use librespot_metadata::audio::{AudioFileFormat, AudioItem};
use serde::Serialize;
use std::{
    collections::{BTreeSet, HashMap},
    io::Read,
    path::{Path, PathBuf},
    sync::{
        LazyLock, Mutex, RwLock,
        atomic::{AtomicUsize, Ordering},
    },
    time::{Duration, Instant},
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
static STOPS: AtomicUsize = AtomicUsize::new(0);
static RUNNING: Mutex<BTreeSet<String>> = Mutex::new(BTreeSet::new());
/// Rounds in which Spotify refused each song's key. Some songs are always
/// refused to this player; after two rounds they are set aside until the
/// next start so the rest of the list can finish.
static REFUSALS: LazyLock<Mutex<HashMap<String, u8>>> = LazyLock::new(Default::default);
const REFUSED_ROUNDS: u8 = 2;

fn set_aside(track: &str) -> bool {
    REFUSALS.lock().is_ok_and(|refusals| {
        refusals
            .get(track)
            .is_some_and(|rounds| *rounds >= REFUSED_ROUNDS)
    })
}

fn note_refusal(track: &str) {
    if let Ok(mut refusals) = REFUSALS.lock() {
        *refusals.entry(track.to_owned()).or_default() += 1;
    }
}

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

pub fn playable(uri: &str) -> bool {
    TRACKS.read().is_ok_and(|tracks| tracks.contains_key(uri))
}

/// Downloads can stand in for Spotify: some exist and the 30-day window
/// is still open.
pub fn usable(account: &str) -> bool {
    let now = crate::offline::now();
    with(account, |_, manifest| {
        !manifest.tracks.is_empty() && !manifest.locked(now)
    })
    .unwrap_or(false)
}

/// A downloaded list's playable songs in its order, for use offline.
pub fn list(account: &str, uri: &str) -> Option<(Collection, Vec<crate::model::Track>)> {
    let now = crate::offline::now();
    with(account, |_, manifest| {
        if manifest.locked(now) {
            return None;
        }
        let collection = manifest
            .collections
            .iter()
            .find(|collection| collection.uri == uri)?
            .clone();
        let tracks = collection
            .tracks
            .iter()
            .filter_map(|track| manifest.tracks.get(track))
            .map(|download| download.track.clone())
            .collect();
        Some((collection, tracks))
    })
    .ok()
    .flatten()
}

/// Removes every account's downloads, as Spotify does when you sign out.
pub fn forget_all() -> Result<()> {
    STOPS.fetch_add(1, Ordering::AcqRel);
    if let Ok(mut loaded) = LOADED.lock() {
        *loaded = None;
    }
    if let Ok(mut refusals) = REFUSALS.lock() {
        refusals.clear();
    }
    librespot_playback::set_downloads(HashMap::new());
    if let Ok(mut shared) = TRACKS.write() {
        shared.clear();
    }
    crate::offline::wipe_all()
}

/// Moves downloads into `folder`; `remember` records the new place while
/// nothing else can touch them.
pub fn relocate(folder: &Path, remember: impl FnOnce() -> Result<()>) -> Result<PathBuf> {
    STOPS.fetch_add(1, Ordering::AcqRel);
    let _turn = DOWNLOADING
        .lock()
        .map_err(|_| anyhow::anyhow!("Downloads unavailable"))?;
    let mut loaded = LOADED
        .lock()
        .map_err(|_| anyhow::anyhow!("Downloads unavailable"))?;
    let target = crate::offline::inside(folder);
    crate::offline::move_all(&crate::offline::base_directory()?, &target)?;
    remember()?;
    *loaded = None;
    Ok(target)
}

#[derive(Clone, Serialize)]
pub struct Progress {
    pub uri: String,
    pub done: usize,
    pub total: usize,
    pub downloading: bool,
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
    let running = RUNNING
        .lock()
        .map(|running| running.clone())
        .unwrap_or_default();
    with(account, |store, manifest| Status {
        collections: manifest
            .collections
            .iter()
            .filter_map(|collection| {
                let (done, total) = manifest.is_downloaded(&collection.uri)?;
                let aside = manifest
                    .missing(&collection.uri)
                    .unwrap_or_default()
                    .iter()
                    .filter(|track| set_aside(track))
                    .count();
                let total = total - aside;
                Some(Progress {
                    uri: collection.uri.clone(),
                    done,
                    total,
                    downloading: running.contains(&collection.uri),
                })
            })
            .collect(),
        locked: manifest.locked(now),
        songs: manifest.tracks.len(),
        bytes: store.size(),
    })
}

pub fn downloaded_songs(account: &str) -> Result<Vec<String>> {
    with(account, |_, manifest| {
        manifest.tracks.keys().cloned().collect()
    })
}

pub fn collections(account: &str) -> Vec<Collection> {
    with(account, |_, manifest| manifest.collections.clone()).unwrap_or_default()
}

fn list_key(uri: &str) -> Option<String> {
    if uri.starts_with("spotify:user:") && uri.ends_with(":collection") {
        return Some("liked".into());
    }
    uri.strip_prefix("spotify:")
        .filter(|key| key.starts_with("playlist:") || key.starts_with("album:"))
        .map(str::to_owned)
}

/// The list as Spotify has it now, read whole so a partly loaded page
/// never removes downloads.
pub fn refreshed(session: &Session, mut collection: Collection) -> Result<Collection> {
    let key = list_key(&collection.uri).context("Not a downloadable list")?;
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()?;
    let tracks = runtime.block_on(async {
        let limit = crate::native_browse::READ_LIMIT;
        let mut tracks = Vec::new();
        loop {
            let page = crate::native_browse::read_range(session, &key, tracks.len(), limit).await?;
            let full = page.len() == limit;
            tracks.extend(page);
            if !full {
                break anyhow::Ok(tracks);
            }
        }
    })?;
    let mut seen = BTreeSet::new();
    collection.tracks = tracks
        .into_iter()
        .map(|track| track.uri)
        .filter(|uri| uri.starts_with("spotify:track:") && seen.insert(uri.clone()))
        .collect();
    Ok(collection)
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
    let started = STOPS.load(Ordering::Acquire);
    let cancelled = || STOPS.load(Ordering::Acquire) != started;
    let account = session.username();
    let uri = collection.uri.clone();
    with(&account, |store, manifest| {
        if manifest.last_online == 0 {
            manifest.last_online = crate::offline::now();
        }
        manifest.add_collection(collection)?;
        // Songs taken off the list since it was downloaded go too.
        let unused = manifest.prune();
        store.remove_files(&unused);
        store.save(manifest)
    })??;
    publish(&account);
    let nothing_missing = with(&account, |_, manifest| manifest.missing(&uri))?
        .unwrap_or_default()
        .iter()
        .all(|track| set_aside(track));
    if nothing_missing {
        progress();
        return Ok(());
    }
    // One worker per list: a second press while one runs leaves the songs
    // to it, since it rereads what is missing each round.
    let first = RUNNING
        .lock()
        .map(|mut running| running.insert(uri.clone()))
        .unwrap_or(false);
    progress();
    if !first {
        return Ok(());
    }
    let mut round = 0;
    let finished = loop {
        let mut missing = with(&account, |_, manifest| manifest.missing(&uri))?.unwrap_or_default();
        missing.retain(|track| !set_aside(track));
        if missing.is_empty() || cancelled() {
            break Ok(());
        }
        let throttled =
            match fetch_missing(session, &account, &uri, missing, cancelled, &mut progress) {
                Ok(throttled) => throttled,
                Err(error) => break Err(error),
            };
        if !throttled {
            break Ok(());
        }
        let Some(wait) = RETRY_AFTER.get(round).copied() else {
            break Ok(());
        };
        round += 1;
        crate::native::diagnostic(&format!(
            "event downloads throttled by Spotify; trying again in {}s",
            wait.as_secs()
        ));
        if !pause(wait, cancelled, || {
            with(&account, |_, manifest| manifest.missing(&uri).is_some()).unwrap_or(false)
        }) {
            break Ok(());
        }
    };
    if let Ok(mut running) = RUNNING.lock() {
        running.remove(&uri);
    }
    finished
}

const RETRY_AFTER: [Duration; 5] = [
    Duration::from_secs(15),
    Duration::from_secs(30),
    Duration::from_secs(60),
    Duration::from_secs(120),
    Duration::from_secs(300),
];

/// Waits, unless downloads stop or the list is removed meanwhile.
fn pause(wait: Duration, cancelled: impl Fn() -> bool, wanted: impl Fn() -> bool) -> bool {
    let until = Instant::now() + wait;
    while Instant::now() < until {
        if cancelled() || !wanted() {
            return false;
        }
        std::thread::sleep(Duration::from_millis(250));
    }
    true
}

fn refused(error: &anyhow::Error) -> bool {
    error.chain().any(|cause| {
        cause
            .downcast_ref::<librespot_core::Error>()
            .is_some_and(|error| error.kind == librespot_core::error::ErrorKind::Unavailable)
    })
}

/// Fetches one round; true when Spotify started refusing and it stopped.
fn fetch_missing(
    session: &Session,
    account: &str,
    uri: &str,
    missing: Vec<String>,
    cancelled: impl Fn() -> bool,
    progress: &mut impl FnMut(),
) -> Result<bool> {
    let account = account.to_owned();
    let _turn = DOWNLOADING
        .lock()
        .map_err(|_| anyhow::anyhow!("Downloads unavailable"))?;
    let mut refusals = 0;
    for track in missing {
        if cancelled() {
            return Ok(false);
        }
        let wanted = with(&account, |_, manifest| {
            manifest.is_downloaded(uri).is_some() && !manifest.tracks.contains_key(&track)
        })?;
        if !wanted {
            continue;
        }
        let known = |file_id: &str| {
            with(&account, |_, manifest| manifest.keys.get(file_id).cloned())
                .ok()
                .flatten()
        };
        match fetch(session, &track, known) {
            Ok(_) if cancelled() => return Ok(false),
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
                refusals = 0;
            }
            // Spotify leaves a song it cannot fetch for a later attempt
            // without telling the listener.
            Err(error) => {
                crate::native::diagnostic(&format!("event download skipped {track}: {error:#}"));
                if refused(&error) {
                    note_refusal(&track);
                    refusals += 1;
                    if refusals >= 2 {
                        return Ok(true);
                    }
                }
            }
        }
    }
    Ok(false)
}

/// Spotify relinks a song unavailable in this country to another release of
/// it; the player plays that one, so the download keeps it too.
async fn playable_item(session: &Session, uri: SpotifyUri) -> Result<AudioItem> {
    let item = AudioItem::get_file(session, uri).await?;
    item.availability
        .map_err(|_| anyhow::anyhow!("Song unavailable"))?;
    if !item.files.is_empty() {
        return Ok(item);
    }
    for alternative in item.alternatives.map(|tracks| tracks.0).unwrap_or_default() {
        if let Ok(other) = AudioItem::get_file(session, alternative).await
            && other.availability.is_ok()
            && !other.files.is_empty()
        {
            return Ok(other);
        }
    }
    bail!("No playable audio file")
}

fn fetch(
    session: &Session,
    uri: &str,
    known_key: impl Fn(&str) -> Option<String>,
) -> Result<(String, Vec<u8>, Download)> {
    let track_uri = SpotifyUri::from_uri(uri).context("Not a Spotify song")?;
    if !matches!(track_uri, SpotifyUri::Track { .. }) {
        bail!("Only Spotify songs download");
    }
    let track_id = SpotifyId::try_from(&track_uri).context("Not a Spotify song")?;
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()?;
    let (item, format, file_id, file, key) = runtime.block_on(async {
        let item = playable_item(session, track_uri).await?;
        let (format, file_id, rate) = crate::waveform::FORMATS
            .iter()
            .find_map(|&(format, rate)| item.files.get(&format).map(|&id| (format, id, rate)))
            .context("No playable audio file")?;
        let audio_id = SpotifyId::try_from(&item.track_id).unwrap_or(track_id);
        let known = known_key(&file_id.to_base16());
        let (file, key) = tokio::join!(AudioFile::open(session, file_id, rate), async {
            match known {
                Some(sealed) => anyhow::Ok(sealed),
                None => {
                    let key = session.audio_key().request(audio_id, file_id).await?;
                    crate::offline::seal_key(&key.0)
                }
            }
        });
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
    let mut track = crate::native::public_track(&item).unwrap_or_else(|| crate::model::Track {
        name: item.name.clone(),
        duration_ms: item.duration_ms.into(),
        ..crate::model::Track::default()
    });
    track.uri = uri.to_owned();
    track.id = uri.rsplit(':').next().map(str::to_owned);
    Ok((
        file_id.to_base16(),
        bytes,
        Download {
            track,
            file_id: file_id.to_base16(),
            format: format_name(format),
            sealed_key: key,
        },
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_song_refused_twice_is_set_aside() {
        let track = "spotify:track:refusedrefusedrefused1";
        note_refusal(track);
        assert!(!set_aside(track));
        note_refusal(track);
        assert!(set_aside(track));
    }

    #[test]
    fn stored_format_names_round_trip() {
        for (format, _) in crate::waveform::FORMATS {
            assert_eq!(format_named(&format_name(format)), Some(format));
        }
        assert_eq!(format_named("FLAC_FLAC"), None);
    }
}
