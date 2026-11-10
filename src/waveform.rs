use anyhow::{Context, Result};
use librespot_audio::{AudioDecrypt, AudioFile};
use librespot_core::{Session, SpotifyId, SpotifyUri};
use librespot_metadata::audio::{AudioFileFormat, AudioFiles, AudioItem};
use librespot_playback::decoder::{AudioDecoder, AudioPacket, SymphoniaDecoder};
use std::{
    collections::VecDeque,
    f64::consts::TAU,
    io::{Cursor, Read},
    sync::{Arc, Mutex},
};
use symphonia::core::probe::Hint;

const SPOTIFY_OGG_HEADER_END: usize = 0xa7;
const KEPT: usize = 6;

// The player's default 160 kbps order first, so the file playback already
// fetched (and cached) is reused instead of downloading another.
pub(crate) const FORMATS: [(AudioFileFormat, usize); 7] = [
    (AudioFileFormat::OGG_VORBIS_160, 20 * 1024),
    (AudioFileFormat::MP3_160, 20 * 1024),
    (AudioFileFormat::OGG_VORBIS_96, 12 * 1024),
    (AudioFileFormat::MP3_96, 12 * 1024),
    (AudioFileFormat::MP3_256, 32 * 1024),
    (AudioFileFormat::OGG_VORBIS_320, 40 * 1024),
    (AudioFileFormat::MP3_320, 40 * 1024),
];

// Matches AMLL's TTML tool (its MIT wasm-spectrogram engine): an unwindowed
// 1024-point FFT every 64 samples, up to 20 kHz on a linear axis.
const WINDOW: usize = 1024;
const HOP: usize = 64;
const TOP_HZ: f64 = 20_000.0;
/// Levels are sent as 16-bit fractions of this so gain can be applied later.
pub(crate) const LEVEL_SPAN: f64 = 4.0;
const KEPT_PCM: usize = 2;

static RECENT: Mutex<VecDeque<(String, Arc<Vec<u8>>)>> = Mutex::new(VecDeque::new());

fn remembered(key: String, make: impl FnOnce() -> Result<Vec<u8>>) -> Result<Arc<Vec<u8>>> {
    let found = RECENT.lock().ok().and_then(|recent| {
        recent
            .iter()
            .find(|(kept, _)| *kept == key)
            .map(|(_, values)| values.clone())
    });
    if let Some(values) = found {
        return Ok(values);
    }
    let values = Arc::new(make()?);
    if let Ok(mut recent) = RECENT.lock() {
        recent.push_front((key, values.clone()));
        recent.truncate(KEPT);
    }
    Ok(values)
}

/// Peak loudness of `buckets` equal slices of the whole track, 0 to 255.
pub(crate) fn track_peaks(session: &Session, uri: &str, buckets: usize) -> Result<Arc<Vec<u8>>> {
    let buckets = buckets.clamp(1, 8000);
    remembered(format!("{uri} peaks {buckets}"), || {
        let (decoder, duration_ms) = open_track(session, uri)?;
        peaks_of(decoder, duration_ms.max(1), buckets)
    })
}

type Pcm = (String, Arc<Vec<f32>>);
// Held while decoding so tiles asked for together share one decode.
static PCM: Mutex<VecDeque<Pcm>> = Mutex::new(VecDeque::new());

fn track_pcm(session: &Session, uri: &str) -> Result<Arc<Vec<f32>>> {
    let mut kept = PCM
        .lock()
        .map_err(|_| anyhow::anyhow!("Spectrogram cache unavailable"))?;
    if let Some((_, samples)) = kept.iter().find(|(kept, _)| kept == uri) {
        return Ok(samples.clone());
    }
    let (decoder, _) = open_track(session, uri)?;
    let samples = Arc::new(mono_of(decoder)?);
    kept.push_front((uri.to_owned(), samples.clone()));
    kept.truncate(KEPT_PCM);
    Ok(samples)
}

/// `log10(1 + magnitude)` levels from 1 bin above 0 Hz at the bottom row to
/// 20 kHz at the top, row by row from the top, for `columns` slices of
/// `from_ms..to_ms`, as little-endian 16-bit fractions of `LEVEL_SPAN`.
pub(crate) fn track_spectrogram(
    session: &Session,
    uri: &str,
    from_ms: f64,
    to_ms: f64,
    columns: usize,
    rows: usize,
) -> Result<Vec<u8>> {
    let samples = track_pcm(session, uri)?;
    Ok(spectrogram_tile(
        &samples,
        from_ms,
        to_ms,
        columns.clamp(1, 8192),
        rows.clamp(8, 1024),
    ))
}

/// Mono samples of exactly `from_ms..to_ms`, at
/// `librespot_playback::SAMPLE_RATE`, so a word plays without the player's
/// seek and pause latency.
pub(crate) fn track_clip(
    session: &Session,
    uri: &str,
    from_ms: f64,
    to_ms: f64,
) -> Result<Vec<f32>> {
    Ok(clip_of(&track_pcm(session, uri)?, from_ms, to_ms).to_vec())
}

const LONGEST_CLIP_MS: f64 = 60_000.0;

fn clip_of(samples: &[f32], from_ms: f64, to_ms: f64) -> &[f32] {
    let rate = f64::from(librespot_playback::SAMPLE_RATE);
    let at = |ms: f64| ((ms.max(0.0) / 1000.0 * rate).round() as usize).min(samples.len());
    let from = at(from_ms);
    let to = at(to_ms.min(from_ms + LONGEST_CLIP_MS)).max(from);
    &samples[from..to]
}

fn mono_of(mut decoder: impl AudioDecoder) -> Result<Vec<f32>> {
    let channels = usize::from(librespot_playback::NUM_CHANNELS);
    let mut mono = Vec::new();
    while let Some((_, packet)) = decoder.next_packet()? {
        let AudioPacket::Samples(samples) = packet else {
            continue;
        };
        mono.extend(
            samples
                .chunks(channels)
                .map(|values| (values.iter().sum::<f64>() / values.len() as f64) as f32),
        );
    }
    Ok(mono)
}

fn open_track(session: &Session, uri: &str) -> Result<(impl AudioDecoder, u32)> {
    let track_uri = SpotifyUri::from_uri(uri).context("Not a Spotify track")?;
    if !matches!(track_uri, SpotifyUri::Track { .. }) {
        anyhow::bail!("Only Spotify tracks have a waveform");
    }
    let track_id = SpotifyId::try_from(&track_uri).context("Not a Spotify track")?;
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()?;
    let (file, key, duration_ms, format) = runtime.block_on(async {
        let item = AudioItem::get_file(session, track_uri).await?;
        let (format, file_id, rate) = FORMATS
            .iter()
            .find_map(|&(format, rate)| item.files.get(&format).map(|&id| (format, id, rate)))
            .context("No playable audio file")?;
        let (file, key) = tokio::join!(
            AudioFile::open(session, file_id, rate),
            session.audio_key().request(track_id, file_id),
        );
        anyhow::Ok((file?, key.ok(), item.duration_ms, format))
    })?;
    drop(runtime);
    let length = file.get_stream_loader_controller()?.len();
    let mut bytes = Vec::with_capacity(length);
    AudioDecrypt::new(key, file)
        .take(length as u64)
        .read_to_end(&mut bytes)
        .context("Audio download stopped")?;
    if AudioFiles::is_ogg_vorbis(format) {
        bytes.drain(..SPOTIFY_OGG_HEADER_END.min(bytes.len()));
    }
    let mut hint = Hint::new();
    if let Some(mime) = AudioFiles::mime_type(format) {
        hint.mime_type(mime);
    }
    Ok((
        SymphoniaDecoder::new(Cursor::new(bytes), hint)?,
        duration_ms,
    ))
}

fn peaks_of(mut decoder: impl AudioDecoder, duration_ms: u32, buckets: usize) -> Result<Vec<u8>> {
    let mut peaks = vec![0f64; buckets];
    let per_ms = buckets as f64 / f64::from(duration_ms);
    let frame_ms = 1000.0 / f64::from(librespot_playback::SAMPLE_RATE);
    while let Some((position, packet)) = decoder.next_packet()? {
        let AudioPacket::Samples(samples) = packet else {
            continue;
        };
        let channels = usize::from(librespot_playback::NUM_CHANNELS);
        for (frame, values) in samples.chunks(channels).enumerate() {
            let at = (f64::from(position.position_ms) + frame as f64 * frame_ms) * per_ms;
            let slot = (at as usize).min(buckets - 1);
            let loud = values
                .iter()
                .fold(0f64, |most, value| most.max(value.abs()));
            peaks[slot] = peaks[slot].max(loud);
        }
    }
    let top = peaks.iter().copied().fold(0f64, f64::max).max(1e-6);
    Ok(peaks
        .into_iter()
        .map(|peak| ((peak / top).clamp(0.0, 1.0) * 255.0).round() as u8)
        .collect())
}

fn spectrogram_tile(
    samples: &[f32],
    from_ms: f64,
    to_ms: f64,
    columns: usize,
    rows: usize,
) -> Vec<u8> {
    let rate = f64::from(librespot_playback::SAMPLE_RATE);
    let mut tile = vec![0u8; columns * rows * 2];
    let start = (from_ms / 1000.0 * rate).floor().max(0.0) as usize;
    let end = ((to_ms / 1000.0 * rate).ceil() as usize).min(samples.len());
    let Some(slice) = samples
        .get(start..end)
        .filter(|slice| slice.len() >= WINDOW)
    else {
        return tile;
    };
    let times = (slice.len() - WINDOW) / HOP + 1;
    let bins = ((TOP_HZ / (rate / WINDOW as f64)).round() as usize).min(WINDOW / 2);
    let scale = 9.0 / (2.0 * WINDOW as f64).sqrt();
    let bin_at = |row: usize| row as f64 / rows as f64 * (bins - 1) as f64 + 1.0;
    let fft = Fft::new(WINDOW);
    let mut window = vec![0f64; WINDOW];
    let time_step = (times - 1) as f64 / columns as f64;
    for column in 0..columns {
        let first = (column as f64 * time_step + 0.5) as usize * HOP;
        for (slot, &sample) in window.iter_mut().zip(&slice[first..first + WINDOW]) {
            *slot = f64::from(sample);
        }
        let levels: Vec<f64> = fft.power(&window)[..bins]
            .iter()
            .map(|power| (power.sqrt() * scale + 1.0).log10())
            .collect();
        for row in 0..rows {
            let from = (bin_at(row) as usize).min(bins - 1);
            let to = (bin_at(row + 1) as usize).min(bins);
            let level = if from >= to {
                levels[from]
            } else {
                levels[from..to].iter().copied().fold(0f64, f64::max)
            };
            let encoded = ((level / LEVEL_SPAN).clamp(0.0, 1.0) * 65535.0).round() as u16;
            let at = ((rows - 1 - row) * columns + column) * 2;
            tile[at..at + 2].copy_from_slice(&encoded.to_le_bytes());
        }
    }
    tile
}

struct Fft {
    twiddles: Vec<(f64, f64)>,
}

impl Fft {
    fn new(size: usize) -> Self {
        Self {
            twiddles: (0..size / 2)
                .map(|index| {
                    let (sin, cos) = (-TAU * index as f64 / size as f64).sin_cos();
                    (cos, sin)
                })
                .collect(),
        }
    }

    fn power(&self, samples: &[f64]) -> Vec<f64> {
        let size = self.twiddles.len() * 2;
        let mut re = samples.to_vec();
        re.resize(size, 0.0);
        let mut im = vec![0f64; size];
        let mut swap = 0;
        for index in 1..size {
            let mut bit = size >> 1;
            while swap & bit != 0 {
                swap ^= bit;
                bit >>= 1;
            }
            swap |= bit;
            if index < swap {
                re.swap(index, swap);
                im.swap(index, swap);
            }
        }
        let mut span = 2;
        while span <= size {
            let stride = size / span;
            for start in (0..size).step_by(span) {
                for offset in 0..span / 2 {
                    let (cos, sin) = self.twiddles[offset * stride];
                    let (a, b) = (start + offset, start + offset + span / 2);
                    let turned_re = re[b] * cos - im[b] * sin;
                    let turned_im = re[b] * sin + im[b] * cos;
                    re[b] = re[a] - turned_re;
                    im[b] = im[a] - turned_im;
                    re[a] += turned_re;
                    im[a] += turned_im;
                }
            }
            span <<= 1;
        }
        re.iter()
            .zip(&im)
            .take(size / 2)
            .map(|(re, im)| re * re + im * im)
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn peaks_cover_the_whole_track_and_peak_at_full_scale() {
        let decoder = SymphoniaDecoder::new(
            Cursor::new(&include_bytes!("../tests/fixtures/dj-mono.mp3")[..]),
            Hint::new(),
        )
        .unwrap();
        let peaks = peaks_of(decoder, 1000, 50).unwrap();
        assert_eq!(peaks.len(), 50);
        assert_eq!(peaks.iter().copied().max(), Some(255));
    }

    #[test]
    fn a_pure_tone_lands_in_its_own_bin() {
        let fft = Fft::new(256);
        let tone: Vec<f64> = (0..256)
            .map(|index| (TAU * 20.0 * index as f64 / 256.0).sin())
            .collect();
        let power = fft.power(&tone);
        let loudest = (0..power.len())
            .max_by(|a, b| power[*a].total_cmp(&power[*b]))
            .unwrap();
        assert_eq!(loudest, 20);
    }

    fn levels(tile: &[u8]) -> Vec<u16> {
        tile.chunks(2)
            .map(|pair| u16::from_le_bytes([pair[0], pair[1]]))
            .collect()
    }

    #[test]
    fn a_tile_puts_a_tone_on_its_row() {
        let rate = f64::from(librespot_playback::SAMPLE_RATE);
        let samples: Vec<f32> = (0..rate as usize)
            .map(|index| (TAU * 5000.0 * index as f64 / rate).sin() as f32)
            .collect();
        let tile = levels(&spectrogram_tile(&samples, 0.0, 1000.0, 10, 16));
        assert_eq!(tile.len(), 160);
        let column: Vec<u16> = (0..16).map(|row| tile[row * 10 + 5]).collect();
        let loudest = (0..16).max_by_key(|&row| column[row]).unwrap();
        // 5 kHz is a quarter of the way up a 20 kHz axis.
        assert!((11..=12).contains(&loudest), "{column:?}");
        assert!(column[loudest] > 25_000, "{column:?}");
        assert!(column[0] < column[loudest] / 3, "{column:?}");
    }

    #[test]
    fn a_tile_past_the_end_stays_silent() {
        let tile = spectrogram_tile(&[0.5; 100], 5000.0, 6000.0, 4, 8);
        assert_eq!(tile.len(), 64);
        assert!(tile.iter().all(|&level| level == 0));
    }

    #[test]
    fn a_clip_holds_exactly_its_range() {
        let rate = librespot_playback::SAMPLE_RATE as usize;
        let samples: Vec<f32> = (0..rate * 2).map(|index| index as f32).collect();
        let values = clip_of(&samples, 500.0, 750.0);
        assert_eq!(values.len(), rate / 4);
        assert_eq!(values[0], (rate / 2) as f32);
        assert_eq!(*values.last().unwrap(), (rate * 3 / 4 - 1) as f32);
        assert!(clip_of(&samples, 5000.0, 6000.0).is_empty());
        assert!(clip_of(&samples, 900.0, 800.0).is_empty());
    }

    #[test]
    fn decoded_mono_covers_the_fixture() {
        let decoder = SymphoniaDecoder::new(
            Cursor::new(&include_bytes!("../tests/fixtures/dj-mono.mp3")[..]),
            Hint::new(),
        )
        .unwrap();
        let mono = mono_of(decoder).unwrap();
        assert!(!mono.is_empty());
        assert!(mono.iter().any(|&sample| sample.abs() > 0.01));
    }
}
