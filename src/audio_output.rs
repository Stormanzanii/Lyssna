use librespot_playback::audio_backend::{SinkError, SinkResult};
use rodio::{
    OutputStream, OutputStreamBuilder,
    cpal::{
        self,
        traits::{DeviceTrait, HostTrait},
    },
};
use std::sync::{Arc, Mutex};

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub(crate) enum OutputIssue {
    UsingDefault,
    Unavailable,
}

#[derive(Default)]
struct Selection {
    name: Option<String>,
    revision: u64,
    issue: Option<OutputIssue>,
    reported: Option<u64>,
}

#[derive(Clone, Default)]
pub(crate) struct OutputChoice(Arc<Mutex<Selection>>);

pub(crate) fn valid_name(name: &str) -> bool {
    !name.is_empty() && name.len() <= 512 && !name.chars().any(char::is_control)
}

#[cfg(any(feature = "desktop", test))]
pub(crate) fn devices() -> anyhow::Result<Vec<String>> {
    let mut names: Vec<_> = cpal::default_host()
        .output_devices()
        .map_err(|_| anyhow::anyhow!("Cannot list audio outputs"))?
        .filter_map(|device| device.name().ok())
        .filter(|name| valid_name(name))
        .collect();
    names.sort_by_key(|name| name.to_lowercase());
    names.dedup();
    Ok(names)
}

impl OutputChoice {
    pub fn request(&self, name: Option<String>) {
        if let Ok(mut selection) = self.0.lock()
            && selection.name != name
        {
            selection.name = name;
            selection.revision = selection.revision.wrapping_add(1);
            selection.issue = None;
            selection.reported = None;
        }
    }
    #[cfg(test)]
    pub fn revision(&self) -> u64 {
        self.0.lock().map_or(0, |selection| selection.revision)
    }
    pub fn take_issue(&self) -> Option<OutputIssue> {
        self.0.lock().ok()?.issue.take()
    }
    pub fn retire_stream(&self) {
        if let Ok(mut selection) = self.0.lock() {
            selection.revision = selection.revision.wrapping_add(1);
            selection.issue = None;
            selection.reported = None;
        }
    }
    fn report(&self, revision: u64, issue: OutputIssue) {
        if let Ok(mut selection) = self.0.lock()
            && selection.revision == revision
            && selection.reported != Some(revision)
        {
            selection.issue = Some(issue);
            selection.reported = Some(revision);
        }
    }
    fn invalidate(&self, revision: u64) {
        if let Ok(mut selection) = self.0.lock()
            && selection.revision == revision
        {
            selection.revision = selection.revision.wrapping_add(1);
            selection.issue = Some(OutputIssue::Unavailable);
            selection.reported = Some(selection.revision);
        }
    }
    fn stream(&self, name: Option<&str>, revision: u64) -> SinkResult<OutputStream> {
        let builder = if let Some(name) = name {
            let device = cpal::default_host()
                .output_devices()
                .ok()
                .and_then(|mut devices| {
                    devices.find(|device| device.name().ok().as_deref() == Some(name))
                })
                .ok_or_else(|| {
                    SinkError::ConnectionRefused("Selected audio output unavailable".into())
                })?;
            OutputStreamBuilder::from_device(device)
        } else {
            OutputStreamBuilder::from_default_device()
        }
        .map_err(|_| SinkError::ConnectionRefused("Cannot configure audio output".into()))?;
        let choice = self.clone();
        builder
            .with_error_callback(move |_| choice.invalidate(revision))
            .open_stream_or_fallback()
            .map_err(|_| SinkError::ConnectionRefused("Cannot open audio output".into()))
    }
    pub fn open(&self, applied: Option<u64>) -> SinkResult<Option<(OutputStream, u64)>> {
        loop {
            let (name, revision) = {
                let selection = self
                    .0
                    .lock()
                    .map_err(|_| SinkError::ConnectionRefused("Audio output unavailable".into()))?;
                if applied == Some(selection.revision) {
                    return Ok(None);
                }
                (selection.name.clone(), selection.revision)
            };
            let mut stream = match self.stream(name.as_deref(), revision) {
                Ok(stream) => stream,
                Err(_) if name.is_some() => match self.stream(None, revision) {
                    Ok(stream) => {
                        self.report(revision, OutputIssue::UsingDefault);
                        stream
                    }
                    Err(error) => {
                        self.report(revision, OutputIssue::Unavailable);
                        return Err(error);
                    }
                },
                Err(error) => {
                    self.report(revision, OutputIssue::Unavailable);
                    return Err(error);
                }
            };
            stream.log_on_drop(false);
            {
                let selection = self
                    .0
                    .lock()
                    .map_err(|_| SinkError::ConnectionRefused("Audio output unavailable".into()))?;
                if selection.revision != revision {
                    if selection.issue == Some(OutputIssue::Unavailable) {
                        return Err(SinkError::ConnectionRefused(
                            "Audio output disconnected".into(),
                        ));
                    }
                    continue;
                }
            }
            return Ok(Some((stream, revision)));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn late_output_failures_cannot_replace_a_newer_selection() {
        let choice = OutputChoice::default();
        let old = choice.revision();
        choice.request(Some("Headphones".into()));
        choice.report(old, OutputIssue::Unavailable);
        choice.invalidate(old);
        assert_eq!(choice.revision(), old + 1);
        assert_eq!(choice.take_issue(), None);
        choice.report(choice.revision(), OutputIssue::UsingDefault);
        assert_eq!(choice.take_issue(), Some(OutputIssue::UsingDefault));
        choice.report(choice.revision(), OutputIssue::UsingDefault);
        assert_eq!(choice.take_issue(), None);
    }
    #[test]
    fn a_disconnected_stream_can_be_reopened_without_changing_the_preference() {
        let choice = OutputChoice::default();
        let old = choice.revision();
        choice.invalidate(old);
        assert_ne!(old, choice.revision());
        assert_eq!(choice.take_issue(), Some(OutputIssue::Unavailable));
        assert!(choice.0.lock().unwrap().name.is_none());
    }
    #[test]
    fn callbacks_from_a_retired_connection_cannot_pause_its_replacement() {
        let choice = OutputChoice::default();
        choice.request(Some("Headphones".into()));
        let old = choice.revision();
        choice.retire_stream();
        choice.invalidate(old);
        assert_eq!(choice.take_issue(), None);
        assert_eq!(choice.0.lock().unwrap().name.as_deref(), Some("Headphones"));
    }
    #[test]
    #[ignore = "Opens native audio outputs without playing audio"]
    fn live_output_selection_and_missing_device_fallback() {
        let available = devices().unwrap();
        assert!(
            !available.is_empty(),
            "Connect an audio output before testing"
        );
        let choice = OutputChoice::default();
        let default = cpal::default_host()
            .default_output_device()
            .and_then(|device| device.name().ok())
            .expect("System default output required");
        assert!(available.contains(&default));
        choice.request(Some(default));
        let (stream, revision) = choice.open(None).unwrap().unwrap();
        assert_eq!(choice.take_issue(), None);
        assert!(choice.open(Some(revision)).unwrap().is_none());
        drop(stream);
        choice.request(Some("SpotiFlex unavailable test output".into()));
        let (stream, _) = choice.open(None).unwrap().unwrap();
        assert_eq!(choice.take_issue(), Some(OutputIssue::UsingDefault));
        drop(stream);
    }
}
