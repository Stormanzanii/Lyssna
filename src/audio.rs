//! Small, bounded audio queue. Seek acknowledgements discard previously decoded samples.
use librespot_playback::{
    audio_backend::{Sink, SinkError, SinkResult},
    convert::Converter,
    decoder::AudioPacket,
};
use rodio::{OutputStream, OutputStreamBuilder, Source};
use std::{
    sync::{
        Arc,
        atomic::{AtomicBool, AtomicUsize, Ordering},
    },
    thread,
    time::Duration,
};

const CHANNELS: u16 = 2;
const SAMPLE_RATE: u32 = 44_100;
const MAX_SAMPLES: usize = SAMPLE_RATE as usize * CHANNELS as usize * 80 / 1000;

pub struct AudioSink {
    stream: Option<OutputStream>,
    sink: Option<rodio::Sink>,
    queued: Arc<AtomicUsize>,
    flush: Arc<AtomicBool>,
    seek_ready: tokio::sync::mpsc::UnboundedSender<()>,
    awaiting_seek: bool,
}
impl AudioSink {
    pub fn new(flush: Arc<AtomicBool>, seek_ready: tokio::sync::mpsc::UnboundedSender<()>) -> Self {
        Self {
            stream: None,
            sink: None,
            queued: Arc::default(),
            flush,
            seek_ready,
            awaiting_seek: false,
        }
    }
    fn discard_old_audio(&mut self) {
        if self.flush.swap(false, Ordering::AcqRel)
            && let Some(sink) = &self.sink
        {
            sink.stop();
            self.awaiting_seek = true;
        }
    }
}
impl Sink for AudioSink {
    fn start(&mut self) -> SinkResult<()> {
        if self.sink.is_none() {
            let mut stream = OutputStreamBuilder::open_default_stream().map_err(|_| {
                SinkError::ConnectionRefused("Cannot open default audio device".into())
            })?;
            stream.log_on_drop(false);
            self.sink = Some(rodio::Sink::connect_new(stream.mixer()));
            self.stream = Some(stream);
        }
        self.sink.as_ref().unwrap().play();
        Ok(())
    }
    fn stop(&mut self) -> SinkResult<()> {
        if let Some(sink) = &self.sink {
            sink.stop();
        }
        Ok(())
    }
    fn write(&mut self, packet: AudioPacket, converter: &mut Converter) -> SinkResult<()> {
        self.discard_old_audio();
        let samples = packet
            .samples()
            .map_err(|_| SinkError::OnWrite("Cannot decode audio samples".into()))?;
        let samples = converter.f64_to_f32(samples).to_vec();
        let sink = self
            .sink
            .as_ref()
            .ok_or_else(|| SinkError::NotConnected("Audio output not started".into()))?;
        sink.append(QueuedPacket::new(samples, self.queued.clone()));
        if self.awaiting_seek {
            self.awaiting_seek = false;
            let _ = self.seek_ready.send(());
        }
        while self.queued.load(Ordering::Relaxed) > MAX_SAMPLES {
            self.discard_old_audio();
            thread::sleep(Duration::from_millis(2));
        }
        Ok(())
    }
}

struct QueuedPacket {
    samples: std::vec::IntoIter<f32>,
    queued: Arc<AtomicUsize>,
    duration: Duration,
}
impl QueuedPacket {
    fn new(samples: Vec<f32>, queued: Arc<AtomicUsize>) -> Self {
        let duration = Duration::from_secs_f64(
            samples.len() as f64 / f64::from(SAMPLE_RATE) / f64::from(CHANNELS),
        );
        queued.fetch_add(samples.len(), Ordering::Relaxed);
        Self {
            samples: samples.into_iter(),
            queued,
            duration,
        }
    }
}
impl Iterator for QueuedPacket {
    type Item = f32;
    fn next(&mut self) -> Option<f32> {
        let sample = self.samples.next();
        if sample.is_some() {
            self.queued.fetch_sub(1, Ordering::Relaxed);
        }
        sample
    }
}
impl Drop for QueuedPacket {
    fn drop(&mut self) {
        self.queued.fetch_sub(self.samples.len(), Ordering::Relaxed);
    }
}
impl Source for QueuedPacket {
    fn current_span_len(&self) -> Option<usize> {
        Some(self.samples.len())
    }
    fn channels(&self) -> u16 {
        CHANNELS
    }
    fn sample_rate(&self) -> u32 {
        SAMPLE_RATE
    }
    fn total_duration(&self) -> Option<Duration> {
        Some(self.duration)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn seek_discards_old_samples_before_new_audio_without_waiting_for_playback() {
        let queued = Arc::new(AtomicUsize::new(0));
        let (sink, mut output) = rodio::Sink::new();
        sink.append(QueuedPacket::new(vec![0.25; MAX_SAMPLES], queued.clone()));
        assert_eq!(output.next(), Some(0.25));
        sink.stop();
        for _ in 0..1000 {
            output.next();
            if sink.empty() {
                break;
            }
        }
        assert!(sink.empty());
        assert_eq!(queued.load(Ordering::Relaxed), 0);
        sink.append(QueuedPacket::new(vec![0.75; 100], queued.clone()));
        assert!((0..1024).any(|_| output.next() == Some(0.75)));
    }
    #[test]
    fn queued_samples_account_for_playback_and_dropped_packets() {
        let queued = Arc::new(AtomicUsize::new(0));
        let mut first = QueuedPacket::new(vec![0.0; 100], queued.clone());
        let second = QueuedPacket::new(vec![0.0; 200], queued.clone());
        assert_eq!(queued.load(Ordering::Relaxed), 300);
        first.next();
        assert_eq!(queued.load(Ordering::Relaxed), 299);
        drop(first);
        assert_eq!(queued.load(Ordering::Relaxed), 200);
        drop(second);
        assert_eq!(queued.load(Ordering::Relaxed), 0);
    }
}
