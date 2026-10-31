//! Local Files: songs in folders chosen in Settings, shown and played as
//! Spotify's desktop app shows them. Tags give the song's details, the
//! file's embedded picture (or a cover image beside it) its artwork, and a
//! `.ttml` or `.lrc` file with the same name its lyrics.

use crate::model::{Album, Artist, Artwork, Track};
use anyhow::{Context, Result};
use librespot_core::SpotifyUri;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    fs,
    path::{Path, PathBuf},
    sync::{
        LazyLock, Mutex, OnceLock, RwLock,
        atomic::{AtomicUsize, Ordering},
    },
    time::UNIX_EPOCH,
};
use symphonia::core::{
    formats::FormatOptions,
    io::MediaSourceStream,
    meta::{MetadataOptions, MetadataRevision, StandardTagKey, StandardVisualKey, Value},
    probe::Hint,
};

/// Spotify plays .mp3, .mp4/.m4a and FLAC; WAV and Ogg decode here too.
const EXTENSIONS: [&str; 6] = ["mp3", "m4a", "mp4", "flac", "wav", "ogg"];
/// Folder pictures Spotify-like players use when a song has none inside.
const FOLDER_COVERS: [&str; 4] = ["cover", "folder", "front", "album"];
/// Covers above this are left out rather than copied.
const COVER_LIMIT: usize = 16 * 1024 * 1024;
/// Saved scan results; renamed when what a scan keeps changes, so every
/// file is read again once.
const INDEX_FILE: &str = "index-2.json";
/// Spotify's songs play at their mastered level, commonly near this, so
/// quieter local files are raised to it.
const TARGET_LUFS: f64 = -10.0;
/// The most a quiet file is raised; the limiter holds its peaks.
const MAX_BOOST_DB: f64 = 12.0;
/// The custom protocol that serves saved covers to the interface.
pub const COVER_SCHEME: &str = "localcover";

#[derive(Default)]
struct Index {
    tracks: Vec<Track>,
    paths: HashMap<String, PathBuf>,
}

static INDEX: LazyLock<RwLock<Index>> = LazyLock::new(Default::default);
/// One scan at a time; a newer request waits and replaces the result.
static SCAN: Mutex<()> = Mutex::new(());
/// Bumped by every rescan, so loudness measuring for an older one stops.
static GENERATION: AtomicUsize = AtomicUsize::new(0);
static LISTENER: OnceLock<Box<dyn Fn(usize) + Send + Sync>> = OnceLock::new();

/// Called with the song count after each scan.
pub fn on_change(listener: impl Fn(usize) + Send + Sync + 'static) {
    let _ = LISTENER.set(Box::new(listener));
}

/// Every local song, in folder order.
pub fn tracks() -> Vec<Track> {
    INDEX
        .read()
        .map(|index| index.tracks.clone())
        .unwrap_or_default()
}

pub fn count() -> usize {
    INDEX.read().map(|index| index.tracks.len()).unwrap_or(0)
}

/// A local song's details by its `spotify:local:` URI.
pub fn track(uri: &str) -> Option<Track> {
    let index = INDEX.read().ok()?;
    index.tracks.iter().find(|track| track.uri == uri).cloned()
}

/// The file a local song plays from.
pub fn path(uri: &str) -> Option<PathBuf> {
    INDEX.read().ok()?.paths.get(uri).cloned()
}

/// Lyrics kept beside a local song: `song.ttml` or `song.lrc` next to
/// `song.mp3`, as (file name, contents).
pub fn sidecar_lyrics(uri: &str) -> Option<(String, String)> {
    let audio = path(uri)?;
    ["ttml", "lrc"].into_iter().find_map(|extension| {
        let file = audio.with_extension(extension);
        let text = fs::read_to_string(&file).ok()?;
        Some((file.file_name()?.to_string_lossy().into_owned(), text))
    })
}

/// A saved cover by the name the interface asked for.
pub fn cover(name: &str) -> Option<(Vec<u8>, &'static str)> {
    let (hash, extension) = name.split_once('.')?;
    if hash.len() != 64 || !hash.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return None;
    }
    let mime = match extension {
        "jpg" => "image/jpeg",
        "png" => "image/png",
        _ => return None,
    };
    let file = covers_dir().ok()?.join(name);
    let bytes = fs::read(&file).ok()?;
    // Covers saved before they were shrunk are shrunk on first use, so lists
    // never decode a full-size picture per row.
    if bytes.len() > SHRUNK_LIMIT
        && let Some(small) = shrink(&bytes)
    {
        let _ = fs::write(&file, &small);
        return Some((small, mime));
    }
    Some((bytes, mime))
}

/// Saved covers are at most this wide and tall, as Spotify's largest.
const COVER_SIZE: u32 = 640;
/// A cover this small is already shrunk.
const SHRUNK_LIMIT: usize = 200 * 1024;

/// A picture larger than `COVER_SIZE`, scaled down in its own format.
fn shrink(bytes: &[u8]) -> Option<Vec<u8>> {
    let format = image::guess_format(bytes).ok()?;
    let picture = image::load_from_memory_with_format(bytes, format).ok()?;
    if picture.width() <= COVER_SIZE && picture.height() <= COVER_SIZE {
        return None;
    }
    let small = picture.resize(
        COVER_SIZE,
        COVER_SIZE,
        image::imageops::FilterType::Lanczos3,
    );
    let mut out = Vec::new();
    match format {
        image::ImageFormat::Jpeg => {
            image::codecs::jpeg::JpegEncoder::new_with_quality(&mut out, 90)
                .encode_image(&small.to_rgb8())
                .ok()?
        }
        image::ImageFormat::Png => small
            .write_to(&mut std::io::Cursor::new(&mut out), image::ImageFormat::Png)
            .ok()?,
        _ => return None,
    }
    Some(out)
}

/// A local cover as a small JPEG data URL, for apps that cannot load
/// SpotiFlex's cover protocol, such as the Stream Deck plugin.
pub fn inline_cover(url: &str) -> Option<String> {
    static INLINE: LazyLock<Mutex<HashMap<String, String>>> = LazyLock::new(Default::default);
    let name = url.rsplit('/').next()?;
    if let Some(known) = INLINE.lock().ok()?.get(name) {
        return Some(known.clone());
    }
    let data = small_jpeg(&cover(name)?.0)?;
    if let Ok(mut inline) = INLINE.lock() {
        // Recent songs only; covers are re-made when needed.
        if inline.len() > 30 {
            inline.clear();
        }
        inline.insert(name.to_owned(), data.clone());
    }
    Some(data)
}

/// A picture shrunk to fit a 144 px key, as a JPEG data URL.
fn small_jpeg(bytes: &[u8]) -> Option<String> {
    let small = image::load_from_memory(bytes).ok()?.thumbnail(144, 144);
    let mut jpeg = Vec::new();
    image::codecs::jpeg::JpegEncoder::new_with_quality(&mut jpeg, 85)
        .encode_image(&small.to_rgb8())
        .ok()?;
    Some(format!(
        "data:image/jpeg;base64,{}",
        base64::Engine::encode(&base64::engine::general_purpose::STANDARD, jpeg)
    ))
}

/// Read the enabled folders again on a background thread.
pub fn rescan(settings: &crate::config::Settings) {
    let folders: Vec<PathBuf> = if settings.show_local_files {
        settings
            .local_sources
            .iter()
            .filter(|source| source.enabled)
            .map(|source| PathBuf::from(&source.path))
            .collect()
    } else {
        Vec::new()
    };
    let generation = GENERATION.fetch_add(1, Ordering::SeqCst) + 1;
    std::thread::spawn(move || {
        let scanning = SCAN.lock();
        // The first time, the songs saved last run show at once while the
        // folders are walked, which can take a while on large or slow drives.
        if generation == 1 && !folders.is_empty() {
            let saved: Vec<Saved> = load_saved()
                .into_iter()
                .filter(|item| folders.iter().any(|folder| item.path.starts_with(folder)))
                .collect();
            if !saved.is_empty() {
                publish(index_of(&saved));
            }
        }
        let (index, kept) = scan(&folders);
        publish(index);
        drop(scanning);
        measure(kept, generation);
    });
}

/// Make an index the one songs are listed and played from.
fn publish(index: Index) {
    let count = index.tracks.len();
    let playable = index
        .paths
        .iter()
        .filter_map(|(uri, path)| Some((SpotifyUri::from_uri(uri).ok()?, path.clone())))
        .collect();
    librespot_playback::set_local_files(playable);
    if let Ok(mut shared) = INDEX.write() {
        *shared = index;
    }
    if let Some(listener) = LISTENER.get() {
        listener(count);
    }
}

/// Songs as saved, listed without opening their files.
fn index_of(items: &[Saved]) -> Index {
    let mut index = Index::default();
    for item in items {
        if index.paths.contains_key(&item.track.uri) {
            continue;
        }
        index
            .paths
            .insert(item.track.uri.clone(), item.path.clone());
        index.tracks.push(listed(item));
    }
    index
}

/// A saved song as listed, with its cover's address; its loudness is
/// applied to playback.
fn listed(item: &Saved) -> Track {
    let mut track = item.track.clone();
    if let Some(name) = &item.cover {
        track.album.images = vec![Artwork {
            url: cover_url(name),
            width: None,
        }];
    }
    if let Some(loudness) = item.loudness {
        librespot_playback::set_local_gain(item.path.clone(), boost(loudness));
    }
    track
}

/// Measure the loudness of songs not measured yet, one by one in the
/// background; each plays louder as soon as it is measured.
fn measure(mut kept: Vec<Saved>, generation: usize) {
    let mut changed = 0;
    for index in 0..kept.len() {
        if kept[index].loudness.is_some() {
            continue;
        }
        if GENERATION.load(Ordering::SeqCst) != generation {
            return;
        }
        let item = &mut kept[index];
        let loudness = loudness(&item.path).unwrap_or_else(|error| {
            log::warn!("Could not measure a local file's loudness: {error:#}");
            TARGET_LUFS
        });
        item.loudness = Some(loudness);
        librespot_playback::set_local_gain(item.path.clone(), boost(loudness));
        changed += 1;
        if changed % 20 == 0 {
            store_measured(&kept, generation);
        }
    }
    if changed > 0 {
        store_measured(&kept, generation);
    }
}

/// Saved unless a newer scan has started, which keeps its own list.
fn store_measured(kept: &[Saved], generation: usize) {
    let _scanning = SCAN.lock();
    if GENERATION.load(Ordering::SeqCst) == generation {
        let _ = store_saved(kept);
    }
}

/// Integrated loudness (EBU R128, LUFS) of a file as the player plays it.
fn loudness(path: &Path) -> Result<f64> {
    use librespot_playback::decoder::{AudioDecoder, AudioPacket, SymphoniaDecoder};
    let file = fs::File::open(path).context("Cannot open the file")?;
    let mut hint = Hint::new();
    if let Some(extension) = path.extension().and_then(|extension| extension.to_str()) {
        hint.with_extension(extension);
    }
    let mut decoder = SymphoniaDecoder::new(file, hint).context("Cannot decode the file")?;
    let mut meter = ebur128::EbuR128::new(2, librespot_playback::SAMPLE_RATE, ebur128::Mode::I)?;
    let mut frames = Vec::new();
    while let Some((_, packet)) = decoder.next_packet().context("Cannot decode the file")? {
        if let AudioPacket::Samples(samples) = packet {
            frames.clear();
            frames.extend(samples.iter().map(|&sample| sample as f32));
            meter.add_frames_f32(&frames)?;
        }
    }
    let lufs = meter.loudness_global()?;
    // Silence measures as -inf, which JSON cannot hold.
    Ok(if lufs.is_finite() { lufs } else { -70.0 })
}

/// dB a file at `lufs` is raised; files at or above the target are kept.
fn boost(lufs: f64) -> f64 {
    (TARGET_LUFS - lufs).clamp(0.0, MAX_BOOST_DB)
}

/// What one file held when it was last read; unchanged files are not
/// opened again.
#[derive(Clone, Serialize, Deserialize)]
struct Saved {
    path: PathBuf,
    size: u64,
    modified: u64,
    track: Track,
    cover: Option<String>,
    /// Integrated loudness in LUFS, once measured.
    #[serde(default)]
    loudness: Option<f64>,
}

fn scan(folders: &[PathBuf]) -> (Index, Vec<Saved>) {
    let saved: HashMap<PathBuf, Saved> = load_saved()
        .into_iter()
        .map(|item| (item.path.clone(), item))
        .collect();
    let mut files = Vec::new();
    for folder in folders {
        collect(folder, &mut files, 0);
    }
    let mut kept = Vec::new();
    let mut index = Index::default();
    for file in files {
        let Ok(meta) = fs::metadata(&file) else {
            continue;
        };
        let modified = meta
            .modified()
            .ok()
            .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
            .map_or(0, |time| time.as_secs());
        let item = match saved.get(&file) {
            Some(item) if item.size == meta.len() && item.modified == modified => item.clone(),
            _ => match read(&file) {
                Ok((track, cover)) => Saved {
                    path: file.clone(),
                    size: meta.len(),
                    modified,
                    track,
                    cover,
                    loudness: None,
                },
                Err(error) => {
                    log::warn!("Skipped a local file: {error:#}");
                    continue;
                }
            },
        };
        // Two copies of one song share a URI; the first one found plays.
        if index.paths.contains_key(&item.track.uri) {
            continue;
        }
        index.paths.insert(item.track.uri.clone(), file);
        index.tracks.push(listed(&item));
        kept.push(item);
    }
    let _ = store_saved(&kept);
    (index, kept)
}

/// Audio files under a folder; hidden and very deep folders are skipped.
fn collect(folder: &Path, files: &mut Vec<PathBuf>, depth: usize) {
    if depth > 12 {
        return;
    }
    let Ok(entries) = fs::read_dir(folder) else {
        return;
    };
    let mut entries: Vec<_> = entries.flatten().collect();
    entries.sort_by_key(|entry| entry.file_name());
    for entry in entries {
        let path = entry.path();
        let Ok(kind) = entry.file_type() else {
            continue;
        };
        if kind.is_symlink() || entry.file_name().to_string_lossy().starts_with('.') {
            continue;
        }
        if kind.is_dir() {
            collect(&path, files, depth + 1);
        } else if path
            .extension()
            .and_then(|extension| extension.to_str())
            .is_some_and(|extension| EXTENSIONS.contains(&extension.to_lowercase().as_str()))
        {
            files.push(path);
        }
    }
}

/// A song's details and saved cover name from its file.
fn read(path: &Path) -> Result<(Track, Option<String>)> {
    let file = fs::File::open(path).context("Cannot open the file")?;
    let stream = MediaSourceStream::new(Box::new(file), Default::default());
    let mut hint = Hint::new();
    if let Some(extension) = path.extension().and_then(|extension| extension.to_str()) {
        hint.with_extension(extension);
    }
    let mut probed = symphonia::default::get_probe()
        .format(
            &hint,
            stream,
            &FormatOptions::default(),
            &MetadataOptions::default(),
        )
        .with_context(|| format!("{} is not a supported audio file", path.display()))?;
    let revision: Option<MetadataRevision> = {
        let mut format = probed.format.metadata();
        match format.skip_to_latest() {
            Some(revision) => Some(revision.clone()),
            None => probed
                .metadata
                .get()
                .and_then(|mut probe| probe.skip_to_latest().cloned()),
        }
    };
    let tag = |key: StandardTagKey| {
        revision.as_ref().and_then(|revision| {
            revision
                .tags()
                .iter()
                .find(|tag| tag.std_key == Some(key))
                .map(|tag| match &tag.value {
                    Value::String(text) => text.trim().to_owned(),
                    value => value.to_string(),
                })
                .filter(|text| !text.is_empty())
        })
    };
    let stem = path
        .file_stem()
        .map(|stem| stem.to_string_lossy().into_owned())
        .unwrap_or_default();
    let name = tag(StandardTagKey::TrackTitle).unwrap_or(stem);
    let artist = tag(StandardTagKey::Artist).unwrap_or_default();
    let album = tag(StandardTagKey::Album).unwrap_or_default();
    let album_artist = tag(StandardTagKey::AlbumArtist).unwrap_or_else(|| artist.clone());

    let duration_ms = {
        let track = probed
            .format
            .default_track()
            .context("The file has no audio")?;
        // Songs that cannot be decoded, such as Opus in .ogg, are left out
        // rather than listed and never starting.
        symphonia::default::get_codecs()
            .make(&track.codec_params, &Default::default())
            .with_context(|| format!("{} uses an unsupported codec", path.display()))?;
        let id = track.id;
        match (track.codec_params.time_base, track.codec_params.n_frames) {
            (Some(base), Some(frames)) => {
                let time = base.calc_time(frames);
                time.seconds * 1000 + (time.frac * 1000.0) as u64
            }
            // MP3s without a length header are measured by reading them once.
            (Some(base), None) => {
                let mut end = 0;
                while let Ok(packet) = probed.format.next_packet() {
                    if packet.track_id() == id {
                        end = packet.ts + packet.dur;
                    }
                }
                let time = base.calc_time(end);
                time.seconds * 1000 + (time.frac * 1000.0) as u64
            }
            _ => anyhow::bail!("The file's length is unknown"),
        }
    };
    let uri = local_uri(&artist, &album, &name, duration_ms / 1000);

    let picture = revision
        .as_ref()
        .and_then(|revision| {
            let visuals = revision.visuals();
            visuals
                .iter()
                .find(|visual| visual.usage == Some(StandardVisualKey::FrontCover))
                .or_else(|| visuals.first())
                .map(|visual| visual.data.to_vec())
        })
        .or_else(|| folder_cover(path));
    let cover = picture.and_then(|bytes| save_cover(&bytes));

    let artists = split_artists(&artist);
    Ok((
        Track {
            id: None,
            uri,
            name,
            duration_ms,
            is_local: true,
            on_disk: true,
            album: Album {
                name: album,
                artists: split_artists(&album_artist),
                ..Album::default()
            },
            artists,
            ..Track::default()
        },
        cover,
    ))
}

fn split_artists(names: &str) -> Vec<Artist> {
    names
        .split([';', '\0'])
        .flat_map(|names| names.split(" / "))
        .map(str::trim)
        .filter(|name| !name.is_empty())
        .map(|name| Artist {
            name: name.to_owned(),
            ..Artist::default()
        })
        .collect()
}

/// `spotify:local:{artist}:{album}:{title}:{seconds}`, each part
/// form-encoded as Spotify's desktop app writes them.
fn local_uri(artist: &str, album: &str, title: &str, seconds: u64) -> String {
    let part = |text: &str| form_urlencoded::byte_serialize(text.as_bytes()).collect::<String>();
    format!(
        "spotify:local:{}:{}:{}:{seconds}",
        part(artist),
        part(album),
        part(title)
    )
}

fn folder_cover(audio: &Path) -> Option<Vec<u8>> {
    let folder = audio.parent()?;
    FOLDER_COVERS.iter().find_map(|name| {
        ["jpg", "jpeg", "png"]
            .iter()
            .find_map(|extension| fs::read(folder.join(format!("{name}.{extension}"))).ok())
    })
}

/// Keep a cover by its hash and return its file name.
fn save_cover(bytes: &[u8]) -> Option<String> {
    if bytes.len() > COVER_LIMIT {
        return None;
    }
    let extension = match image::guess_format(bytes).ok()? {
        image::ImageFormat::Jpeg => "jpg",
        image::ImageFormat::Png => "png",
        _ => return None,
    };
    let name = format!("{:x}.{extension}", Sha256::digest(bytes));
    let dir = covers_dir().ok()?;
    let file = dir.join(&name);
    if !file.exists() {
        fs::create_dir_all(&dir).ok()?;
        fs::write(&file, shrink(bytes).as_deref().unwrap_or(bytes)).ok()?;
    }
    Some(name)
}

fn cover_url(name: &str) -> String {
    // WebView2 serves custom protocols over http://<scheme>.localhost.
    if cfg!(windows) {
        format!("http://{COVER_SCHEME}.localhost/{name}")
    } else {
        format!("{COVER_SCHEME}://localhost/{name}")
    }
}

fn root() -> Result<PathBuf> {
    Ok(crate::config::data_dir()?.join("local-files"))
}

fn covers_dir() -> Result<PathBuf> {
    Ok(root()?.join("covers"))
}

fn load_saved() -> Vec<Saved> {
    root()
        .ok()
        .and_then(|root| fs::read(root.join(INDEX_FILE)).ok())
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        .unwrap_or_default()
}

fn store_saved(items: &[Saved]) -> Result<()> {
    let root = root()?;
    fs::create_dir_all(&root)?;
    fs::write(root.join(INDEX_FILE), serde_json::to_vec(items)?)?;
    let _ = fs::remove_file(root.join("index.json"));
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn large_covers_are_kept_at_spotify_size_in_their_own_format() {
        let picture = image::DynamicImage::new_rgb8(1600, 1200);
        for format in [image::ImageFormat::Png, image::ImageFormat::Jpeg] {
            let mut bytes = Vec::new();
            picture
                .write_to(&mut std::io::Cursor::new(&mut bytes), format)
                .unwrap();
            let small = shrink(&bytes).unwrap();
            assert_eq!(image::guess_format(&small).unwrap(), format);
            let small = image::load_from_memory(&small).unwrap();
            assert_eq!((small.width(), small.height()), (640, 480));
        }
        let mut tiny = Vec::new();
        image::DynamicImage::new_rgb8(300, 300)
            .write_to(
                &mut std::io::Cursor::new(&mut tiny),
                image::ImageFormat::Png,
            )
            .unwrap();
        assert!(shrink(&tiny).is_none());
    }

    #[test]
    fn local_uris_match_spotify_and_parse_back() {
        let uri = local_uri("AC/DC", "Back in Black", "Hells Bells: Live", 312);
        assert_eq!(
            uri,
            "spotify:local:AC%2FDC:Back+in+Black:Hells+Bells%3A+Live:312"
        );
        let parsed = SpotifyUri::from_uri(&uri).unwrap();
        assert_eq!(parsed.to_uri(), uri);
    }

    #[test]
    fn covers_are_served_only_by_hash() {
        assert!(cover("../index.json").is_none());
        assert!(cover(&format!("{}.exe", "a".repeat(64))).is_none());
        assert!(cover("short.jpg").is_none());
    }

    #[test]
    fn stream_deck_covers_are_small_jpegs() {
        let mut png = Vec::new();
        image::RgbImage::from_pixel(1200, 1200, image::Rgb([30, 215, 96]))
            .write_to(&mut std::io::Cursor::new(&mut png), image::ImageFormat::Png)
            .unwrap();
        let data = small_jpeg(&png).unwrap();
        assert!(data.starts_with("data:image/jpeg;base64,"));
        // Well inside the plugin's 64 KB line limit.
        assert!(data.len() < 20_000);
        assert!(small_jpeg(b"not a picture").is_none());
    }

    #[test]
    fn only_quiet_files_are_raised_and_not_without_limit() {
        assert_eq!(boost(-8.0), 0.0);
        assert_eq!(boost(-10.0), 0.0);
        assert!((boost(-16.0) - 6.0).abs() < 1e-9);
        assert_eq!(boost(-40.0), MAX_BOOST_DB);
    }

    #[test]
    fn artist_tags_split_into_names() {
        let names: Vec<_> = split_artists("Daft Punk / Pharrell; Nile Rodgers;AC/DC")
            .into_iter()
            .map(|artist| artist.name)
            .collect();
        assert_eq!(names, ["Daft Punk", "Pharrell", "Nile Rodgers", "AC/DC"]);
    }
}
