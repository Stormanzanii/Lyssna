use std::{
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, AtomicU32, Ordering},
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
    config::PlayerConfig,
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
    Track(Box<crate::model::Track>),
    Transport {
        shuffle: Option<bool>,
        repeat: Option<String>,
        volume: Option<u8>,
    },
    Position {
        uri: String,
        position_ms: u64,
        playing: Option<bool>,
        seeked: bool,
    },
    Error(String),
    ControlError(String),
}

struct ControlConnection {
    session: Arc<Mutex<Option<Session>>>,
    volume: Arc<AtomicU32>,
    sender: async_channel::UnboundedSender<PlayerAction>,
    ready: Arc<AtomicBool>,
    playlists: Option<async_channel::UnboundedSender<PlaylistRead>>,
    metadata: Option<async_channel::UnboundedSender<MetadataRead>>,
}
struct MetadataRead {
    offset: usize,
    uri: String,
    kind: librespot_protocol::extension_kind::ExtensionKind,
    reply: mpsc::Sender<std::result::Result<Vec<u8>, String>>,
}
struct PlaylistRead {
    id: String,
    offset: usize,
    reply: mpsc::Sender<std::result::Result<Vec<crate::model::Track>, String>>,
}
struct PlaybackServices<'a> {
    commands: &'a mut async_channel::UnboundedReceiver<PlayerAction>,
    playlists: &'a mut async_channel::UnboundedReceiver<PlaylistRead>,
    metadata: &'a mut async_channel::UnboundedReceiver<MetadataRead>,
    latest_volume: &'a AtomicU32,
    shared_session: &'a Mutex<Option<Session>>,
}

/// Local transport commands never wait for the browsing/Web API worker.
#[derive(Clone, Default)]
pub struct NativeControls(Arc<Mutex<Option<ControlConnection>>>);

impl NativeControls {
    fn session(&self) -> Result<Session> {
        let session = {
            let connection = self
                .0
                .lock()
                .map_err(|_| anyhow::anyhow!("Native audio unavailable"))?;
            let connection = connection
                .as_ref()
                .filter(|connection| connection.ready.load(Ordering::Acquire))
                .context("Native audio is connecting")?;
            connection
                .session
                .lock()
                .map_err(|_| anyhow::anyhow!("Native session unavailable"))?
                .clone()
                .context("Native session unavailable")?
        };
        Ok(session)
    }
    pub fn playlist_info(&self, id: &str) -> Result<crate::model::BrowseInfo> {
        let session = self.session()?;
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()?
            .block_on(crate::native_browse::playlist_info(&session, id))
    }
    pub fn home(&self, timezone: &str) -> Result<crate::home::HomePage> {
        let session = self.session()?;
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()?
            .block_on(crate::home::fetch(&session, timezone))
    }
    pub fn catalogue(&self, kind: &str, id: &str, offset: usize) -> Result<serde_json::Value> {
        use librespot_protocol::extension_kind::ExtensionKind;
        anyhow::ensure!(
            id.len() == 22 && id.bytes().all(|byte| byte.is_ascii_alphanumeric()) && offset <= 5000,
            "Invalid catalogue request"
        );
        let extension = match kind {
            "artist" => ExtensionKind::ARTIST_V4,
            "album" => ExtensionKind::ALBUM_V4,
            _ => anyhow::bail!("Unsupported catalogue query"),
        };
        serde_json::from_slice(&self.request_metadata(
            &format!("spotify:{kind}:{id}"),
            extension,
            offset,
        )?)
        .map_err(anyhow::Error::from)
    }
    pub fn metadata(
        &self,
        uri: &str,
        kind: librespot_protocol::extension_kind::ExtensionKind,
    ) -> Result<Vec<u8>> {
        self.request_metadata(uri, kind, 0)
    }
    pub fn track(&self, uri: &str) -> Result<crate::model::Track> {
        use protobuf::Message;
        let bytes = self.metadata(
            uri,
            librespot_protocol::extension_kind::ExtensionKind::TRACK_V4,
        )?;
        let message = librespot_protocol::metadata::Track::parse_from_bytes(&bytes)?;
        let track = librespot_metadata::Track::try_from(&message)?;
        metadata_track(&track).context("Track metadata unavailable")
    }
    fn request_metadata(
        &self,
        uri: &str,
        kind: librespot_protocol::extension_kind::ExtensionKind,
        offset: usize,
    ) -> Result<Vec<u8>> {
        use librespot_protocol::extension_kind::ExtensionKind;
        anyhow::ensure!(
            matches!(
                kind,
                ExtensionKind::CANVAS_V1
                    | ExtensionKind::CANVAZ
                    | ExtensionKind::STREAM_COUNT
                    | ExtensionKind::ARTIST_V4
                    | ExtensionKind::ALBUM_V4
            ),
            "Unsupported native metadata kind"
        );
        let parsed = librespot_core::SpotifyUri::from_uri(uri)?;
        anyhow::ensure!(
            matches!(
                parsed,
                librespot_core::SpotifyUri::Track { .. }
                    | librespot_core::SpotifyUri::Artist { .. }
                    | librespot_core::SpotifyUri::Album { .. }
            ),
            "Track metadata required"
        );
        let (reply, receive) = mpsc::channel();
        {
            let connection = self
                .0
                .lock()
                .map_err(|_| anyhow::anyhow!("Native metadata unavailable"))?;
            let sender = connection
                .as_ref()
                .filter(|connection| connection.ready.load(Ordering::Acquire))
                .and_then(|connection| connection.metadata.as_ref())
                .context("Connect native audio for metadata")?;
            sender
                .send(MetadataRead {
                    offset,
                    uri: uri.into(),
                    kind,
                    reply,
                })
                .map_err(|_| anyhow::anyhow!("Native metadata unavailable"))?;
        }
        receive
            .recv_timeout(Duration::from_secs(10))
            .context("Native metadata request timed out")?
            .map_err(anyhow::Error::msg)
    }
    pub fn playlist_tracks(&self, id: &str, offset: usize) -> Result<Vec<crate::model::Track>> {
        anyhow::ensure!(
            (id.len() == 22 && id.bytes().all(|byte| byte.is_ascii_alphanumeric()))
                || id == "liked"
                || id
                    .strip_prefix("search:")
                    .is_some_and(|query| !query.trim().is_empty()
                        && query.len() <= 600
                        && !query.chars().any(char::is_control))
                || id.strip_prefix("album:").is_some_and(
                    |id| id.len() == 22 && id.bytes().all(|byte| byte.is_ascii_alphanumeric())
                ),
            "Invalid browsing request"
        );
        let (reply, receive) = mpsc::channel();
        {
            let connection = self
                .0
                .lock()
                .map_err(|_| anyhow::anyhow!("Native Spotify connection unavailable"))?;
            let sender = connection
                .as_ref()
                .filter(|connection| connection.ready.load(Ordering::Acquire))
                .and_then(|connection| connection.playlists.as_ref())
                .context("Connect native audio to read this playlist")?;
            sender
                .send(PlaylistRead {
                    id: id.into(),
                    offset,
                    reply,
                })
                .map_err(|_| anyhow::anyhow!("Native Spotify connection unavailable"))?;
        }
        receive
            .recv_timeout(Duration::from_secs(25))
            .context("Spotify playlist request timed out")?
            .map_err(anyhow::Error::msg)
    }
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
        if let PlayerAction::Volume(value) = action {
            connection
                .volume
                .store(u32::from(value.min(100)), Ordering::Release);
            return Ok(());
        }
        connection.sender.send(action).map_err(|error| error.0)
    }
}

fn apply_control(spirc: &Spirc, action: PlayerAction, active: &mut bool) -> Result<()> {
    if matches!(
        action,
        PlayerAction::Play(Some(_))
            | PlayerAction::PlayContext { .. }
            | PlayerAction::PlayUris { .. }
    ) || (!*active && matches!(action, PlayerAction::Play(None)))
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
            spirc.load(LoadRequest::from_tracks(
                vec![uri],
                options(Some(PlayingTrack::Index(0))),
            ))?;
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

fn public_track(item: &librespot_metadata::audio::item::AudioItem) -> Option<crate::model::Track> {
    use crate::model::{Album, Artist, Artwork, Track};
    use librespot_metadata::{artist::ArtistRole, audio::item::UniqueFields};
    let UniqueFields::Track { artists, album, .. } = &item.unique_fields else {
        return None;
    };
    let uri = item.track_id.to_uri();
    let mut images: Vec<Artwork> = item
        .covers
        .iter()
        .map(|image| Artwork {
            url: image.url.clone(),
            width: u32::try_from(image.width).ok(),
        })
        .collect();
    images.sort_by_key(|image| std::cmp::Reverse(image.width));
    Some(Track {
        explicit: item.is_explicit,
        id: uri.rsplit(':').next().map(str::to_owned),
        uri,
        name: item.name.clone(),
        duration_ms: item.duration_ms.into(),
        songwriters: artists
            .iter()
            .filter(|artist| artist.role == ArtistRole::ARTIST_ROLE_COMPOSER)
            .map(|artist| artist.name.clone())
            .collect(),
        artists: artists
            .iter()
            .filter(|artist| {
                !matches!(
                    artist.role,
                    ArtistRole::ARTIST_ROLE_COMPOSER | ArtistRole::ARTIST_ROLE_CONDUCTOR
                )
            })
            .map(|artist| {
                let uri = artist.id.to_uri();
                Artist {
                    id: uri.rsplit(':').next().map(str::to_owned),
                    uri,
                    name: artist.name.clone(),
                    ..Artist::default()
                }
            })
            .collect(),
        album: Album {
            name: album.clone(),
            images,
            ..Album::default()
        },
        ..Track::default()
    })
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
        repaint: crate::notify::Notifier,
        controls: NativeControls,
    ) -> Self {
        let (stop, mut stopped) = oneshot::channel();
        let cancelled = Arc::new(AtomicBool::new(false));
        let cancel = cancelled.clone();
        let ready = Arc::new(AtomicBool::new(false));
        let thread_ready = ready.clone();
        let (sender, mut commands) = async_channel::unbounded_channel();
        let (playlist_sender, mut playlists) = async_channel::unbounded_channel();
        let (metadata_sender, mut metadata) = async_channel::unbounded_channel();
        let shared_session = Arc::new(Mutex::new(None));
        let volume = crate::config::Settings::load()
            .map(|settings| settings.volume_percent.min(100))
            .unwrap_or(100);
        let latest_volume = Arc::new(AtomicU32::new(u32::from(volume)));
        if let Ok(mut connection) = controls.0.lock() {
            *connection = Some(ControlConnection {
                session: shared_session.clone(),
                volume: latest_volume.clone(),
                sender,
                ready: ready.clone(),
                playlists: Some(playlist_sender),
                metadata: Some(metadata_sender),
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
                        PlaybackServices {
                            commands: &mut commands,
                            playlists: &mut playlists,
                            metadata: &mut metadata,
                            latest_volume: &latest_volume,
                            shared_session: &shared_session,
                        },
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
    channels: PlaybackServices<'_>,
    ready: &AtomicBool,
    emit: &impl Fn(NativeEvent),
) -> Outcome {
    let PlaybackServices {
        commands,
        playlists,
        metadata,
        latest_volume,
        shared_session,
    } = channels;
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
    let flush_audio = Arc::new(AtomicBool::new(false));
    let sink_flush = flush_audio.clone();
    let (seek_ready, mut audible_seeks) = async_channel::unbounded_channel();
    let audio_buffer = crate::audio::AudioBuffer::default();
    let sink_buffer = audio_buffer.clone();
    let player = Player::new(
        PlayerConfig {
            position_update_interval: Some(Duration::from_millis(250)),
            ..PlayerConfig::default()
        },
        session.clone(),
        mixer.get_soft_volume(),
        move || {
            Box::new(crate::audio::AudioSink::new(
                sink_flush.clone(),
                seek_ready.clone(),
                sink_buffer.clone(),
            ))
        },
    );
    let mut player_events = player.get_player_event_channel();
    let local_player = player.clone();
    let config = ConnectConfig {
        name: device_name(),
        initial_volume: crate::config::Settings::load()
            .ok()
            .map(|settings| {
                (u32::from(settings.volume_percent.min(100)) * u32::from(u16::MAX) / 100) as u16
            })
            .unwrap_or(u16::MAX),
        ..ConnectConfig::default()
    };
    let connection = tokio::select! {
        _ = &mut *stopped => { session.shutdown(); return Outcome::Stopped; }
        result = tokio::time::timeout(Duration::from_secs(40), Spirc::new(config, session.clone(), credentials, player, mixer.clone())) => result,
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
    if let Ok(mut shared) = shared_session.lock() {
        *shared = Some(session.clone());
    }
    ready.store(true, Ordering::Release);
    emit(NativeEvent::Ready(session.device_id().to_owned()));
    tokio::pin!(task);
    let mut active = false;
    let mut audio_playing = false;
    let mut intent = crate::playback_intent::PlaybackIntent::default();
    let mut intent_tick = tokio::time::interval(Duration::from_millis(20));
    let mut volume_sync: Option<(u8, std::time::Instant)> = None;
    let mut volume_guard: Option<(u8, std::time::Instant)> = None;
    let mut pending_seek: Option<(String, u64)> = None;
    loop {
        tokio::select! {
            Some(request)=metadata.recv()=>{let session=session.clone();tokio::spawn(async move{let result=async {let uri=librespot_core::SpotifyUri::from_uri(&request.uri)?;let bytes=if matches!(request.kind,librespot_protocol::extension_kind::ExtensionKind::ARTIST_V4|librespot_protocol::extension_kind::ExtensionKind::ALBUM_V4){let kind=if request.kind==librespot_protocol::extension_kind::ExtensionKind::ARTIST_V4{"artist"}else{"album"};let id=request.uri.rsplit(":").next().context("Missing catalogue ID")?;let data=crate::catalogue::page(&session,kind,id,request.offset).await?;serde_json::to_vec(&data)?.into()}else if request.kind==librespot_protocol::extension_kind::ExtensionKind::CANVAS_V1{let text=uri.to_uri();let mut body=vec![10,(text.len()+2)as u8,10,text.len()as u8];body.extend_from_slice(text.as_bytes());session.spclient().request(&reqwest::Method::POST,"/canvaz-cache/v0/canvases",None,Some(&body)).await?}else{session.spclient().get_metadata(request.kind,&uri).await?};anyhow::ensure!(bytes.len()<=1_000_000,"Metadata response too large");Ok::<_,anyhow::Error>(bytes.to_vec())};let result=tokio::time::timeout(Duration::from_secs(8),result).await.map_err(|_|"Metadata request timed out".to_owned()).and_then(|value|value.map_err(|error|error.to_string()));let _=request.reply.send(result);});}
            _=intent_tick.tick()=>{},
            Some(())=audible_seeks.recv()=>{if let Some((uri,position_ms))=pending_seek.take(){emit(NativeEvent::Position{uri,position_ms,playing:Some(audio_playing),seeked:true});}}
            Some(request)=playlists.recv()=>{
                let session=session.clone();
                tokio::spawn(async move{
                    let result=tokio::time::timeout(Duration::from_secs(22),crate::native_browse::read(&session,&request.id,request.offset)).await.map_err(|_|"Spotify browsing request timed out".to_owned()).and_then(|result|result.map_err(|error|error.to_string()));
                    let _=request.reply.send(result);
                });
            }
            _ = &mut *stopped => {
                let _ = spirc.shutdown();
                let _ = tokio::time::timeout(Duration::from_secs(2), &mut task).await;
                break;
            }
            _ = &mut task => { emit(NativeEvent::Error("Native audio disconnected. Retry from Settings.".into())); break; }
            Some(action) = commands.recv() => {
                if matches!(action,PlayerAction::Play(None)|PlayerAction::Pause){intent.request(matches!(action,PlayerAction::Play(None)));}else{
                if matches!(action,PlayerAction::Play(Some(_))|PlayerAction::PlayUris{..}|PlayerAction::PlayContext{..}){let target=match &action{PlayerAction::Play(Some(uri))=>Some(uri.clone()),PlayerAction::PlayContext{offset,..}=>offset.clone(),PlayerAction::PlayUris{uris,offset}=>uris.get(*offset).cloned(),_=>None};intent.loading_track(target,std::time::Instant::now());}
                if let PlayerAction::Volume(volume)=&action{mixer.set_volume((u32::from((*volume).min(100))*u32::from(u16::MAX)/100)as u16);emit(NativeEvent::Transport{shuffle:None,repeat:None,volume:Some((*volume).min(100))});}
                if apply_control(&spirc, action, &mut active).is_err() {intent.reset(); emit(NativeEvent::ControlError("Native playback command failed. Reconnect native audio in Settings.".into())); }}
            }
            event = player_events.recv() => {
                match event {
                    Some(PlayerEvent::Loading{track_id,..})=>intent.track_loading(track_id.to_uri(),std::time::Instant::now()),
                    Some(PlayerEvent::ShuffleChanged{shuffle})=>emit(NativeEvent::Transport{shuffle:Some(shuffle),repeat:None,volume:None}),
                    Some(PlayerEvent::RepeatChanged{context,track})=>emit(NativeEvent::Transport{shuffle:None,repeat:Some(if track{"track"}else if context{"context"}else{"off"}.into()),volume:None}),
                    Some(PlayerEvent::VolumeChanged{volume})=>{let value=((u32::from(volume)*100+u32::from(u16::MAX)/2)/u32::from(u16::MAX))as u8;if let Some((wanted,until))=volume_guard&&std::time::Instant::now()<until&&wanted!=value{mixer.set_volume((u32::from(wanted)*u32::from(u16::MAX)/100)as u16);}else{emit(NativeEvent::Transport{shuffle:None,repeat:None,volume:Some(value)});}},
                    Some(PlayerEvent::SessionConnected { .. }) => active = true,
                    Some(PlayerEvent::SessionDisconnected { .. }) => active = false,
                    Some(PlayerEvent::TrackChanged { audio_item }) => {pending_seek=None;if let Some(track)=public_track(&audio_item) {intent.track_loading(track.uri.clone(),std::time::Instant::now()); emit(NativeEvent::Track(Box::new(track))); } },
                    Some(PlayerEvent::Playing { track_id, position_ms, .. }) => {audio_playing=true;intent.acknowledge_track(&track_id.to_uri(),true);emit(NativeEvent::Position { uri: track_id.to_uri(), position_ms: position_ms.into(), playing: Some(true), seeked: false });},
                    Some(PlayerEvent::Paused { track_id, position_ms, .. }) => {audio_playing=false;intent.acknowledge_track(&track_id.to_uri(),false);emit(NativeEvent::Position { uri: track_id.to_uri(), position_ms: position_ms.into(), playing: Some(false), seeked: pending_seek.take().is_some() });},
                    Some(PlayerEvent::Seeked { track_id, position_ms, .. }) => {let uri=track_id.to_uri();flush_audio.store(true,Ordering::Release);if audio_playing{pending_seek=Some((uri,position_ms.into()));}else{emit(NativeEvent::Position { uri, position_ms: position_ms.into(), playing: Some(false), seeked: true });}},
                    Some(PlayerEvent::PositionChanged { track_id, position_ms, .. } | PlayerEvent::PositionCorrection { track_id, position_ms, .. }) => {if pending_seek.is_none(){emit(NativeEvent::Position { uri: track_id.to_uri(), position_ms: u64::from(position_ms).saturating_sub(audio_buffer.latency_ms()), playing: None, seeked: false });}},
                    Some(PlayerEvent::Unavailable { .. }) => {intent.reset();emit(NativeEvent::ControlError("This track is unavailable for your account. Choose another song.".into()));},
                    None => break,
                    _ => {}
                }
            }
        }
        let now = std::time::Instant::now();
        let value = latest_volume.swap(u32::MAX, Ordering::AcqRel);
        if value <= 100 {
            let volume = value as u8;
            mixer.set_volume((value * u32::from(u16::MAX) / 100) as u16);
            volume_sync = Some((volume, now));
            volume_guard = Some((volume, now + Duration::from_secs(3)));
            emit(NativeEvent::Transport {
                shuffle: None,
                repeat: None,
                volume: Some(volume),
            });
        }
        if let Some((volume, changed)) = volume_sync
            && now.duration_since(changed) >= Duration::from_millis(180)
        {
            volume_sync = None;
            let _ = spirc.set_volume((u32::from(volume) * u32::from(u16::MAX) / 100) as u16);
        }
        if let Some(playing) = intent.next(audio_playing, std::time::Instant::now()) {
            // Local transport must not queue behind Spotify Connect HTTP notifications.
            if playing {
                local_player.play();
            } else {
                local_player.pause();
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

pub(crate) fn metadata_track(item: &librespot_metadata::Track) -> Option<crate::model::Track> {
    use crate::model::{Album, Artist, Artwork, Track};
    let artists = |items: &librespot_metadata::artist::Artists| {
        items
            .iter()
            .map(|artist| {
                let uri = artist.id.to_uri();
                Artist {
                    id: uri.rsplit(':').next().map(str::to_owned),
                    uri,
                    name: artist.name.clone(),
                    ..Artist::default()
                }
            })
            .collect()
    };
    let uri = item.id.to_uri();
    let album_uri = item.album.id.to_uri();
    let mut images: Vec<_> = item
        .album
        .cover_group
        .iter()
        .chain(item.album.covers.iter())
        .map(|image| Artwork {
            url: format!("https://i.scdn.co/image/{}", image.id),
            width: u32::try_from(image.width).ok(),
        })
        .collect();
    images.sort_by_key(|image| std::cmp::Reverse(image.width));
    images.dedup_by(|a, b| a.url == b.url);
    Some(Track {
        explicit: item.is_explicit,
        id: uri.rsplit(':').next().map(str::to_owned),
        uri,
        name: item.name.clone(),
        duration_ms: item.duration.max(0) as u64,
        artists: artists(&item.artists),
        songwriters: item
            .artists_with_role
            .iter()
            .filter(|artist| {
                artist.role == librespot_metadata::artist::ArtistRole::ARTIST_ROLE_COMPOSER
            })
            .map(|artist| artist.name.clone())
            .collect(),
        album: Album {
            id: album_uri.rsplit(':').next().map(str::to_owned),
            uri: album_uri,
            name: item.album.name.clone(),
            artists: artists(&item.album.artists),
            images,
            release_date: item.album.date.0.date().to_string(),
            album_type: item.album.type_str.clone(),
            ..Album::default()
        },
        ..Track::default()
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::Cell;
    #[test]
    fn mono_dj_mp3_decodes_into_both_output_channels() {
        use librespot_playback::decoder::{AudioDecoder, AudioPacket, SymphoniaDecoder};
        let mut decoder = SymphoniaDecoder::new(
            std::io::Cursor::new(&include_bytes!("../tests/fixtures/dj-mono.mp3")[..]),
            Default::default(),
        )
        .unwrap();
        let mut frames = 0;
        let mut audible = false;
        while let Some((_, AudioPacket::Samples(samples))) = decoder.next_packet().unwrap() {
            let (stereo, remainder) = samples.as_chunks::<2>();
            assert!(remainder.is_empty());
            for frame in stereo {
                assert_eq!(frame[0], frame[1]);
                audible |= frame[0].abs() > 0.0001;
                frames += 1;
            }
        }
        assert!(frames > 0);
        assert!(audible);
    }
    #[test]
    fn extended_track_metadata_keeps_album_links() {
        use librespot_protocol::metadata::{Album as WireAlbum, Date, Track as WireTrack};
        let wire = WireTrack {
            gid: Some(vec![1; 16]),
            name: Some("Song".into()),
            duration: Some(180000),
            album: protobuf::MessageField::some(WireAlbum {
                gid: Some(vec![2; 16]),
                name: Some("Album".into()),
                date: protobuf::MessageField::some(Date {
                    year: Some(2025),
                    month: Some(1),
                    day: Some(1),
                    ..Date::default()
                }),
                ..WireAlbum::default()
            }),
            ..WireTrack::default()
        };
        let track = metadata_track(&librespot_metadata::Track::try_from(&wire).unwrap()).unwrap();
        assert!(track.album.id.is_some());
        assert!(track.album.uri.starts_with("spotify:album:"));
        assert_eq!(track.album.name, "Album");
    }

    #[test]
    fn local_pause_bypasses_browsing_worker_and_retired_sessions() {
        let controls = NativeControls::default();
        let (sender, mut receiver) = async_channel::unbounded_channel();
        let ready = Arc::new(AtomicBool::new(true));
        *controls.0.lock().unwrap() = Some(ControlConnection {
            session: Arc::default(),
            volume: Arc::new(AtomicU32::new(u32::MAX)),
            sender,
            ready: ready.clone(),
            playlists: None,
            metadata: None,
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
