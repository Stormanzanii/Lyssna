//! Local decoding of bounded, in-memory microphone audio.
use super::voice::{Progress, Stage};
use anyhow::{Context, Result, ensure};
use sha2::{Digest, Sha256};
use std::{
    fs,
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::{
        Arc, Mutex, OnceLock,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};
use whisper_rs::{FullParams, SamplingStrategy, WhisperContext, WhisperContextParameters};

const MODEL_BYTES: u64 = 190_098_681;
const MODEL_HASH: &str = "bfdff4894dcb76bbf647d56263ea2a96645423f1669176f4844a1bf8e478ad30";
const MODEL_URL: &str = "https://huggingface.co/ggerganov/whisper.cpp/resolve/c521a4b02f422512d734391fdf08bb08c0862f68/ggml-small.en-q5_1.bin";
static MODEL: OnceLock<Mutex<Option<Arc<WhisperContext>>>> = OnceLock::new();

fn check(cancelled: &AtomicBool) -> Result<()> {
    ensure!(
        !cancelled.load(Ordering::Acquire),
        "Voice capture cancelled"
    );
    Ok(())
}
fn valid(path: &Path) -> bool {
    let Ok(mut file) = fs::File::open(path) else {
        return false;
    };
    if !file.metadata().is_ok_and(|m| m.len() == MODEL_BYTES) {
        return false;
    }
    let mut hash = Sha256::new();
    let mut bytes = [0u8; 65_536];
    loop {
        match file.read(&mut bytes) {
            Ok(0) => break,
            Ok(length) => hash.update(&bytes[..length]),
            Err(_) => return false,
        }
    }
    format!("{:x}", hash.finalize()) == MODEL_HASH
}
fn allowed_download(url: &url::Url) -> bool {
    url.scheme() == "https"
        && url.username().is_empty()
        && url.password().is_none()
        && url.port_or_known_default() == Some(443)
        && url.host_str().is_some_and(|host| {
            host == "huggingface.co"
                || host.ends_with(".huggingface.co")
                || host.ends_with(".hf.co")
        })
}
struct Partial(PathBuf);
impl Drop for Partial {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.0);
    }
}

fn path(cancelled: &AtomicBool, report: &mut impl FnMut(Progress)) -> Result<PathBuf> {
    let directory = crate::config::data_dir()?.join("speech");
    let path = directory.join("ggml-small.en-q5_1.bin");
    if valid(&path) {
        return Ok(path);
    }
    fs::create_dir_all(&directory)?;
    let mut random = [0u8; 8];
    getrandom::fill(&mut random).map_err(|_| anyhow::anyhow!("Speech model setup unavailable"))?;
    let suffix = random
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect::<String>();
    let partial = Partial(directory.join(format!("model-{suffix}.part")));
    let mut output = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&partial.0)?;
    let client = reqwest::blocking::Client::builder()
        .https_only(true)
        .connect_timeout(Duration::from_secs(15))
        .timeout(Duration::from_secs(180))
        .redirect(reqwest::redirect::Policy::custom(|attempt| {
            if attempt.previous().len() < 5 && allowed_download(attempt.url()) {
                attempt.follow()
            } else {
                attempt.stop()
            }
        }))
        .build()?;
    check(cancelled)?;
    // This public model download never uses Spotify credentials or microphone data.
    let mut response = client
        .get(MODEL_URL)
        .send()
        .map_err(|_| anyhow::anyhow!("Speech model download failed. Try again"))?;
    ensure!(
        response.status().is_success(),
        "Speech model download unavailable"
    );
    ensure!(
        response.content_length().is_none_or(|n| n == MODEL_BYTES),
        "Unexpected speech model size"
    );
    let mut total = 0u64;
    let mut previous = 101;
    let mut buffer = [0u8; 65_536];
    loop {
        check(cancelled)?;
        let length = response
            .read(&mut buffer)
            .map_err(|_| anyhow::anyhow!("Speech model download interrupted. Try again"))?;
        if length == 0 {
            break;
        }
        total += length as u64;
        ensure!(total <= MODEL_BYTES, "Speech model download too large");
        output.write_all(&buffer[..length])?;
        let percent = (total * 100 / MODEL_BYTES) as u8;
        if percent != previous {
            report(Progress {
                stage: Stage::Preparing,
                percent,
                ..Default::default()
            });
            previous = percent;
        }
    }
    output.sync_all()?;
    drop(output);
    check(cancelled)?;
    ensure!(valid(&partial.0), "Speech model verification failed");
    fs::rename(&partial.0, &path)?;
    Ok(path)
}

pub(super) fn prepare(
    cancelled: &AtomicBool,
    report: &mut impl FnMut(Progress),
) -> Result<Arc<WhisperContext>> {
    whisper_rs::install_logging_hooks();
    let mut cache = MODEL
        .get_or_init(Default::default)
        .lock()
        .map_err(|_| anyhow::anyhow!("Speech recognition unavailable"))?;
    check(cancelled)?;
    if let Some(model) = cache.as_ref() {
        return Ok(model.clone());
    }
    report(Progress {
        stage: Stage::Preparing,
        ..Default::default()
    });
    let path = path(cancelled, report)?;
    let mut parameters = WhisperContextParameters::default();
    parameters.use_gpu(false);
    let model = Arc::new(
        WhisperContext::new_with_params(&path, parameters)
            .context("Local speech model could not load")?,
    );
    check(cancelled)?;
    *cache = Some(model.clone());
    Ok(model)
}

pub(super) fn decode(
    model: &WhisperContext,
    samples: &[f32],
    cancelled: Arc<AtomicBool>,
    report: &mut impl FnMut(Progress),
) -> Result<String> {
    check(&cancelled)?;
    ensure!(
        !samples.is_empty() && samples.len() <= 16_000 * 30,
        "No usable speech captured"
    );
    report(Progress {
        stage: Stage::Transcribing,
        ..Default::default()
    });
    let mut parameters = FullParams::new(SamplingStrategy::BeamSearch {
        beam_size: 5,
        patience: -1.0,
    });
    parameters.set_n_threads(
        std::thread::available_parallelism()
            .map(|n| n.get().clamp(1, 6) as i32)
            .unwrap_or(2),
    );
    parameters.set_language(Some("en"));
    parameters.set_no_context(true);
    parameters.set_print_special(false);
    parameters.set_print_progress(false);
    parameters.set_print_realtime(false);
    parameters.set_print_timestamps(false);
    unsafe extern "C" fn abort(data: *mut std::ffi::c_void) -> bool {
        !data.is_null() && unsafe { (&*data.cast::<AtomicBool>()).load(Ordering::Acquire) }
    }
    // `cancelled` stays alive throughout the synchronous decoding call below.
    unsafe {
        parameters.set_abort_callback(Some(abort));
        parameters.set_abort_callback_user_data(Arc::as_ptr(&cancelled).cast_mut().cast());
    }
    let mut state = model
        .create_state()
        .context("Speech recognition could not start")?;
    // Give short utterances context at both boundaries without clipping consonants.
    let mut padded = vec![0.0; 8_000];
    padded.extend_from_slice(samples);
    padded.resize(padded.len() + 8_000, 0.0);
    state
        .full(parameters, &padded)
        .context("Speech recognition did not complete")?;
    check(&cancelled)?;
    let mut text = String::new();
    for segment in state.as_iter() {
        if segment.no_speech_probability() > 0.6 {
            continue;
        }
        let words = segment.to_str().context("Invalid speech result")?.trim();
        if !words.is_empty() {
            if !text.is_empty() {
                text.push(' ');
            }
            text.push_str(words);
        }
    }
    ensure!(!text.is_empty(), "No clear speech recognized. Try again");
    super::Prompt::new(&text, super::PromptInput::Voice)?;
    Ok(text)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn model_downloads_stay_on_trusted_https_hosts() {
        for value in [
            "https://huggingface.co/models",
            "https://cas-bridge.xethub.hf.co/file",
        ] {
            assert!(allowed_download(&url::Url::parse(value).unwrap()));
        }
        for value in [
            "http://huggingface.co/models",
            "https://huggingface.co.evil.example/file",
            "https://user@huggingface.co/file",
            "https://huggingface.co:444/file",
        ] {
            assert!(!allowed_download(&url::Url::parse(value).unwrap()));
        }
    }
    #[test]
    fn corrupt_or_missing_models_are_never_loaded() {
        assert!(!valid(Path::new(
            "target/diagnostics/does-not-exist-model.bin"
        )));
    }

    #[test]
    fn cancelled_preparation_does_not_load_or_download_a_model() {
        let cancelled = AtomicBool::new(true);
        let mut progress = Vec::new();
        assert!(prepare(&cancelled, &mut |event| progress.push(event)).is_err());
        assert!(progress.is_empty());
    }

    #[test]
    #[ignore = "Loads the cached local model; no microphone"]
    fn startup_warmup_and_voice_requests_share_one_model() {
        let cancelled = AtomicBool::new(false);
        super::super::voice::warm_up(&cancelled).unwrap();
        let first = prepare(&cancelled, &mut |_| {}).unwrap();
        let second = prepare(&cancelled, &mut |_| {}).unwrap();
        assert!(Arc::ptr_eq(&first, &second));
    }

    #[test]
    #[ignore = "Uses the local speech model, synthesized samples only; no microphone"]
    fn cancellation_during_decoding_cannot_return_a_prompt() {
        let cancelled = Arc::new(AtomicBool::new(false));
        let model = prepare(&cancelled, &mut |_| {}).unwrap();
        let samples = vec![0.01; 16_000 * 5];
        let flag = cancelled.clone();
        let cancel = std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(50));
            flag.store(true, Ordering::Release);
        });
        assert!(decode(&model, &samples, cancelled, &mut |_| {}).is_err());
        cancel.join().unwrap();
    }
}
