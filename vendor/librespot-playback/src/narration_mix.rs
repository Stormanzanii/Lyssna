//! Bounded PCM overlap at DJ speech/music boundaries. Music positions stay musical.
use crate::{
    SAMPLE_RATE,
    decoder::{AudioDecoder, AudioPacket, AudioPacketPosition, DecoderError, DecoderResult},
};
use std::collections::VecDeque;

struct Frame {
    samples: [f64; 2],
    position: AudioPacketPosition,
    narration: bool,
}
pub(crate) struct SmoothDJ {
    decoder: Box<dyn AudioDecoder + Send>,
    input: VecDeque<Frame>,
    tail: VecDeque<Frame>,
    ready: VecDeque<Frame>,
    fade: usize,
    music_ramp: usize,
    ended: bool,
}
impl SmoothDJ {
    pub(crate) fn new(decoder: Box<dyn AudioDecoder + Send>) -> Self {
        Self {
            decoder,
            input: VecDeque::new(),
            tail: VecDeque::new(),
            ready: VecDeque::new(),
            fade: SAMPLE_RATE as usize * 2,
            music_ramp: 0,
            ended: false,
        }
    }
    fn read_frame(&mut self) -> DecoderResult<Option<Frame>> {
        loop {
            if let Some(mut frame) = self.input.pop_front() {
                if !frame.narration && self.music_ramp > 0 {
                    let gain = 0.18 + 0.82 * (1.0 - self.music_ramp as f64 / self.fade as f64);
                    frame.samples.iter_mut().for_each(|sample| *sample *= gain);
                    self.music_ramp -= 1;
                }
                return Ok(Some(frame));
            }
            let Some((position, packet)) = self.decoder.next_packet()? else {
                return Ok(None);
            };
            let narration = packet.is_narration();
            let samples = match packet {
                AudioPacket::Samples(samples) | AudioPacket::Narration(samples) => samples,
                AudioPacket::Raw(_) => {
                    return Err(DecoderError::SymphoniaDecoder(
                        "DJ transitions require decoded stereo samples".into(),
                    ));
                }
            };
            for (index, pair) in samples.chunks_exact(2).enumerate() {
                let mut at = position.clone();
                if !narration {
                    at.position_ms = at
                        .position_ms
                        .saturating_add((index as u64 * 1000 / u64::from(SAMPLE_RATE)) as u32);
                }
                at.skipped &= index == 0;
                self.input.push_back(Frame {
                    samples: [pair[0], pair[1]],
                    position: at,
                    narration,
                });
            }
        }
    }
    fn overlap(&mut self, first: Frame) -> DecoderResult<()> {
        let kind = first.narration;
        let mut incoming = VecDeque::from([first]);
        while incoming.len() < self.tail.len() {
            let Some(frame) = self.read_frame()? else {
                break;
            };
            if frame.narration != kind {
                self.input.push_front(frame);
                break;
            }
            incoming.push_back(frame);
        }
        let count = self.tail.len().min(incoming.len());
        while self.tail.len() > count {
            self.ready.push_back(self.tail.pop_front().unwrap());
        }
        for index in 0..count {
            let old = self.tail.pop_front().unwrap();
            let new = incoming.pop_front().unwrap();
            let blend = if count > 1 {
                index as f64 / (count - 1) as f64
            } else {
                0.5
            };
            // Duck music under words; fading speech to zero loses the last syllables.
            let music_gain = if old.narration {
                0.18 * blend
            } else {
                let attack = (index as f64
                    / ((SAMPLE_RATE as usize / 50)
                        .min(count.saturating_sub(1))
                        .max(1)) as f64)
                    .min(1.0);
                (1.0 - blend) * (1.0 - 0.82 * attack)
            };
            let (voice, music) = if old.narration {
                (&old, &new)
            } else {
                (&new, &old)
            };
            let samples = std::array::from_fn(|channel| {
                voice.samples[channel] * (1.0 - music_gain) + music.samples[channel] * music_gain
            });
            let position = if old.narration {
                new.position
            } else {
                old.position
            };
            self.ready.push_back(Frame {
                samples,
                position,
                narration: true,
            });
        }
        if !kind {
            self.music_ramp = self.fade;
        }
        self.tail.append(&mut incoming);
        Ok(())
    }
    fn fill_ready(&mut self) -> DecoderResult<()> {
        while self.ready.is_empty() && !self.ended {
            let Some(frame) = self.read_frame()? else {
                self.ended = true;
                self.ready.append(&mut self.tail);
                break;
            };
            if self
                .tail
                .back()
                .is_some_and(|old| old.narration != frame.narration)
            {
                self.overlap(frame)?;
            } else {
                self.tail.push_back(frame);
                if self.tail.len() > self.fade {
                    self.ready.push_back(self.tail.pop_front().unwrap());
                }
            }
        }
        Ok(())
    }
}
impl AudioDecoder for SmoothDJ {
    fn seek(&mut self, position_ms: u32) -> Result<u32, DecoderError> {
        let actual = self.decoder.seek(position_ms)?;
        self.input.clear();
        self.tail.clear();
        self.ready.clear();
        self.ended = false;
        self.music_ramp = 0;
        Ok(actual)
    }
    fn next_packet(&mut self) -> DecoderResult<Option<(AudioPacketPosition, AudioPacket)>> {
        self.fill_ready()?;
        let Some(first) = self.ready.pop_front() else {
            return Ok(None);
        };
        let kind = first.narration;
        let position = first.position;
        let mut samples = Vec::with_capacity(2048);
        samples.extend(first.samples);
        while samples.len() < 2048 {
            self.fill_ready()?;
            if self
                .ready
                .front()
                .is_none_or(|frame| frame.narration != kind)
            {
                break;
            }
            samples.extend(self.ready.pop_front().unwrap().samples);
        }
        Ok(Some((
            position,
            if kind {
                AudioPacket::Narration(samples)
            } else {
                AudioPacket::Samples(samples)
            },
        )))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn final_spoken_syllables_remain_audible_during_music_fade() {
        let mut decoder = decoder(vec![packet(true, 1.0, 8, 0), packet(false, 0.0, 12, 0)]);
        let result = drain(&mut decoder);
        assert!(
            result[4..8].iter().all(|frame| frame.0 && frame.1 >= 0.8),
            "Music fade must not erase the end of the spoken line"
        );
    }
    struct Audio {
        packets: VecDeque<(AudioPacketPosition, AudioPacket)>,
    }
    impl AudioDecoder for Audio {
        fn seek(&mut self, _: u32) -> Result<u32, DecoderError> {
            self.packets = VecDeque::from([packet(false, 0.8, 12, 100)]);
            Ok(100)
        }
        fn next_packet(&mut self) -> DecoderResult<Option<(AudioPacketPosition, AudioPacket)>> {
            Ok(self.packets.pop_front())
        }
    }
    fn packet(
        speech: bool,
        value: f64,
        frames: usize,
        position: u32,
    ) -> (AudioPacketPosition, AudioPacket) {
        (
            AudioPacketPosition {
                position_ms: position,
                skipped: false,
            },
            if speech {
                AudioPacket::Narration(vec![value; frames * 2])
            } else {
                AudioPacket::Samples(vec![value; frames * 2])
            },
        )
    }
    fn decoder(packets: Vec<(AudioPacketPosition, AudioPacket)>) -> SmoothDJ {
        let mut decoder = SmoothDJ::new(Box::new(Audio {
            packets: packets.into(),
        }));
        decoder.fade = 4;
        decoder
    }
    fn drain(decoder: &mut SmoothDJ) -> Vec<(bool, f64)> {
        let mut result = vec![];
        while let Some((_, packet)) = decoder.next_packet().unwrap() {
            for pair in packet.samples().unwrap().chunks_exact(2) {
                assert_eq!(pair[0], pair[1]);
                result.push((packet.is_narration(), pair[0]));
            }
        }
        result
    }
    #[test]
    fn music_fades_in_under_the_end_of_speech() {
        let mut decoder = decoder(vec![packet(true, 0.2, 8, 0), packet(false, 0.8, 12, 0)]);
        let result = drain(&mut decoder);
        assert_eq!(result.len(), 16);
        let overlap = &result[4..8];
        assert!(overlap.iter().all(|frame| frame.0));
        assert!(overlap.windows(2).all(|pair| pair[0].1 < pair[1].1));
        assert_eq!(result.last(), Some(&(false, 0.8)));
    }
    #[test]
    fn music_fades_out_as_speech_starts_without_clipping() {
        let mut decoder = decoder(vec![packet(false, 0.8, 12, 0), packet(true, 0.2, 8, 1)]);
        let result = drain(&mut decoder);
        assert_eq!(result.len(), 16);
        assert!(result[8..12].iter().all(|frame| frame.0));
        assert!(result[8..12].windows(2).all(|pair| pair[0].1 > pair[1].1));
        assert!(result.iter().all(|frame| (0.2..=0.8).contains(&frame.1)));
    }
    #[test]
    fn seek_discards_buffered_speech_and_overlap() {
        let mut decoder = decoder(vec![packet(true, 0.2, 8, 0), packet(false, 0.8, 12, 0)]);
        decoder.fill_ready().unwrap();
        decoder.seek(100).unwrap();
        assert!(
            drain(&mut decoder)
                .iter()
                .all(|frame| !frame.0 && frame.1 == 0.8)
        );
    }
    #[test]
    fn music_without_speech_remains_unchanged() {
        let mut decoder = decoder(vec![packet(false, 0.8, 12, 0)]);
        assert_eq!(drain(&mut decoder), vec![(false, 0.8); 12]);
    }
}
