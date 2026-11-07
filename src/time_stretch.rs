//! Pitch-preserving speed change (WSOLA) for interleaved stereo audio.
//!
//! Windows of the input are overlap-added at a fixed output hop while the
//! input advances by `hop * rate`. Each window is nudged within a small
//! search range to line up with the natural continuation of the one before,
//! so the waveform joins without phase clicks.

const CHANNELS: usize = 2;
const HOP: usize = 1024;
const WINDOW: usize = HOP * 2;
const SEARCH: usize = 384;

pub struct TimeStretch {
    rate: f64,
    input: Vec<f32>,
    position: f64,
    previous: Option<usize>,
    tail: Vec<f32>,
    window: Vec<f32>,
}

impl TimeStretch {
    pub fn new() -> Self {
        let window = (0..WINDOW)
            .map(|index| {
                let phase = std::f32::consts::PI * 2.0 * index as f32 / WINDOW as f32;
                0.5 - 0.5 * phase.cos()
            })
            .collect();
        Self {
            rate: 1.0,
            input: Vec::new(),
            position: SEARCH as f64,
            previous: None,
            tail: vec![0.0; HOP * CHANNELS],
            window,
        }
    }

    pub fn rate(&self) -> f64 {
        self.rate
    }

    pub fn set_rate(&mut self, rate: f64) {
        self.rate = rate.clamp(0.25, 2.0);
    }

    pub fn reset(&mut self) {
        let rate = self.rate;
        *self = Self::new();
        self.rate = rate;
    }

    fn frames(&self) -> usize {
        self.input.len() / CHANNELS
    }

    fn mono(&self, frame: usize) -> f32 {
        self.input[frame * CHANNELS] + self.input[frame * CHANNELS + 1]
    }

    fn best_offset(&self, start: usize) -> isize {
        let Some(previous) = self.previous else {
            return 0;
        };
        let natural = previous + HOP;
        let mut best = (f32::MIN, 0isize);
        for offset in (-(SEARCH as isize)..=SEARCH as isize).step_by(2) {
            let candidate = (start as isize + offset) as usize;
            let (mut dot, mut energy) = (0.0f32, 1e-9f32);
            for frame in (0..HOP).step_by(4) {
                let value = self.mono(candidate + frame);
                dot += value * self.mono(natural + frame);
                energy += value * value;
            }
            let score = dot / energy.sqrt();
            if score > best.0 {
                best = (score, offset);
            }
        }
        best.1
    }

    pub fn process(&mut self, samples: &[f32]) -> Vec<f32> {
        self.input.extend_from_slice(samples);
        let mut output = Vec::with_capacity((samples.len() as f64 / self.rate) as usize + HOP);
        loop {
            let start = self.position.round() as usize;
            let needed = start + SEARCH + WINDOW;
            if self.frames() < needed || self.previous.is_some_and(|p| self.frames() < p + HOP * 2)
            {
                break;
            }
            let chosen = (start as isize + self.best_offset(start)) as usize;
            for frame in 0..WINDOW {
                let weight = self.window[frame];
                for channel in 0..CHANNELS {
                    let value = self.input[(chosen + frame) * CHANNELS + channel] * weight;
                    if frame < HOP {
                        output.push(self.tail[frame * CHANNELS + channel] + value);
                    } else {
                        self.tail[(frame - HOP) * CHANNELS + channel] = value;
                    }
                }
            }
            self.previous = Some(chosen);
            self.position += HOP as f64 * self.rate;
            // Drop input no later window or join can reach.
            let keep_from = chosen.min(self.position as usize).saturating_sub(SEARCH);
            if keep_from > 0 {
                self.input.drain(..keep_from * CHANNELS);
                self.position -= keep_from as f64;
                self.previous = Some(chosen - keep_from);
            }
        }
        output
    }
}

impl Default for TimeStretch {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tone(frames: usize, hz: f32) -> Vec<f32> {
        (0..frames)
            .flat_map(|frame| {
                let value = (frame as f32 * hz * std::f32::consts::TAU / 44_100.0).sin() * 0.5;
                [value, value]
            })
            .collect()
    }

    fn stretched_length(rate: f64) -> f64 {
        let mut stretch = TimeStretch::new();
        stretch.set_rate(rate);
        let input = tone(44_100 * 4, 440.0);
        let mut out = 0;
        for chunk in input.chunks(4096) {
            out += stretch.process(chunk).len();
        }
        out as f64 / input.len() as f64
    }

    #[test]
    fn half_speed_doubles_and_faster_speed_shortens_the_audio() {
        assert!((stretched_length(0.5) - 2.0).abs() < 0.05);
        assert!((stretched_length(1.5) - 1.0 / 1.5).abs() < 0.05);
        assert!((stretched_length(1.0) - 1.0).abs() < 0.05);
    }

    #[test]
    fn slowed_audio_keeps_its_pitch_and_level() {
        let mut stretch = TimeStretch::new();
        stretch.set_rate(0.5);
        let mut out = Vec::new();
        for chunk in tone(44_100 * 2, 440.0).chunks(4096) {
            out.extend(stretch.process(chunk));
        }
        let left: Vec<f32> = out.iter().step_by(2).copied().skip(WINDOW).collect();
        let crossings = left
            .windows(2)
            .filter(|pair| pair[0] < 0.0 && pair[1] >= 0.0)
            .count();
        let seconds = left.len() as f32 / 44_100.0;
        let pitch = crossings as f32 / seconds;
        assert!((pitch - 440.0).abs() < 15.0, "pitch {pitch}");
        let peak = left
            .iter()
            .fold(0.0f32, |peak, value| peak.max(value.abs()));
        assert!((0.4..0.6).contains(&peak), "peak {peak}");
    }

    #[test]
    fn reset_drops_buffered_audio_but_keeps_the_rate() {
        let mut stretch = TimeStretch::new();
        stretch.set_rate(0.75);
        stretch.process(&tone(3000, 220.0));
        stretch.reset();
        assert_eq!(stretch.rate(), 0.75);
        assert!(stretch.process(&tone(100, 220.0)).is_empty());
    }
}
