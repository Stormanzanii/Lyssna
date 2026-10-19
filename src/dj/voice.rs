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
    /// Blocking: call on a worker. A transcript is returned for review, not sent.
    pub fn transcribe(self) -> Result<String> {
        ensure!(
            !self.cancelled.load(Ordering::Acquire),
            "Voice capture cancelled"
        );
        #[cfg(windows)]
        {
            platform::recognize(&self.cancelled, None)
        }
        #[cfg(not(windows))]
        {
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
        unsafe { grammar.SetDictationState(SPRS_ACTIVE_WITH_AUTO_PAUSE) }
            .context("Microphone unavailable. Check Windows microphone permissions")?;
        let deadline = Instant::now() + Duration::from_secs(30);
        while Instant::now() < deadline {
            ensure!(
                !cancelled.load(Ordering::Acquire),
                "Voice capture cancelled"
            );
            let mut event = Event(SPEVENT::default());
            let mut fetched = 0;
            unsafe { context.GetEvents(1, &mut event.0, &mut fetched) }?;
            if fetched > 0 {
                ensure!(
                    event.0._bitfield & 0xffff != SPEI_FALSE_RECOGNITION.0,
                    "Speech was unclear. Try again or type your request"
                );
                let kind = (event.0._bitfield >> 16) & 0xffff;
                if event.0._bitfield & 0xffff == SPEI_RECOGNITION.0
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
                    if !text.trim().is_empty() {
                        return Ok(text);
                    }
                }
            }
            std::thread::sleep(Duration::from_millis(50));
        }
        anyhow::bail!("No speech detected. Try again or type your request")
    }

    #[cfg(test)]
    pub(super) fn synthetic_file_check() -> Result<String> {
        use windows::{
            Win32::Media::Audio::WAVEFORMATEX,
            core::{GUID, w},
        };
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
                voice.Speak(w!("Play some jazz music."), SPF_DEFAULT.0 as u32, None)?;
            }
            drop(voice);
            unsafe { stream.Close() }?;
        }
        recognize(&AtomicBool::new(false), Some(path))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

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
