use std::{
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
        mpsc,
    },
    thread,
    time::Duration,
};

use crate::api::PlayerAction;
use anyhow::{Context, Result};
use librespot_connect::{ConnectConfig, LoadRequest, LoadRequestOptions, PlayingTrack, Spirc};
use librespot_core::error::ErrorKind;
use librespot_core::{Session, authentication::Credentials, config::SessionConfig};
use librespot_playback::{
    audio_backend,
    config::{AudioFormat, PlayerConfig},
    mixer::{Mixer, MixerConfig, softmixer::SoftMixer},
    player::{Player, PlayerEvent},
};
use librespot_protocol::authentication::AuthenticationType;
use tokio::sync::mpsc as async_channel;
use tokio::sync::oneshot;

const CREDENTIAL_SERVICE: &str = "SpotiFlex/SpotifyAudio";
static CREDENTIAL_LOCK: Mutex<()> = Mutex::new(());

pub enum NativeEvent {
    /// Waiting for the one-time browser authorization for audio.
    Authorizing,
    Ready(String),
    Position {
        uri: String,
        position_ms: u64,
        playing: Option<bool>,
    },
    Error(String),
    ControlError(String),
}

struct ControlConnection {
    sender: async_channel::UnboundedSender<PlayerAction>,
    ready: Arc<AtomicBool>,
}

/// Local transport commands never wait for the browsing/Web API worker.
#[derive(Clone, Default)]
pub struct NativeControls(Arc<Mutex<Option<ControlConnection>>>);

impl NativeControls {
    pub fn send(&self, action: PlayerAction) -> std::result::Result<(), PlayerAction> {
        if matches!(action, PlayerAction::Transfer(_) | PlayerAction::Enqueue(_)) {
            return Err(action);
        }
        let Ok(connection) = self.0.lock() else {
            return Err(action);
        };
        let Some(connection) = connection
            .as_ref()
            .filter(|connection| connection.ready.load(Ordering::Acquire))
        else {
            return Err(action);
        };
        connection.sender.send(action).map_err(|error| error.0)
    }
}

fn apply_control(spirc: &Spirc, action: PlayerAction, active: &mut bool) -> Result<()> {
    if !*active
        && matches!(
            action,
            PlayerAction::Play(_)
                | PlayerAction::PlayContext { .. }
                | PlayerAction::PlayUris { .. }
        )
    {
        spirc.activate()?;
        *active = true;
    }
    let options = |playing_track| LoadRequestOptions {
        start_playing: true,
        playing_track,
        ..LoadRequestOptions::default()
    };
    match action {
        PlayerAction::Play(None) => {
            spirc.play()?;
        }
        PlayerAction::Play(Some(uri)) => {
            spirc.load(LoadRequest::from_tracks(vec![uri], options(None)))?;
        }
        PlayerAction::PlayContext { context, offset } => {
            spirc.load(LoadRequest::from_context_uri(
                context,
                options(offset.map(PlayingTrack::Uri)),
            ))?;
        }
        PlayerAction::PlayUris { uris, offset } => {
            spirc.load(LoadRequest::from_tracks(
                uris,
                options(Some(PlayingTrack::Index(
                    offset.min(u32::MAX as usize) as u32
                ))),
            ))?;
        }
        PlayerAction::Pause => spirc.pause()?,
        PlayerAction::Next => spirc.next()?,
        PlayerAction::Previous => spirc.prev()?,
        PlayerAction::Seek(position) => {
            spirc.set_position_ms(position.min(u32::MAX as u64) as u32)?
        }
        PlayerAction::Volume(volume) => {
            spirc.set_volume((u32::from(volume.min(100)) * u32::from(u16::MAX) / 100) as u16)?
        }
        PlayerAction::Shuffle(enabled) => spirc.shuffle(enabled)?,
        PlayerAction::Repeat(state) => {
            spirc.repeat(state == "context")?;
            spirc.repeat_track(state == "track")?;
        }
        PlayerAction::Transfer(_) | PlayerAction::Enqueue(_) => {
            anyhow::bail!("This command requires Spotify's Web API")
        }
    }
    Ok(())
}

pub struct NativeMessage {
    pub generation: u64,
    pub event: NativeEvent,
}

/// Spotify Connect name of this computer's player, unique per PC so the Web
/// API device list can be matched even when its IDs differ from librespot's.
pub fn device_name() -> String {
    let host = std::env::var("COMPUTERNAME")
        .or_else(|_| std::env::var("HOSTNAME"))
        .unwrap_or_default();
    if host.trim().is_empty() {
        "SpotiFlex".into()
    } else {
        format!("SpotiFlex ({})", host.trim())
    }
}

// librespot's reusable credentials, kept in the OS credential store per
// account. They never enter logs or files.
fn load_credentials(account: &str) -> Result<Option<Credentials>> {
    let _guard = CREDENTIAL_LOCK
        .lock()
        .map_err(|_| anyhow::anyhow!("Audio credential store unavailable"))?;
    let entry = keyring::Entry::new(CREDENTIAL_SERVICE, account)?;
    match entry.get_password() {
        Ok(value) => {
            if let Ok(credentials) = serde_json::from_str::<Credentials>(&value)
                && valid_credentials(&credentials, account)
            {
                return Ok(Some(credentials));
            }
            entry
                .delete_credential()
                .context("Cannot remove invalid saved audio login")?;
            Ok(None)
        }
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(_) => anyhow::bail!(
            "Cannot read saved audio login from the operating system credential store"
        ),
    }
}

fn valid_credentials(credentials: &Credentials, account: &str) -> bool {
    !account.is_empty()
        && credentials.username.as_deref() == Some(account)
        && credentials.auth_type == AuthenticationType::AUTHENTICATION_STORED_SPOTIFY_CREDENTIALS
        && !credentials.auth_data.is_empty()
}

fn save_credentials(
    account: &str,
    credentials: &Credentials,
    cancelled: &AtomicBool,
) -> Result<()> {
    let _guard = CREDENTIAL_LOCK
        .lock()
        .map_err(|_| anyhow::anyhow!("Audio credential store unavailable"))?;
    if cancelled.load(Ordering::Relaxed) {
        return Ok(());
    }
    anyhow::ensure!(
        valid_credentials(credentials, account),
        "Audio sign-in belongs to a different Spotify account. Reconnect and select the account used in SpotiFlex."
    );
    keyring::Entry::new(CREDENTIAL_SERVICE, account)?
        .set_password(&serde_json::to_string(credentials)?)
        .context("Cannot save audio login to the operating system credential store")
}

pub fn forget_credentials(account: &str) -> Result<()> {
    let _guard = CREDENTIAL_LOCK
        .lock()
        .map_err(|_| anyhow::anyhow!("Audio credential store unavailable"))?;
    if account.is_empty() {
        return Ok(());
    }
    match keyring::Entry::new(CREDENTIAL_SERVICE, account)?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(_) => anyhow::bail!(
            "Cannot remove saved audio login from the operating system credential store"
        ),
    }
}

enum Outcome {
    Stopped,
    Failed(Failure),
}

struct Failure {
    reason: String,
    rejected_credentials: bool,
}

impl Failure {
    fn other(reason: impl Into<String>) -> Self {
        Self {
            reason: reason.into(),
            rejected_credentials: false,
        }
    }

    fn from_connection(error: librespot_core::Error) -> Self {
        // The AP error type is private in librespot 0.8. Match only its exact
        // credential-rejection messages; other permission errors are not login expiry.
        let message = error.error.to_string();
        let rejected_credentials = error.kind == ErrorKind::Unauthenticated
            || (error.kind == ErrorKind::PermissionDenied
                && matches!(
                    message.as_str(),
                    "Login failed with reason: Bad credentials"
                        | "Login failed with reason: Could not validate credentials"
                ));
        let reason = if rejected_credentials {
            "Spotify rejected the audio login".into()
        } else if message == "Login failed with reason: Premium account required" {
            "Spotify reports this audio account requires Premium".into()
        } else {
            format!("Spotify audio connection failed: {}", error.kind)
        };
        Self {
            reason,
            rejected_credentials,
        }
    }
}

fn connect_with_credentials(
    stored: Option<Credentials>,
    cancelled: &AtomicBool,
    mut authorize: impl FnMut() -> Result<Credentials>,
    mut connect: impl FnMut(Credentials) -> Outcome,
    mut forget: impl FnMut() -> Result<()>,
) -> Outcome {
    if cancelled.load(Ordering::Relaxed) {
        return Outcome::Stopped;
    }
    if let Some(credentials) = stored {
        match connect(credentials) {
            Outcome::Failed(failure) if failure.rejected_credentials => {
                if cancelled.load(Ordering::Relaxed) {
                    return Outcome::Stopped;
                }
                if let Err(error) = forget() {
                    return Outcome::Failed(Failure::other(error.to_string()));
                }
            }
            outcome => return outcome,
        }
    }
    if cancelled.load(Ordering::Relaxed) {
        return Outcome::Stopped;
    }
    let credentials = match authorize() {
        Ok(credentials) => credentials,
        Err(_) if cancelled.load(Ordering::Relaxed) => return Outcome::Stopped,
        Err(error) => {
            return Outcome::Failed(Failure::other(format!(
                "Audio authorization failed: {error}"
            )));
        }
    };
    if cancelled.load(Ordering::Relaxed) {
        return Outcome::Stopped;
    }
    connect(credentials)
}

pub struct NativePlayer {
    stop: Option<oneshot::Sender<()>>,
    cancelled: Arc<AtomicBool>,
    ready: Arc<AtomicBool>,
}

impl NativePlayer {
    pub fn start(
        account: String,
        generation: u64,
        events: mpsc::Sender<NativeMessage>,
        repaint: eframe::egui::Context,
        controls: NativeControls,
    ) -> Self {
        let (stop, mut stopped) = oneshot::channel();
        let cancelled = Arc::new(AtomicBool::new(false));
        let cancel = cancelled.clone();
        let ready = Arc::new(AtomicBool::new(false));
        let thread_ready = ready.clone();
        let (sender, mut commands) = async_channel::unbounded_channel();
        if let Ok(mut connection) = controls.0.lock() {
            *connection = Some(ControlConnection {
                sender,
                ready: ready.clone(),
            });
        }
        thread::spawn(move || {
            let emit = |event| {
                let _ = events.send(NativeMessage { generation, event });
                repaint.request_repaint();
            };
            let Ok(runtime) = tokio::runtime::Builder::new_multi_thread()
                .enable_all()
                .worker_threads(2)
                .build()
            else {
                emit(NativeEvent::Error(
                    "Cannot start native audio runtime".into(),
                ));
                return;
            };
            let stored = match load_credentials(&account) {
                Ok(credentials) => credentials,
                Err(error) => {
                    emit(NativeEvent::Error(error.to_string()));
                    return;
                }
            };
            let outcome = connect_with_credentials(
                stored,
                &cancel,
                || {
                    emit(NativeEvent::Authorizing);
                    crate::auth::http_client()
                        .and_then(|client| crate::auth::authorize_audio(&client, &cancel))
                        .map(Credentials::with_access_token)
                },
                |credentials| {
                    runtime.block_on(run(
                        credentials,
                        &account,
                        &cancel,
                        &mut stopped,
                        &mut commands,
                        &thread_ready,
                        &emit,
                    ))
                },
                || forget_credentials(&account),
            );
            thread_ready.store(false, Ordering::Release);
            if let Outcome::Failed(failure) = outcome
                && !cancel.load(Ordering::Relaxed)
            {
                emit(NativeEvent::Error(format!(
                    "{}. Reconnect native audio in Settings.",
                    failure.reason
                )));
            }
        });
        Self {
            stop: Some(stop),
            cancelled,
            ready,
        }
    }
}

async fn run(
    credentials: Credentials,
    account: &str,
    cancelled: &AtomicBool,
    stopped: &mut oneshot::Receiver<()>,
    commands: &mut async_channel::UnboundedReceiver<PlayerAction>,
    ready: &AtomicBool,
    emit: &impl Fn(NativeEvent),
) -> Outcome {
    // Default session config uses the desktop client ID that issued the token.
    let session = Session::new(
        SessionConfig {
            client_id: crate::auth::AUDIO_CLIENT_ID.into(),
            ..SessionConfig::default()
        },
        None,
    );
    let mixer = match SoftMixer::open(MixerConfig::default()) {
        Ok(mixer) => Arc::new(mixer),
        Err(_) => return Outcome::Failed(Failure::other("Cannot initialize audio mixer")),
    };
    let Some(backend) = audio_backend::find(Some("rodio".into())) else {
        return Outcome::Failed(Failure::other("Native audio backend missing"));
    };
    let player = Player::new(
        PlayerConfig::default(),
        session.clone(),
        mixer.get_soft_volume(),
        move || backend(None, AudioFormat::F32),
    );
    let mut player_events = player.get_player_event_channel();
    let config = ConnectConfig {
        name: device_name(),
        ..ConnectConfig::default()
    };
    let connection = tokio::select! {
        _ = &mut *stopped => { session.shutdown(); return Outcome::Stopped; }
        result = tokio::time::timeout(Duration::from_secs(40), Spirc::new(config, session.clone(), credentials, player, mixer)) => result,
    };
    let (spirc, task) = match connection {
        Ok(Ok(connection)) => connection,
        failure => {
            session.shutdown();
            return Outcome::Failed(match failure {
                Ok(Err(error)) => Failure::from_connection(error),
                _ => Failure::other("Audio connection timed out after 40 seconds"),
            });
        }
    };
    if cancelled.load(Ordering::Relaxed) {
        session.shutdown();
        return Outcome::Stopped;
    }
    let reusable = Credentials {
        username: Some(session.username()),
        auth_type: AuthenticationType::AUTHENTICATION_STORED_SPOTIFY_CREDENTIALS,
        auth_data: session.auth_data(),
    };
    if reusable.username.as_deref() != Some(account) {
        let _ = spirc.shutdown();
        session.shutdown();
        return Outcome::Failed(Failure::other(
            "Audio sign-in belongs to a different Spotify account. Reconnect and select the account used in SpotiFlex",
        ));
    }
    if !reusable.auth_data.is_empty()
        && let Err(error) = save_credentials(account, &reusable, cancelled)
    {
        emit(NativeEvent::Error(format!("{error:#}")));
    }
    if cancelled.load(Ordering::Relaxed) {
        session.shutdown();
        return Outcome::Stopped;
    }
    ready.store(true, Ordering::Release);
    emit(NativeEvent::Ready(session.device_id().to_owned()));
    tokio::pin!(task);
    let mut active = false;
    loop {
        tokio::select! {
            _ = &mut *stopped => {
                let _ = spirc.shutdown();
                let _ = tokio::time::timeout(Duration::from_secs(2), &mut task).await;
                break;
            }
            _ = &mut task => { emit(NativeEvent::Error("Native audio disconnected. Retry from Settings.".into())); break; }
            Some(action) = commands.recv() => {
                if apply_control(&spirc, action, &mut active).is_err() { emit(NativeEvent::ControlError("Native playback command failed. Reconnect native audio in Settings.".into())); }
            }
            event = player_events.recv() => {
                match event {
                    Some(PlayerEvent::SessionConnected { .. }) => active = true,
                    Some(PlayerEvent::SessionDisconnected { .. }) => active = false,
                    Some(PlayerEvent::Playing { track_id, position_ms, .. }) => emit(NativeEvent::Position { uri: track_id.to_uri().unwrap_or_default(), position_ms: position_ms.into(), playing: Some(true) }),
                    Some(PlayerEvent::Paused { track_id, position_ms, .. }) => emit(NativeEvent::Position { uri: track_id.to_uri().unwrap_or_default(), position_ms: position_ms.into(), playing: Some(false) }),
                    Some(PlayerEvent::PositionChanged { track_id, position_ms, .. } | PlayerEvent::Seeked { track_id, position_ms, .. }) => emit(NativeEvent::Position { uri: track_id.to_uri().unwrap_or_default(), position_ms: position_ms.into(), playing: None }),
                    Some(PlayerEvent::Unavailable { .. }) => emit(NativeEvent::Error("Spotify could not load this track for native playback".into())),
                    None => break,
                    _ => {}
                }
            }
        }
    }
    session.shutdown();
    Outcome::Stopped
}

impl Drop for NativePlayer {
    fn drop(&mut self) {
        self.cancelled.store(true, Ordering::Relaxed);
        self.ready.store(false, Ordering::Release);
        if let Some(stop) = self.stop.take() {
            let _ = stop.send(());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::Cell;

    #[test]
    fn local_pause_bypasses_browsing_worker_and_retired_sessions() {
        let controls = NativeControls::default();
        let (sender, mut receiver) = async_channel::unbounded_channel();
        let ready = Arc::new(AtomicBool::new(true));
        *controls.0.lock().unwrap() = Some(ControlConnection {
            sender,
            ready: ready.clone(),
        });
        assert!(controls.send(PlayerAction::Pause).is_ok());
        assert!(matches!(receiver.try_recv().unwrap(), PlayerAction::Pause));
        ready.store(false, Ordering::Release);
        assert!(matches!(
            controls.send(PlayerAction::Pause),
            Err(PlayerAction::Pause)
        ));
        assert!(receiver.try_recv().is_err());
    }

    #[test]
    fn remote_only_commands_keep_their_web_api_route() {
        let controls = NativeControls::default();
        assert!(matches!(
            controls.send(PlayerAction::Transfer("remote".into())),
            Err(PlayerAction::Transfer(_))
        ));
        assert!(matches!(
            controls.send(PlayerAction::Enqueue("spotify:track:example".into())),
            Err(PlayerAction::Enqueue(_))
        ));
    }

    fn stored_credentials() -> Credentials {
        Credentials {
            username: Some("account".into()),
            auth_type: AuthenticationType::AUTHENTICATION_STORED_SPOTIFY_CREDENTIALS,
            auth_data: b"test-reusable-credential".to_vec(),
        }
    }

    #[test]
    fn temporary_audio_failure_keeps_saved_login_and_does_not_open_browser() {
        let browser = Cell::new(0);
        let deletions = Cell::new(0);
        let outcome = connect_with_credentials(
            Some(stored_credentials()),
            &AtomicBool::new(false),
            || {
                browser.set(browser.get() + 1);
                anyhow::bail!("unexpected browser login");
            },
            |_| Outcome::Failed(Failure::other("connection timed out")),
            || {
                deletions.set(deletions.get() + 1);
                Ok(())
            },
        );
        assert!(matches!(outcome, Outcome::Failed(_)));
        assert_eq!(browser.get(), 0);
        assert_eq!(deletions.get(), 0);
    }

    #[test]
    fn rejected_saved_login_authorizes_again_only_once() {
        let attempts = Cell::new(0);
        let browser = Cell::new(0);
        let deletions = Cell::new(0);
        let outcome = connect_with_credentials(
            Some(stored_credentials()),
            &AtomicBool::new(false),
            || {
                browser.set(browser.get() + 1);
                Ok(Credentials::with_access_token("test-access-token"))
            },
            |credentials| {
                attempts.set(attempts.get() + 1);
                if attempts.get() == 1 {
                    assert!(valid_credentials(&credentials, "account"));
                } else {
                    assert!(
                        credentials.auth_type == AuthenticationType::AUTHENTICATION_SPOTIFY_TOKEN
                    );
                }
                Outcome::Failed(Failure {
                    reason: "credentials rejected".into(),
                    rejected_credentials: true,
                })
            },
            || {
                deletions.set(deletions.get() + 1);
                Ok(())
            },
        );
        assert!(matches!(outcome, Outcome::Failed(_)));
        assert_eq!(attempts.get(), 2);
        assert_eq!(browser.get(), 1);
        assert_eq!(deletions.get(), 1);
    }

    #[test]
    fn saved_login_connects_without_browser_and_cancellation_skips_work() {
        let attempts = Cell::new(0);
        let outcome = connect_with_credentials(
            Some(stored_credentials()),
            &AtomicBool::new(false),
            || panic!("saved login must not open browser"),
            |_| {
                attempts.set(attempts.get() + 1);
                Outcome::Stopped
            },
            || panic!("working login must not be deleted"),
        );
        assert!(matches!(outcome, Outcome::Stopped));
        assert_eq!(attempts.get(), 1);
        let outcome = connect_with_credentials(
            None,
            &AtomicBool::new(true),
            || panic!("cancelled login must not open browser"),
            |_| panic!("cancelled login must not connect"),
            || panic!("cancelled login must not delete credentials"),
        );
        assert!(matches!(outcome, Outcome::Stopped));
    }

    #[test]
    fn reusable_credentials_roundtrip_and_are_bound_to_the_account() {
        let value = serde_json::to_string(&stored_credentials()).unwrap();
        let credentials: Credentials = serde_json::from_str(&value).unwrap();
        assert!(valid_credentials(&credentials, "account"));
        assert!(!valid_credentials(&credentials, "different-account"));
        assert!(!valid_credentials(
            &Credentials::with_access_token("test-token"),
            "account"
        ));
    }

    #[test]
    fn only_credential_rejections_trigger_browser_reauthorization() {
        let rejected = Failure::from_connection(librespot_core::Error::permission_denied(
            "Login failed with reason: Bad credentials",
        ));
        assert!(rejected.rejected_credentials);
        let network =
            Failure::from_connection(librespot_core::Error::unavailable("network failure"));
        assert!(!network.rejected_credentials);
        let premium = Failure::from_connection(librespot_core::Error::permission_denied(
            "Login failed with reason: Premium account required",
        ));
        assert!(!premium.rejected_credentials);
        let unrelated = Failure::from_connection(librespot_core::Error::permission_denied(
            "different permission failure",
        ));
        assert!(!unrelated.rejected_credentials);
    }
}
