//! Bounded native dictation. Audio is never uploaded or saved by SpotiFlex.
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
#[derive(Clone, Copy, serde::Serialize)]
pub struct Progress {
    pub level: u8,
    pub speech: bool,
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
            platform::recognize(&self.cancelled, None, report)
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

/// Only recognized speech extends the endpoint, never raw background sound.
#[derive(Default)]
#[cfg(any(windows, test))]
struct Utterance {
    text: String,
    hypothesis: String,
    last_activity: Option<std::time::Instant>,
}
#[cfg(any(windows, test))]
impl Utterance {
    fn hypothesis(&mut self, text: &str, now: std::time::Instant) {
        let text = text.trim();
        if !text.is_empty() && text != self.hypothesis {
            self.hypothesis = text.into();
            self.last_activity = Some(now);
        }
    }
    fn recognize(&mut self, text: &str, now: std::time::Instant) {
        let text = text.trim();
        if text.is_empty() {
            return;
        }
        if !self.text.is_empty() {
            self.text.push(' ');
        }
        self.text.push_str(text);
        self.hypothesis.clear();
        self.last_activity = Some(now);
    }
    fn ready(&self, now: std::time::Instant) -> bool {
        !self.text.is_empty()
            && self.last_activity.is_some_and(|last| {
                now.saturating_duration_since(last) >= std::time::Duration::from_millis(1200)
            })
    }
}

#[cfg(any(windows, test))]
fn credible_speech(category: i8, engine_confidence: f32, has_confident_word: bool) -> bool {
    // A clear word can support a request containing unfamiliar artist names.
    // Keep the phrase score as a fallback, not a probability estimate.
    // Engine scores are implementation-specific: https://learn.microsoft.com/en-us/previous-versions/windows/desktop/ee125128(v=vs.85)
    category >= 0
        && engine_confidence.is_finite()
        && (engine_confidence >= 0.65 || has_confident_word)
}

#[cfg(windows)]
mod platform {
    use super::*;
    use anyhow::Context;
    use std::{
        mem::ManuallyDrop,
        time::{Duration, Instant},
    };
    use windows::{
        Win32::{Media::Speech::*, System::Com::*},
        core::{IUnknown, Interface, PCWSTR, PWSTR},
    };

    struct Apartment;
    impl Drop for Apartment {
        fn drop(&mut self) {
            unsafe {
                CoUninitialize();
            }
        }
    }
    struct Recognizer(ISpRecognizer);
    impl Drop for Recognizer {
        fn drop(&mut self) {
            let _ = unsafe { self.0.SetRecoState(SPRST_INACTIVE_WITH_PURGE) };
        }
    }
    struct Phrase(*mut SPPHRASE);
    impl Drop for Phrase {
        fn drop(&mut self) {
            unsafe {
                CoTaskMemFree(Some(self.0.cast()));
            }
        }
    }
    struct Text(PWSTR);
    impl Drop for Text {
        fn drop(&mut self) {
            unsafe {
                CoTaskMemFree(Some(self.0.0.cast()));
            }
        }
    }
    struct Event(SPEVENT);
    impl Drop for Event {
        fn drop(&mut self) {
            let pointer = self.0.lParam.0 as *mut std::ffi::c_void;
            if pointer.is_null() {
                return;
            }
            // SAPI transfers ownership of queued event payloads to the caller.
            let kind = (self.0._bitfield >> 16) & 0xffff;
            unsafe {
                if kind == SPET_LPARAM_IS_OBJECT.0 || kind == SPET_LPARAM_IS_TOKEN.0 {
                    drop(IUnknown::from_raw(pointer));
                } else if kind == SPET_LPARAM_IS_STRING.0 || kind == SPET_LPARAM_IS_POINTER.0 {
                    CoTaskMemFree(Some(pointer));
                }
            }
        }
    }

    pub(super) fn recognize(
        cancelled: &AtomicBool,
        file: Option<&std::path::Path>,
        mut report: impl FnMut(Progress),
    ) -> Result<String> {
        unsafe { CoInitializeEx(None, COINIT_MULTITHREADED).ok() }
            .context("Windows speech recognition could not start")?;
        let _apartment = Apartment;
        let recognizer = Recognizer(
            unsafe { CoCreateInstance(&SpInprocRecognizer, None, CLSCTX_INPROC_SERVER) }
                .context("Install a Windows speech recognition language to use voice input")?,
        );
        if let Some(file) = file {
            let stream: ISpStream =
                unsafe { CoCreateInstance(&SpStream, None, CLSCTX_INPROC_SERVER) }?;
            let path: Vec<u16> = file
                .as_os_str()
                .to_string_lossy()
                .encode_utf16()
                .chain(Some(0))
                .collect();
            unsafe {
                stream.BindToFile(PCWSTR(path.as_ptr()), SPFM_OPEN_READONLY, None, None, 0)?;
                recognizer.0.SetInput(&stream, true)?;
            }
        } else {
            let input: ISpAudio =
                unsafe { CoCreateInstance(&SpMMAudioIn, None, CLSCTX_INPROC_SERVER) }
                    .context("Microphone unavailable. Check Windows microphone permissions")?;
            unsafe { recognizer.0.SetInput(&input, true) }
                .context("Microphone unavailable. Check Windows microphone permissions")?;
        }
        let context = unsafe { recognizer.0.CreateRecoContext() }?;
        let grammar = unsafe { context.CreateGrammar(1) }?;
        unsafe {
            // SPFEI includes these two validation bits in every event mask.
            let interest = (1_u64 << SPEI_RESERVED1.0)
                | (1_u64 << SPEI_RESERVED2.0)
                | (1_u64 << SPEI_HYPOTHESIS.0)
                | (1_u64 << SPEI_SR_AUDIO_LEVEL.0)
                | (1_u64 << SPEI_RECOGNITION.0)
                | (1_u64 << SPEI_FALSE_RECOGNITION.0);
            context.SetInterest(interest, interest)?;
            context.SetNotifyWin32Event()?;
            grammar
                .LoadDictation(PCWSTR::null(), SPLO_STATIC)
                .context("Windows dictation language unavailable")?;
        }
        ensure!(
            !cancelled.load(Ordering::Acquire),
            "Voice capture cancelled"
        );
        unsafe { grammar.SetDictationState(SPRS_ACTIVE) }
            .context("Microphone unavailable. Check Windows microphone permissions")?;
        let started = Instant::now();
        let deadline = started + Duration::from_secs(30);
        let mut utterance = Utterance::default();
        let mut level = 0;
        let mut received_audio = false;
        let mut rejected_speech = false;
        report(Progress {
            level: 0,
            speech: false,
        });
        while Instant::now() < deadline {
            ensure!(
                !cancelled.load(Ordering::Acquire),
                "Voice capture cancelled"
            );
            for _ in 0..64 {
                let mut event = Event(SPEVENT::default());
                let mut fetched = 0;
                unsafe { context.GetEvents(1, &mut event.0, &mut fetched) }?;
                if fetched == 0 {
                    break;
                }
                if fetched > 0 {
                    let event_id = event.0._bitfield & 0xffff;
                    if event_id == SPEI_SR_AUDIO_LEVEL.0 {
                        level = event.0.wParam.0.min(100) as u8;
                        received_audio |= level > 0;
                    }
                    let kind = (event.0._bitfield >> 16) & 0xffff;
                    if matches!(event_id, id if id==SPEI_RECOGNITION.0 || id==SPEI_HYPOTHESIS.0)
                        && kind == SPET_LPARAM_IS_OBJECT.0
                        && event.0.lParam.0 != 0
                    {
                        let object = ManuallyDrop::new(unsafe {
                            IUnknown::from_raw(event.0.lParam.0 as *mut _)
                        });
                        let result: ISpRecoResult = object.cast()?;
                        let mut text = Text(PWSTR::null());
                        unsafe { result.GetText(0, u32::MAX, true, &mut text.0, None) }?;
                        let text = unsafe { text.0.to_string() }
                            .context("Windows returned invalid speech text")?;
                        ensure!(
                            !cancelled.load(Ordering::Acquire),
                            "Voice capture cancelled"
                        );
                        let phrase = Phrase(unsafe { result.GetPhrase() }?);
                        if !phrase.0.is_null()
                            && unsafe {
                                credible_speech(
                                    (*phrase.0).Base.Rule.Confidence,
                                    (*phrase.0).Base.Rule.SREngineConfidence,
                                    {
                                        let phrase = &(*phrase.0).Base;
                                        !phrase.pElements.is_null()
                                            && phrase.Rule.ulFirstElement == 0
                                            && phrase.Rule.ulCountOfElements <= 512
                                            && (0..phrase.Rule.ulCountOfElements).any(|index| {
                                                (*phrase.pElements.add(index as usize))
                                                    .ActualConfidence
                                                    >= 1 // SAPI high confidence
                                            })
                                    },
                                )
                            }
                        {
                            if event_id == SPEI_RECOGNITION.0 {
                                utterance.recognize(&text, Instant::now());
                            } else {
                                utterance.hypothesis(&text, Instant::now());
                            }
                        } else if !text.trim().is_empty() {
                            rejected_speech = true;
                        }
                    }
                }
            }
            report(Progress {
                level,
                speech: !utterance.text.is_empty(),
            });
            // Ambient sound events never extend this speech-only deadline.
            if utterance.ready(Instant::now()) {
                return Ok(utterance.text);
            }
            if utterance.text.is_empty()
                && started.elapsed() >= Duration::from_secs(8)
                && utterance
                    .last_activity
                    .is_none_or(|last| last.elapsed() >= Duration::from_millis(1200))
            {
                if rejected_speech {
                    anyhow::bail!(
                        "Sound received, but speech was not recognized reliably. Check your Windows speech language and try again"
                    );
                }
                if received_audio {
                    anyhow::bail!(
                        "Microphone input received, but no clear speech recognized. Try again or type your request"
                    );
                }
                anyhow::bail!(
                    "No microphone input detected. Check your Windows input device and microphone volume"
                );
            }
            std::thread::sleep(Duration::from_millis(50));
        }
        ensure!(
            !cancelled.load(Ordering::Acquire),
            "Voice capture cancelled"
        );
        if utterance.text.is_empty() {
            anyhow::bail!("No speech detected. Try again or type your request")
        }
        Ok(utterance.text)
    }

    #[cfg(test)]
    pub(super) fn background_noise_check() -> Result<String> {
        let path = std::path::Path::new("target/diagnostics/dj-background-noise.wav");
        std::fs::create_dir_all(path.parent().unwrap())?;
        let samples = 16000 * 8;
        let length = (samples * 2) as u32;
        let mut bytes = b"RIFF".to_vec();
        bytes.extend_from_slice(&(36 + length).to_le_bytes());
        bytes.extend_from_slice(b"WAVEfmt ");
        bytes.extend_from_slice(&16u32.to_le_bytes());
        bytes.extend_from_slice(&1u16.to_le_bytes());
        bytes.extend_from_slice(&1u16.to_le_bytes());
        bytes.extend_from_slice(&16000u32.to_le_bytes());
        bytes.extend_from_slice(&32000u32.to_le_bytes());
        bytes.extend_from_slice(&2u16.to_le_bytes());
        bytes.extend_from_slice(&16u16.to_le_bytes());
        bytes.extend_from_slice(b"data");
        bytes.extend_from_slice(&length.to_le_bytes());
        let mut random = 0x45u32;
        for index in 0..samples {
            random = random.wrapping_mul(1664525).wrapping_add(1013904223);
            let noise = (random >> 16) as i16 / 64;
            let hum =
                (300.0 * (std::f32::consts::TAU * 110.0 * index as f32 / 16000.0).sin()) as i16;
            bytes.extend_from_slice(&noise.saturating_add(hum).to_le_bytes());
        }
        std::fs::write(path, bytes)?;
        recognize(&AtomicBool::new(false), Some(path), |_| {})
    }

    #[cfg(test)]
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
        recognize(&AtomicBool::new(false), Some(path), |_| {})
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    #[cfg(windows)]
    #[ignore = "Uses Windows speech synthesis and dictation only; no microphone"]
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
    fn uncertain_or_invalid_recognition_cannot_submit_or_extend_listening() {
        for confidence in [0.0, 0.41, 0.64, f32::NAN, f32::INFINITY] {
            assert!(!credible_speech(0, confidence, false));
        }
        assert!(!credible_speech(-1, 0.95, true));
        assert!(credible_speech(0, 0.81, false));
        assert!(
            credible_speech(0, 0.29, true),
            "Confident words must survive uncertain artist names"
        );
        assert!(!credible_speech(0, f32::NAN, true));
    }

    #[test]
    #[cfg(windows)]
    #[ignore = "Uses installed Windows dictation with a deterministic ambient-noise WAV, never the microphone"]
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
    fn speech_endpoint_joins_phrases_and_sends_after_quiet() {
        let now = std::time::Instant::now();
        let mut utterance = Utterance::default();
        utterance.recognize("Play", now);
        utterance.hypothesis("acoustic", now + std::time::Duration::from_millis(800));
        assert!(!utterance.ready(now + std::time::Duration::from_millis(1300)));
        utterance.recognize(
            "acoustic folk",
            now + std::time::Duration::from_millis(1400),
        );
        assert!(!utterance.ready(now + std::time::Duration::from_millis(2599)));
        assert!(utterance.ready(now + std::time::Duration::from_millis(2600)));
        assert_eq!(utterance.text, "Play acoustic folk");
    }

    #[test]
    fn empty_noise_and_repeated_hypotheses_cannot_keep_listening_alive() {
        let now = std::time::Instant::now();
        let mut utterance = Utterance::default();
        for index in 0..100 {
            utterance.hypothesis("", now + std::time::Duration::from_millis(index));
        }
        assert!(utterance.last_activity.is_none());
        assert!(!utterance.ready(now + std::time::Duration::from_secs(30)));
        utterance.recognize("Play rock", now);
        utterance.hypothesis("and", now);
        for index in 1..12 {
            utterance.hypothesis("and", now + std::time::Duration::from_millis(index * 100));
        }
        assert!(utterance.ready(now + std::time::Duration::from_millis(1200)));
    }

    #[test]
    #[cfg(windows)]
    #[ignore = "Uses installed Windows dictation and a synthetic WAV, never the microphone"]
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
