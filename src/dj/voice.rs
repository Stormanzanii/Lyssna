//! Bounded local voice recognition. Audio is never uploaded or saved by SpotiFlex.
use anyhow::{Result, ensure};
use std::{
    collections::VecDeque,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
};

#[derive(Clone, Default)]
pub struct VoiceCapture(Arc<Mutex<State>>);

#[derive(Default)]
struct State {
    active: Option<(String, Arc<AtomicBool>)>,
    retired: VecDeque<String>,
}

impl State {
    fn retire(&mut self, id: String) {
        if !self.retired.contains(&id) {
            self.retired.push_back(id);
        }
        while self.retired.len() > 32 {
            self.retired.pop_front();
        }
    }
}

pub struct Capture {
    owner: VoiceCapture,
    id: String,
    cancelled: Arc<AtomicBool>,
}

/// UI meter data, without audio samples or recognized words.
#[derive(Clone, Copy, Default, serde::Serialize)]
pub struct Progress {
    pub level: u8,
    pub speech: bool,
    pub stage: Stage,
    pub percent: u8,
}

#[derive(Clone, Copy, Default, serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Stage {
    Preparing,
    #[default]
    Listening,
    Transcribing,
}

/// Run once during startup; the decoder cache also serves later voice requests.
pub fn warm_up(cancelled: &AtomicBool) -> Result<()> {
    #[cfg(windows)]
    {
        super::local_speech::prepare(cancelled, &mut |_| {})?;
    }
    #[cfg(not(windows))]
    {
        let _ = cancelled;
    }
    Ok(())
}

impl VoiceCapture {
    /// Reserve before scheduling work so cancellation also covers queued captures.
    pub fn reserve(&self, id: String) -> Result<Capture> {
        ensure!(valid_id(&id), "Invalid voice request ID");
        let mut state = self
            .0
            .lock()
            .map_err(|_| anyhow::anyhow!("Voice capture unavailable"))?;
        ensure!(!state.retired.contains(&id), "Voice capture cancelled");
        ensure!(state.active.is_none(), "DJ is already listening");
        let cancelled = Arc::new(AtomicBool::new(false));
        state.active = Some((id.clone(), cancelled.clone()));
        Ok(Capture {
            owner: self.clone(),
            id,
            cancelled,
        })
    }

    pub fn cancel(&self, id: &str) {
        if !valid_id(id) {
            return;
        }
        if let Ok(mut state) = self.0.lock() {
            if let Some((active, cancelled)) = &state.active
                && active == id
            {
                cancelled.store(true, Ordering::Release);
            }
            // A cancel command can arrive before its asynchronous start command.
            state.retire(id.into());
        }
    }

    pub fn cancel_all(&self) {
        if let Ok(mut state) = self.0.lock()
            && let Some((id, cancelled)) = &state.active
        {
            cancelled.store(true, Ordering::Release);
            let id = id.clone();
            state.retire(id);
        }
    }
}

impl Capture {
    /// Blocking: call on a worker. Return recognized words after speech ends.
    pub fn transcribe(self) -> Result<String> {
        self.transcribe_with_progress(|_| {})
    }

    pub fn transcribe_with_progress(self, report: impl FnMut(Progress)) -> Result<String> {
        ensure!(
            !self.cancelled.load(Ordering::Acquire),
            "Voice capture cancelled"
        );
        #[cfg(windows)]
        {
            let mut report = report;
            let model = super::local_speech::prepare(&self.cancelled, &mut report)?;
            let audio = super::microphone::capture(&self.cancelled, &mut report)?;
            super::local_speech::decode(&model, &audio, self.cancelled.clone(), &mut report)
        }
        #[cfg(not(windows))]
        {
            let _ = report;
            anyhow::bail!("Native voice input is available on Windows")
        }
    }
}

impl Drop for Capture {
    fn drop(&mut self) {
        self.cancelled.store(true, Ordering::Release);
        if let Ok(mut state) = self.owner.0.lock() {
            if state.active.as_ref().is_some_and(|(id, _)| *id == self.id) {
                state.active = None;
            }
            state.retire(self.id.clone());
        }
    }
}

fn valid_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 64
        && id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
}

#[cfg(all(windows, test))]
mod platform {
    use super::*;
    use windows::{
        Win32::{Media::Speech::*, System::Com::*},
        core::PCWSTR,
    };
    struct Apartment;
    impl Drop for Apartment {
        fn drop(&mut self) {
            unsafe {
                CoUninitialize();
            }
        }
    }
    fn read_pcm(path: &std::path::Path) -> Result<Vec<f32>> {
        let bytes = std::fs::read(path)?;
        let mut offset = 12;
        while offset + 8 <= bytes.len() {
            let length =
                u32::from_le_bytes(bytes[offset + 4..offset + 8].try_into().unwrap()) as usize;
            let start = offset + 8;
            let end = start + length;
            ensure!(end <= bytes.len(), "Incomplete speech fixture");
            if &bytes[offset..offset + 4] == b"data" {
                ensure!(length.is_multiple_of(2), "Invalid PCM fixture");
                return Ok(bytes[start..end]
                    .as_chunks::<2>()
                    .0
                    .iter()
                    .map(|bytes| f32::from(i16::from_le_bytes(*bytes)) / 32768.0)
                    .collect());
            }
            offset = end + (length % 2);
        }
        anyhow::bail!("Speech fixture has no audio")
    }
    pub(super) fn background_noise_check() -> Result<String> {
        let mut random = 0x45u32;
        let samples = (0..16_000 * 8)
            .map(|index| {
                random = random.wrapping_mul(1664525).wrapping_add(1013904223);
                let noise = (random >> 16) as i16 / 64;
                let hum =
                    (300.0 * (std::f32::consts::TAU * 110.0 * index as f32 / 16000.0).sin()) as i16;
                f32::from(noise.saturating_add(hum)) / 32768.0
            })
            .collect::<Vec<_>>();
        let audio = super::super::microphone::from_samples(&samples, 16_000)?;
        let cancelled = Arc::new(AtomicBool::new(false));
        let model = super::super::local_speech::prepare(&cancelled, &mut |_| {})?;
        super::super::local_speech::decode(&model, &audio, cancelled, &mut |_| {})
    }
    pub(super) fn synthetic_file_check() -> Result<String> {
        synthetic_request_check("Play some jazz music.")
    }
    #[cfg(test)]
    pub(super) fn synthetic_request_check(request: &str) -> Result<String> {
        use windows::{Win32::Media::Audio::WAVEFORMATEX, core::GUID};
        let path = std::path::Path::new("target/diagnostics/dj-voice-check.wav");
        std::fs::create_dir_all(path.parent().unwrap())?;
        {
            unsafe { CoInitializeEx(None, COINIT_MULTITHREADED).ok() }?;
            let _apartment = Apartment;
            let stream: ISpStream =
                unsafe { CoCreateInstance(&SpStream, None, CLSCTX_INPROC_SERVER) }?;
            let format_id = GUID::from_u128(0xc31adbae_527f_4ff5_a230_f62bb61ff70c);
            let format = WAVEFORMATEX {
                wFormatTag: 1,
                nChannels: 1,
                nSamplesPerSec: 16000,
                nAvgBytesPerSec: 32000,
                nBlockAlign: 2,
                wBitsPerSample: 16,
                cbSize: 0,
            };
            let encoded: Vec<u16> = path
                .as_os_str()
                .to_string_lossy()
                .encode_utf16()
                .chain(Some(0))
                .collect();
            unsafe {
                stream.BindToFile(
                    PCWSTR(encoded.as_ptr()),
                    SPFM_CREATE_ALWAYS,
                    Some(&format_id),
                    Some(&format),
                    0,
                )
            }?;
            let voice: ISpVoice =
                unsafe { CoCreateInstance(&SpVoice, None, CLSCTX_INPROC_SERVER) }?;
            unsafe {
                voice.SetOutput(&stream, false)?;
                let spoken: Vec<u16> = request.encode_utf16().chain(Some(0)).collect();
                voice.Speak(PCWSTR(spoken.as_ptr()), SPF_DEFAULT.0 as u32, None)?;
            }
            drop(voice);
            unsafe { stream.Close() }?;
        }
        let cancelled = Arc::new(AtomicBool::new(false));
        let model = super::super::local_speech::prepare(&cancelled, &mut |_| {})?;
        let audio = super::super::microphone::from_samples(&read_pcm(path)?, 16_000)?;
        super::super::local_speech::decode(&model, &audio, cancelled, &mut |_| {})
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    #[cfg(windows)]
    #[ignore = "Uses Windows speech synthesis, native speech detection and local decoding; no microphone or Spotify requests"]
    fn artist_requests_preserve_the_requested_artist() {
        for artist in [
            "Ariana Grande",
            "Billie Eilish",
            "Dua Lipa",
            "Taylor Swift",
            "Rammstein",
        ] {
            let recognized = platform::synthetic_request_check(&format!("Play {artist}."))
                .expect("Artist request rejected");
            let normalized = recognized.to_lowercase();
            assert!(
                normalized.contains(&artist.to_lowercase()),
                "Artist changed during recognition: {artist}: {recognized}"
            );
        }
    }

    #[test]
    #[cfg(windows)]
    #[ignore = "Uses Windows synthesis and local decoding only; no microphone"]
    fn clear_requests_beyond_the_original_fixture_are_not_rejected() {
        for request in [
            "Play some rock music.",
            "Play Rammstein.",
            "Give me something energetic.",
            "Surprise me.",
        ] {
            let result = platform::synthetic_request_check(request);
            assert!(
                result.is_ok(),
                "Clear synthesized request rejected: {request}: {result:?}"
            );
        }
    }

    #[test]
    #[cfg(windows)]
    #[ignore = "Runs PCM speech detection and local decoding, without Windows dictation"]
    fn rejected_windows_words_must_not_veto_local_recognition() {
        let text = platform::synthetic_request_check("Play Rammstein.").unwrap();
        assert!(
            text.to_lowercase().contains("rammstein"),
            "Local decoding changed artist: {text}"
        );
    }

    #[test]
    #[cfg(windows)]
    #[ignore = "Uses native voice activity detection on synthesized background noise, never the microphone"]
    fn background_noise_does_not_submit_or_keep_extending_capture() {
        let start = std::time::Instant::now();
        assert!(
            platform::background_noise_check().is_err(),
            "Ambient noise must not submit a request"
        );
        assert!(
            start.elapsed() < std::time::Duration::from_secs(12),
            "Background noise prolonged capture"
        );
    }

    #[test]
    #[cfg(windows)]
    #[ignore = "Uses Windows synthesis, native speech detection and local decoding, never the microphone"]
    fn windows_dictation_transcribes_a_synthetic_file_without_microphone_access() {
        let text = platform::synthetic_file_check().unwrap();
        assert!(
            text.to_ascii_lowercase().contains("jazz"),
            "Synthetic speech was not recognized"
        );
    }

    #[test]
    fn cancellation_before_start_never_opens_the_microphone() {
        let voice = VoiceCapture::default();
        voice.cancel("cancel-before-start");
        assert!(voice.reserve("cancel-before-start".into()).is_err());
        let capture = voice.reserve("queued-capture".into()).unwrap();
        voice.cancel("queued-capture");
        assert!(capture.transcribe().is_err());
    }

    #[test]
    fn cancelled_capture_keeps_its_reservation_until_the_worker_exits() {
        let voice = VoiceCapture::default();
        let capture = voice.reserve("first-capture".into()).unwrap();
        voice.cancel_all();
        assert!(voice.reserve("second-capture".into()).is_err());
        drop(capture);
        let second = voice.reserve("second-capture".into()).unwrap();
        voice.cancel("first-capture");
        assert!(!second.cancelled.load(Ordering::Acquire));
        drop(second);
        assert!(voice.reserve("second-capture".into()).is_err());
    }
}
