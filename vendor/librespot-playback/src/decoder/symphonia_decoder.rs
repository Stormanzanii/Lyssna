use std::{io, time::Duration};

use symphonia::core::{
    audio::SampleBuffer,
    codecs::{Decoder, DecoderOptions},
    errors::Error,
    formats::{FormatOptions, SeekMode, SeekTo},
    io::{MediaSource, MediaSourceStream, MediaSourceStreamOptions},
    meta::{MetadataOptions, StandardTagKey, Value},
    probe::{Hint, ProbeResult},
};

use super::{AudioDecoder, AudioPacket, AudioPacketPosition, DecoderError, DecoderResult};

use crate::{PAGES_PER_MS, SAMPLE_RATE, player::NormalisationData, symphonia_util};

pub struct SymphoniaDecoder {
    probe_result: ProbeResult,
    decoder: Box<dyn Decoder>,
    sample_buffer: Option<SampleBuffer<f64>>,
    /// Channels in the input. Mono, such as DJ narration, is played on both
    /// sides; surround local files keep their front left and right.
    channels: usize,
    /// Local files at rates other than the player's 44.1 kHz.
    resampler: Option<Resampler>,
    /// Quiet local files are raised toward Spotify's loudness.
    limiter: Option<Limiter>,
}

/// A boost with an instant-attack limiter, so raised peaks stay below
/// full scale instead of clipping.
struct Limiter {
    gain: f64,
    /// Gain reduction now applied, 1 when none.
    envelope: f64,
    /// How far the reduction recovers each frame.
    release: f64,
}

impl Limiter {
    /// Peaks are held below -1 dBFS.
    const CEILING: f64 = 0.891;

    fn new(gain_db: f64) -> Self {
        Self {
            gain: 10f64.powf(gain_db / 20.0),
            envelope: 1.0,
            // Recovers over about 100 ms.
            release: 1.0 - (-1.0 / (0.1 * f64::from(SAMPLE_RATE))).exp(),
        }
    }

    fn process(&mut self, stereo: &mut [f64]) {
        for frame in stereo.chunks_exact_mut(2) {
            let peak = frame[0].abs().max(frame[1].abs()) * self.gain;
            let wanted = if peak > Self::CEILING {
                Self::CEILING / peak
            } else {
                1.0
            };
            self.envelope = if wanted < self.envelope {
                wanted
            } else {
                self.envelope + (wanted - self.envelope) * self.release
            };
            for sample in frame {
                *sample *= self.gain * self.envelope;
            }
        }
    }
}

/// Linear resampling of stereo frames to the player's rate, carried across
/// packets so packet edges stay seamless.
struct Resampler {
    /// Input frames per output frame.
    step: f64,
    /// Position of the next output frame; 0 is the last frame of the
    /// previous packet.
    position: f64,
    previous: [f64; 2],
}

impl Resampler {
    fn new(rate: u32) -> Self {
        Self {
            step: f64::from(rate) / f64::from(SAMPLE_RATE),
            position: 1.0,
            previous: [0.0; 2],
        }
    }

    fn reset(&mut self) {
        self.position = 1.0;
        self.previous = [0.0; 2];
    }

    fn process(&mut self, stereo: &[f64]) -> Vec<f64> {
        let frames = stereo.len() / 2;
        let frame = |index: usize, channel: usize| {
            if index == 0 {
                self.previous[channel]
            } else {
                stereo[(index - 1) * 2 + channel]
            }
        };
        let mut output = Vec::with_capacity(((frames as f64 / self.step) as usize + 2) * 2);
        while self.position < frames as f64 {
            let index = self.position as usize;
            let along = self.position - index as f64;
            for channel in 0..2 {
                let (from, to) = (frame(index, channel), frame(index + 1, channel));
                output.push(from + (to - from) * along);
            }
            self.position += self.step;
        }
        if frames > 0 {
            self.previous = [stereo[(frames - 1) * 2], stereo[(frames - 1) * 2 + 1]];
            self.position -= frames as f64;
        }
        output
    }
}

#[derive(Default)]
pub(crate) struct LocalFileMetadata {
    pub name: Option<String>,
    pub language: Option<String>,
    pub album: Option<String>,
    pub artists: Option<String>,
    pub album_artists: Option<String>,
    pub number: Option<u32>,
    pub disc_number: Option<u32>,
}

impl SymphoniaDecoder {
    pub fn new<R>(input: R, hint: Hint) -> DecoderResult<Self>
    where
        R: MediaSource + 'static,
    {
        let mss_opts = MediaSourceStreamOptions {
            buffer_len: librespot_audio::AudioFetchParams::get().minimum_download_size,
        };
        let mss = MediaSourceStream::new(Box::new(input), mss_opts);

        let format_opts = FormatOptions {
            enable_gapless: true,
            ..Default::default()
        };
        let metadata_opts: MetadataOptions = Default::default();

        let probe_result =
            symphonia::default::get_probe().format(&hint, mss, &format_opts, &metadata_opts)?;

        let format = &probe_result.format;

        let track = format.default_track().ok_or_else(|| {
            DecoderError::SymphoniaDecoder("Could not retrieve default track".into())
        })?;

        let decoder_opts: DecoderOptions = Default::default();

        let decoder = symphonia::default::get_codecs().make(&track.codec_params, &decoder_opts)?;

        let rate = decoder.codec_params().sample_rate.ok_or_else(|| {
            DecoderError::SymphoniaDecoder("Could not retrieve sample rate".into())
        })?;

        // Local files at 48 kHz, 96 kHz and so on are resampled to the
        // player's rate, as the official client plays them.
        let resampler = (rate != SAMPLE_RATE).then(|| Resampler::new(rate));

        let channels = decoder
            .codec_params()
            .channels
            .ok_or_else(|| {
                DecoderError::SymphoniaDecoder("Could not retrieve channel configuration".into())
            })?
            .count();
        if channels == 0 {
            return Err(DecoderError::SymphoniaDecoder(
                "Unsupported number of channels: 0".into(),
            ));
        }

        Ok(Self {
            probe_result,
            decoder,
            // We set the sample buffer when decoding the first full packet,
            // whose duration is also the ideal sample buffer size.
            sample_buffer: None,
            channels,
            resampler,
            limiter: None,
        })
    }

    /// Raise a local file by `gain_db`, limiting peaks. 0 leaves it as is.
    pub fn set_gain(&mut self, gain_db: f64) {
        self.limiter = (gain_db > 0.0 && gain_db.is_finite()).then(|| Limiter::new(gain_db));
    }

    pub fn normalisation_data(&mut self) -> Option<NormalisationData> {
        let metadata = symphonia_util::get_latest_metadata(&mut self.probe_result)?;
        let tags = metadata.current()?.tags();

        if tags.is_empty() {
            None
        } else {
            let mut data = NormalisationData::default();

            for tag in tags {
                if let Value::Float(value) = tag.value {
                    match tag.std_key {
                        Some(StandardTagKey::ReplayGainAlbumGain) => data.album_gain_db = value,
                        Some(StandardTagKey::ReplayGainAlbumPeak) => data.album_peak = value,
                        Some(StandardTagKey::ReplayGainTrackGain) => data.track_gain_db = value,
                        Some(StandardTagKey::ReplayGainTrackPeak) => data.track_peak = value,
                        _ => (),
                    }
                }
            }

            Some(data)
        }
    }

    pub(crate) fn local_file_metadata(&mut self) -> Option<LocalFileMetadata> {
        let metadata = symphonia_util::get_latest_metadata(&mut self.probe_result)?;
        let tags = metadata.current()?.tags();
        let mut metadata = LocalFileMetadata::default();

        for tag in tags {
            if let Value::String(value) = &tag.value {
                match tag.std_key {
                    // We could possibly use mem::take here to avoid cloning, but that risks leaving
                    // the audio item metadata in a bad state.
                    Some(StandardTagKey::TrackTitle) => metadata.name = Some(value.clone()),
                    Some(StandardTagKey::Language) => metadata.language = Some(value.clone()),
                    Some(StandardTagKey::Artist) => metadata.artists = Some(value.clone()),
                    Some(StandardTagKey::AlbumArtist) => {
                        metadata.album_artists = Some(value.clone())
                    }
                    Some(StandardTagKey::Album) => metadata.album = Some(value.clone()),
                    Some(StandardTagKey::TrackNumber) => {
                        metadata.number = match value.parse::<u32>() {
                            Ok(value) => Some(value),
                            Err(e) => {
                                warn!(
                                    "Failed to parse local file's track number tag '{value}': {e}"
                                );
                                None
                            }
                        }
                    }
                    Some(StandardTagKey::DiscNumber) => {
                        metadata.disc_number = match value.parse::<u32>() {
                            Ok(value) => Some(value),
                            Err(e) => {
                                warn!(
                                    "Failed to parse local file's disc number tag '{value}': {e}"
                                );
                                None
                            }
                        }
                    }
                    _ => (),
                }
            } else if let Value::UnsignedInt(value) = &tag.value {
                match tag.std_key {
                    Some(StandardTagKey::TrackNumber) => metadata.number = Some(*value as u32),
                    Some(StandardTagKey::DiscNumber) => metadata.disc_number = Some(*value as u32),
                    _ => (),
                }
            } else if let Value::SignedInt(value) = &tag.value {
                match tag.std_key {
                    Some(StandardTagKey::TrackNumber) => metadata.number = Some(*value as u32),
                    Some(StandardTagKey::DiscNumber) => metadata.disc_number = Some(*value as u32),
                    _ => (),
                }
            }
        }

        Some(metadata)
    }

    #[inline]
    fn ts_to_ms(&self, ts: u64) -> u32 {
        match self.decoder.codec_params().time_base {
            Some(time_base) => {
                let time = Duration::from(time_base.calc_time(ts));
                time.as_millis() as u32
            }
            // Fallback in the unexpected case that the format has no base time set.
            None => (ts as f64 * PAGES_PER_MS) as u32,
        }
    }
}

impl AudioDecoder for SymphoniaDecoder {
    fn seek(&mut self, position_ms: u32) -> Result<u32, DecoderError> {
        // "Saturate" the position_ms to the duration of the track if it exceeds it.
        let mut target = Duration::from_millis(position_ms.into());
        let codec_params = self.decoder.codec_params();
        if let (Some(time_base), Some(n_frames)) = (codec_params.time_base, codec_params.n_frames) {
            let duration = Duration::from(time_base.calc_time(n_frames));
            if target > duration {
                target = duration;
            }
        }

        // `track_id: None` implies the default track ID (of the container, not of Spotify).
        let seeked_to_ts = self.probe_result.format.seek(
            SeekMode::Accurate,
            SeekTo::Time {
                time: target.into(),
                track_id: None,
            },
        )?;

        // Seeking is a `FormatReader` operation, so the decoder cannot reliably
        // know when a seek took place. Reset it to avoid audio glitches.
        self.decoder.reset();
        if let Some(resampler) = self.resampler.as_mut() {
            resampler.reset();
        }

        Ok(self.ts_to_ms(seeked_to_ts.actual_ts))
    }

    fn next_packet(&mut self) -> DecoderResult<Option<(AudioPacketPosition, AudioPacket)>> {
        let mut skipped = false;

        loop {
            let packet = match self.probe_result.format.next_packet() {
                Ok(packet) => packet,
                Err(Error::IoError(err)) => {
                    if err.kind() == io::ErrorKind::UnexpectedEof {
                        return Ok(None);
                    } else {
                        return Err(DecoderError::SymphoniaDecoder(err.to_string()));
                    }
                }
                Err(err) => {
                    return Err(err.into());
                }
            };

            let position_ms = self.ts_to_ms(packet.ts());
            let packet_position = AudioPacketPosition {
                position_ms,
                skipped,
            };

            match self.decoder.decode(&packet) {
                Ok(decoded) => {
                    let sample_buffer = match self.sample_buffer.as_mut() {
                        Some(buffer) => buffer,
                        None => {
                            let spec = *decoded.spec();
                            let duration = decoded.capacity() as u64;
                            self.sample_buffer.insert(SampleBuffer::new(duration, spec))
                        }
                    };

                    sample_buffer.copy_interleaved_ref(decoded);
                    let samples = sample_buffer.samples();
                    let stereo: Vec<f64> = match self.channels {
                        1 => samples.iter().flat_map(|&s| [s, s]).collect(),
                        2 => samples.to_vec(),
                        channels => samples
                            .chunks_exact(channels)
                            .flat_map(|frame| [frame[0], frame[1]])
                            .collect(),
                    };
                    let mut stereo = match self.resampler.as_mut() {
                        Some(resampler) => resampler.process(&stereo),
                        None => stereo,
                    };
                    if let Some(limiter) = self.limiter.as_mut() {
                        limiter.process(&mut stereo);
                    }
                    let samples = AudioPacket::Samples(stereo);

                    return Ok(Some((packet_position, samples)));
                }
                Err(Error::DecodeError(_)) => {
                    // The packet failed to decode due to corrupted or invalid data, get a new
                    // packet and try again.
                    warn!("Skipping malformed audio packet at {position_ms} ms");
                    skipped = true;
                    continue;
                }
                Err(err) => return Err(err.into()),
            }
        }
    }
}

#[cfg(test)]
mod limiter_tests {
    use super::Limiter;

    #[test]
    fn quiet_audio_is_raised_and_peaks_stay_below_full_scale() {
        let mut limiter = Limiter::new(6.0);
        let mut quiet = vec![0.1; 8];
        limiter.process(&mut quiet);
        assert!(quiet.iter().all(|sample| (sample - 0.1995).abs() < 0.001));
        let mut loud = vec![0.9, -0.9, 0.9, -0.9];
        limiter.process(&mut loud);
        assert!(
            loud.iter()
                .all(|sample| sample.abs() <= Limiter::CEILING + 1e-9)
        );
    }
}

#[cfg(test)]
mod resampler_tests {
    use super::Resampler;

    #[test]
    fn resampling_keeps_length_and_joins_packets_smoothly() {
        // One second of a 48 kHz ramp, split into uneven packets.
        let ramp: Vec<f64> = (0..48_000)
            .flat_map(|frame| {
                let value = frame as f64 / 48_000.0;
                [value, -value]
            })
            .collect();
        let mut resampler = Resampler::new(48_000);
        let mut output = Vec::new();
        for packet in ramp.chunks(1152 * 2 + 6) {
            output.extend(resampler.process(packet));
        }
        let frames = output.len() / 2;
        assert!((44_098..=44_100).contains(&frames), "{frames} frames");
        // A ramp stays a ramp: each step is the same, packet edges included.
        let step = 48_000.0 / 44_100.0 / 48_000.0;
        for pair in output
            .chunks_exact(2)
            .collect::<Vec<_>>()
            .windows(2)
            .skip(1)
        {
            assert!((pair[1][0] - pair[0][0] - step).abs() < 1e-9);
            assert_eq!(pair[1][1], -pair[1][0]);
        }
    }

    #[test]
    fn a_reset_starts_from_silence() {
        let mut resampler = Resampler::new(96_000);
        resampler.process(&[1.0; 64]);
        resampler.reset();
        let output = resampler.process(&[1.0; 8]);
        assert_eq!(output[0], 1.0);
    }
}
