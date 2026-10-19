//! Raw microphone capture and speech endpoints, independent of dictated words.
use super::voice::Progress;
use anyhow::{Context, Result, ensure};
use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use std::{
    collections::VecDeque,
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
        mpsc,
    },
    time::{Duration, Instant},
};
use webrtc_vad::{SampleRate, Vad, VadMode};

const RATE: usize = 16_000;
const FRAME: usize = 320;
const QUIET: usize = RATE * 12 / 10;
const LIMIT: usize = RATE * 30;

pub(super) struct Endpoint {
    vad: Vad,
    frame: Vec<f32>,
    history: VecDeque<f32>,
    votes: VecDeque<bool>,
    audio: Vec<f32>,
    elapsed: usize,
    last_voice: usize,
    pub level: u8,
    pub speech: bool,
    pub done: bool,
}
impl Default for Endpoint {
    fn default() -> Self {
        Self {
            vad: Vad::new_with_rate_and_mode(SampleRate::Rate16kHz, VadMode::Aggressive),
            frame: Vec::with_capacity(FRAME),
            history: VecDeque::new(),
            votes: VecDeque::new(),
            audio: Vec::new(),
            elapsed: 0,
            last_voice: 0,
            level: 0,
            speech: false,
            done: false,
        }
    }
}
impl Endpoint {
    pub fn feed(&mut self, sample: f32) -> Result<()> {
        if self.done {
            return Ok(());
        }
        let sample = if sample.is_finite() {
            sample.clamp(-1.0, 1.0)
        } else {
            0.0
        };
        self.frame.push(sample);
        if self.frame.len() < FRAME {
            return Ok(());
        }
        self.elapsed += FRAME;
        let energy = self
            .frame
            .iter()
            .map(|s| f64::from(*s).powi(2))
            .sum::<f64>()
            / FRAME as f64;
        let rms = energy.sqrt();
        self.level = if rms < 0.0001 {
            0
        } else {
            ((20.0 * rms.log10() + 65.0) / 55.0 * 100.0).clamp(0.0, 100.0) as u8
        };
        let mut pcm = [0i16; FRAME];
        for (output, input) in pcm.iter_mut().zip(&self.frame) {
            *output = (*input * 32768.0).clamp(-32768.0, 32767.0) as i16;
        }
        let voiced = self
            .vad
            .is_voice_segment(&pcm)
            .map_err(|_| anyhow::anyhow!("Speech detection failed"))?;
        self.votes.push_back(voiced);
        if self.votes.len() > 10 {
            self.votes.pop_front();
        }
        // Require sustained speech, so a click or short VAD startup burst cannot open a request.
        self.speech = self.votes.iter().filter(|v| **v).count() >= 6;
        if self.audio.is_empty() {
            self.history.extend(self.frame.iter().copied());
            while self.history.len() > RATE * 4 / 10 {
                self.history.pop_front();
            }
            if self.speech {
                self.audio.extend(self.history.drain(..));
            }
        } else {
            self.audio.extend(self.frame.iter().copied());
        }
        if self.speech {
            self.last_voice = self.elapsed;
        }
        self.frame.clear();
        if !self.audio.is_empty() && self.elapsed.saturating_sub(self.last_voice) >= QUIET {
            self.done = true;
        }
        if self.elapsed >= LIMIT || (self.audio.is_empty() && self.elapsed >= RATE * 8) {
            self.done = true;
        }
        Ok(())
    }
    pub fn finish(mut self) -> Result<Vec<f32>> {
        ensure!(
            !self.audio.is_empty(),
            "No speech detected. Try again or type your request"
        );
        // Keep a short tail, rather than sending the whole endpoint wait to Whisper.
        let quiet = self.elapsed.saturating_sub(self.last_voice);
        self.audio.truncate(
            self.audio
                .len()
                .saturating_sub(quiet.saturating_sub(RATE / 5)),
        );
        Ok(self.audio)
    }
}

struct Resampler {
    rate: u64,
    index: u64,
    next: u64,
    previous: f32,
}
impl Resampler {
    fn new(rate: u32) -> Self {
        Self {
            rate: u64::from(rate),
            index: 0,
            next: 0,
            previous: 0.0,
        }
    }
    fn push(&mut self, value: f32, mut output: impl FnMut(f32) -> Result<()>) -> Result<()> {
        let end = self.index * RATE as u64;
        while self.next <= end {
            let sample = if self.index == 0 {
                value
            } else {
                let start = (self.index - 1) * RATE as u64;
                let fraction = (self.next - start) as f32 / RATE as f32;
                self.previous + (value - self.previous) * fraction
            };
            output(sample)?;
            self.next += self.rate;
        }
        self.previous = value;
        self.index += 1;
        Ok(())
    }
}

fn stream<T>(
    device: &cpal::Device,
    config: &cpal::StreamConfig,
    send: mpsc::SyncSender<Vec<f32>>,
    failed: Arc<AtomicBool>,
) -> Result<cpal::Stream>
where
    T: cpal::SizedSample,
    f32: cpal::FromSample<T>,
{
    let channels = usize::from(config.channels);
    let error = failed.clone();
    device
        .build_input_stream(
            config,
            move |data: &[T], _| {
                if data.len() > 2_000_000 {
                    failed.store(true, Ordering::Release);
                    return;
                }
                let mono = data
                    .chunks_exact(channels)
                    .map(|frame| {
                        frame
                            .iter()
                            .map(|sample| <f32 as cpal::Sample>::from_sample(*sample))
                            .sum::<f32>()
                            / channels as f32
                    })
                    .collect();
                if send.try_send(mono).is_err() {
                    failed.store(true, Ordering::Release);
                }
            },
            move |_| {
                error.store(true, Ordering::Release);
            },
            None,
        )
        .context("Cannot open Windows Default microphone. Check microphone permissions")
}

pub(super) fn capture(
    cancelled: &AtomicBool,
    report: &mut impl FnMut(Progress),
) -> Result<Vec<f32>> {
    ensure!(
        !cancelled.load(Ordering::Acquire),
        "Voice capture cancelled"
    );
    let device = cpal::default_host()
        .default_input_device()
        .context("Windows Default microphone unavailable")?;
    let supported = device
        .default_input_config()
        .context("Windows Default microphone format unavailable")?;
    let config: cpal::StreamConfig = supported.clone().into();
    ensure!(
        config.channels > 0
            && config.channels <= 32
            && (8_000..=192_000).contains(&config.sample_rate.0),
        "Unsupported microphone format"
    );
    let (send, receive) = mpsc::sync_channel(32);
    let failed = Arc::new(AtomicBool::new(false));
    let stream = match supported.sample_format() {
        cpal::SampleFormat::F32 => stream::<f32>(&device, &config, send, failed.clone()),
        cpal::SampleFormat::F64 => stream::<f64>(&device, &config, send, failed.clone()),
        cpal::SampleFormat::I8 => stream::<i8>(&device, &config, send, failed.clone()),
        cpal::SampleFormat::I16 => stream::<i16>(&device, &config, send, failed.clone()),
        cpal::SampleFormat::I24 => stream::<cpal::I24>(&device, &config, send, failed.clone()),
        cpal::SampleFormat::I32 => stream::<i32>(&device, &config, send, failed.clone()),
        cpal::SampleFormat::I64 => stream::<i64>(&device, &config, send, failed.clone()),
        cpal::SampleFormat::U8 => stream::<u8>(&device, &config, send, failed.clone()),
        cpal::SampleFormat::U16 => stream::<u16>(&device, &config, send, failed.clone()),
        cpal::SampleFormat::U32 => stream::<u32>(&device, &config, send, failed.clone()),
        cpal::SampleFormat::U64 => stream::<u64>(&device, &config, send, failed.clone()),
        _ => anyhow::bail!("Unsupported Windows microphone sample format"),
    }?;
    stream.play().context("Microphone could not start")?;
    let started = Instant::now();
    let mut last_report = started;
    let mut endpoint = Endpoint::default();
    let mut resampler = Resampler::new(config.sample_rate.0);
    report(Progress::default());
    while !endpoint.done && started.elapsed() < Duration::from_secs(30) {
        ensure!(
            !cancelled.load(Ordering::Acquire),
            "Voice capture cancelled"
        );
        ensure!(
            !failed.load(Ordering::Acquire),
            "Microphone capture interrupted. Try again"
        );
        match receive.recv_timeout(Duration::from_millis(50)) {
            Ok(samples) => {
                for sample in samples {
                    resampler.push(sample, |sample| endpoint.feed(sample))?;
                }
            }
            Err(mpsc::RecvTimeoutError::Timeout) => {}
            Err(_) => anyhow::bail!("Microphone disconnected"),
        }
        if last_report.elapsed() >= Duration::from_millis(50) || endpoint.done {
            report(Progress {
                level: endpoint.level,
                speech: endpoint.speech,
                ..Default::default()
            });
            last_report = Instant::now();
        }
        if endpoint.audio.is_empty() && started.elapsed() >= Duration::from_secs(8) {
            break;
        }
    }
    drop(stream);
    ensure!(
        !failed.load(Ordering::Acquire),
        "Microphone capture interrupted. Try again"
    );
    ensure!(
        !cancelled.load(Ordering::Acquire),
        "Voice capture cancelled"
    );
    endpoint.finish()
}

#[cfg(test)]
pub(super) fn from_samples(samples: &[f32], rate: u32) -> Result<Vec<f32>> {
    ensure!((8_000..=192_000).contains(&rate), "Invalid sample rate");
    let mut endpoint = Endpoint::default();
    let mut resampler = Resampler::new(rate);
    for sample in samples {
        resampler.push(*sample, |sample| endpoint.feed(sample))?;
    }
    // File fixtures have no live clock; append quiet frames to exercise the real endpoint.
    for _ in 0..RATE * 2 {
        endpoint.feed(0.0)?;
    }
    endpoint.finish()
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn silence_and_short_clicks_cannot_start_a_request() {
        let mut endpoint = Endpoint::default();
        for index in 0..RATE * 8 {
            endpoint
                .feed(if index == RATE { 0.9 } else { 0.0 })
                .unwrap();
        }
        assert!(endpoint.done);
        assert!(endpoint.finish().is_err());
    }
    #[test]
    fn resampling_preserves_duration_across_callback_boundaries() {
        for rate in [8_000, 16_000, 44_100, 48_000, 96_000] {
            let mut resampler = Resampler::new(rate);
            let mut output = Vec::new();
            for _ in 0..rate {
                resampler
                    .push(0.25, |value| {
                        output.push(value);
                        Ok(())
                    })
                    .unwrap();
            }
            assert!((output.len() as i32 - 16_000).abs() <= 2);
            assert!(output.iter().all(|value| (*value - 0.25).abs() < 0.001));
        }
    }
}
