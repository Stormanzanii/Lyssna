use anyhow::{Context, Result};
use librespot_audio::{AudioDecrypt, AudioFile};
use librespot_core::{Session, SpotifyId, SpotifyUri};
use librespot_metadata::audio::{AudioFileFormat, AudioFiles, AudioItem};
use librespot_playback::decoder::{AudioDecoder, AudioPacket, SymphoniaDecoder};
use std::{
    collections::VecDeque,
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

type Kept = (String, usize, Arc<Vec<u8>>);
static RECENT: Mutex<VecDeque<Kept>> = Mutex::new(VecDeque::new());

/// Peak loudness of `buckets` equal slices of the whole track, 0 to 255.
pub(crate) fn track_peaks(session: &Session, uri: &str, buckets: usize) -> Result<Arc<Vec<u8>>> {
    let buckets = buckets.clamp(1, 8000);
    if let Some((_, _, peaks)) = RECENT.lock().ok().and_then(|recent| {
        recent
            .iter()
            .find(|(u, b, _)| u == uri && *b == buckets)
            .cloned()
    }) {
        return Ok(peaks);
    }
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
    let decoder = SymphoniaDecoder::new(Cursor::new(bytes), hint)?;
    let peaks = Arc::new(peaks_of(decoder, duration_ms.max(1), buckets)?);
    if let Ok(mut recent) = RECENT.lock() {
        recent.push_front((uri.to_owned(), buckets, peaks.clone()));
        recent.truncate(KEPT);
    }
    Ok(peaks)
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
}
