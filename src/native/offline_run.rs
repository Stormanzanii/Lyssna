//! Playback from downloads while Spotify cannot be reached. Takes the same
//! player commands as the Connect session and reports through the same
//! events, so the app works unchanged; it hands back once Spotify answers.

use super::*;
use crate::offline_queue::{OfflineQueue, Repeat};
use librespot_core::SpotifyUri;
use librespot_playback::player::PlayerEvent;

pub(crate) const OFFLINE_DEVICE: &str = "offline";
const PROBE_EVERY: Duration = Duration::from_secs(15);

async fn spotify_reachable() -> bool {
    matches!(
        tokio::time::timeout(
            Duration::from_secs(5),
            tokio::net::TcpStream::connect(("apresolve.spotify.com", 443)),
        )
        .await,
        Ok(Ok(_))
    )
}

fn unavailable(emit: &impl Fn(NativeEvent)) {
    emit(NativeEvent::ControlError(
        "That isn't available offline. Only downloaded songs play.".into(),
    ));
}

struct Offline<'a, E: Fn(NativeEvent)> {
    player: Arc<Player>,
    queue: OfflineQueue,
    emit: &'a E,
}

impl<E: Fn(NativeEvent)> Offline<'_, E> {
    fn load(&mut self, uri: Option<String>, play: bool, position_ms: u64) {
        let Some(uri) = uri else {
            self.player.stop();
            return;
        };
        match SpotifyUri::from_uri(&uri) {
            Ok(id) => self
                .player
                .load(id, play, position_ms.min(u64::from(u32::MAX)) as u32),
            Err(_) => unavailable(self.emit),
        }
    }

    fn start(
        &mut self,
        uris: Vec<String>,
        start: Option<&str>,
        context: Option<String>,
        play: bool,
        position_ms: u64,
    ) {
        let playable: Vec<String> = uris
            .into_iter()
            .filter(|uri| crate::offline_sync::playable(uri))
            .collect();
        let index = match start {
            Some(start) => match playable.iter().position(|uri| uri == start) {
                Some(index) => index,
                None => return unavailable(self.emit),
            },
            None => 0,
        };
        if playable.is_empty() {
            return unavailable(self.emit);
        }
        if let Some(context) = context {
            (self.emit)(NativeEvent::Context(context));
        }
        let first = self.queue.start(playable, index);
        self.load(first, play, position_ms);
    }

    fn modes(&self) {
        let repeat = self.queue.repeat.name();
        (self.emit)(NativeEvent::Transport {
            shuffle: Some(self.queue.shuffle),
            repeat: Some(repeat.into()),
            volume: None,
        });
        (self.emit)(NativeEvent::Modes(PlayModes::new(
            self.queue.shuffle,
            repeat,
        )));
    }

    fn act(&mut self, account: &str, action: PlayerAction, mixer: &SoftMixer, flush: &AtomicBool) {
        match action {
            PlayerAction::PlayContext { context, offset } => {
                match crate::offline_sync::list(account, &context) {
                    Some((_, tracks)) => {
                        let uris = tracks.into_iter().map(|track| track.uri).collect();
                        self.start(uris, offset.as_deref(), Some(context), true, 0);
                    }
                    None => unavailable(self.emit),
                }
            }
            PlayerAction::PlayUris {
                uris,
                offset,
                context,
            } => {
                let start = uris.get(offset).cloned();
                self.start(uris, start.as_deref(), context, true, 0);
            }
            PlayerAction::Resume {
                uris,
                offset,
                position_ms,
                context,
                ..
            } => {
                let start = uris.get(offset).cloned();
                self.start(uris, start.as_deref(), context, false, position_ms);
            }
            PlayerAction::Play(Some(uri)) if uri.starts_with("spotify:track:") => {
                self.start(vec![uri.clone()], Some(&uri), None, true, 0);
            }
            PlayerAction::Play(Some(context)) => self.act(
                account,
                PlayerAction::PlayContext {
                    context,
                    offset: None,
                },
                mixer,
                flush,
            ),
            PlayerAction::Play(None) => self.player.play(),
            PlayerAction::Pause => self.player.pause(),
            PlayerAction::Next => {
                let next = self.queue.next(true);
                if next.is_some() {
                    self.load(next, true, 0);
                }
            }
            PlayerAction::Previous => {
                let previous = self.queue.previous();
                self.load(previous, true, 0);
            }
            PlayerAction::SkipTo(uri) => {
                let next = self.queue.skip_to(&uri);
                self.load(next, true, 0);
            }
            PlayerAction::Seek(position_ms) => {
                flush.store(true, Ordering::Release);
                self.player
                    .seek(position_ms.min(u64::from(u32::MAX)) as u32);
            }
            PlayerAction::Volume(volume) => {
                mixer.set_volume((u32::from(volume.min(100)) * u32::from(u16::MAX) / 100) as u16);
                (self.emit)(NativeEvent::Transport {
                    shuffle: None,
                    repeat: None,
                    volume: Some(volume.min(100)),
                });
            }
            PlayerAction::Shuffle(shuffle) => {
                self.queue.set_shuffle(shuffle);
                self.modes();
            }
            PlayerAction::Repeat(repeat) => {
                self.queue.repeat = Repeat::parse(&repeat);
                self.modes();
            }
            PlayerAction::Enqueue(uri) if crate::offline_sync::playable(&uri) => {
                self.queue.enqueue(uri);
                (self.emit)(NativeEvent::QueueChanged);
            }
            PlayerAction::RemoveFromQueue(uri) => {
                self.queue.remove_queued(&uri);
                (self.emit)(NativeEvent::QueueChanged);
            }
            PlayerAction::ClearQueue => {
                self.queue.clear_queued();
                (self.emit)(NativeEvent::QueueChanged);
            }
            _ => unavailable(self.emit),
        }
    }

    fn heard(&mut self, event: PlayerEvent, playing: &mut bool) {
        match event {
            event @ PlayerEvent::TrackChanged { .. } => {
                if let Some(track) = public_track_change(&event) {
                    (self.emit)(NativeEvent::Track(Box::new(track)));
                }
            }
            PlayerEvent::Playing {
                track_id,
                position_ms,
                ..
            } => {
                *playing = true;
                (self.emit)(NativeEvent::Position {
                    uri: track_id.to_uri(),
                    position_ms: position_ms.into(),
                    playing: Some(true),
                    seeked: false,
                });
            }
            PlayerEvent::Paused {
                track_id,
                position_ms,
                ..
            } => {
                *playing = false;
                (self.emit)(NativeEvent::Position {
                    uri: track_id.to_uri(),
                    position_ms: position_ms.into(),
                    playing: Some(false),
                    seeked: false,
                });
            }
            PlayerEvent::Seeked {
                track_id,
                position_ms,
                ..
            } => (self.emit)(NativeEvent::Position {
                uri: track_id.to_uri(),
                position_ms: position_ms.into(),
                playing: Some(*playing),
                seeked: true,
            }),
            PlayerEvent::PositionChanged {
                track_id,
                position_ms,
                ..
            } => (self.emit)(NativeEvent::Position {
                uri: track_id.to_uri(),
                position_ms: position_ms.into(),
                playing: None,
                seeked: false,
            }),
            PlayerEvent::EndOfTrack { .. } | PlayerEvent::Unavailable { .. } => {
                match self.queue.next(false) {
                    Some(next) => self.load(Some(next), true, 0),
                    None => {
                        *playing = false;
                        self.player.stop();
                        (self.emit)(NativeEvent::Stopped);
                    }
                }
            }
            _ => {}
        }
    }
}

/// A downloaded list's songs stand in for Spotify's while offline.
fn downloaded_page(
    account: &str,
    request: &PlaylistRead,
) -> std::result::Result<Vec<crate::model::Track>, String> {
    let uri = if request.id == "liked" {
        format!("spotify:user:{account}:collection")
    } else {
        format!("spotify:{}", request.id)
    };
    let (_, tracks) = crate::offline_sync::list(account, &uri)
        .ok_or_else(|| "You're offline. Only downloaded playlists and albums open.".to_owned())?;
    Ok(tracks
        .into_iter()
        .skip(request.offset)
        .take(request.limit)
        .collect())
}

/// Plays downloads until Spotify answers again (true) or audio stops (false).
pub(super) async fn run(
    account: &str,
    stopped: &mut oneshot::Receiver<()>,
    channels: PlaybackServices<'_>,
    ready: &AtomicBool,
    emit: &impl Fn(NativeEvent),
) -> bool {
    let PlaybackServices {
        audio_buffer,
        commands,
        playlists,
        metadata,
        latest_volume,
        loaded,
        kept,
        ..
    } = channels;
    crate::offline_sync::publish(account);
    let session = Session::new(session_config(), None);
    if keep_player(kept, &session, audio_buffer).is_err() {
        return true;
    }
    let Some(kit) = kept.as_mut() else {
        return true;
    };
    kit.mixer.set_volume(
        (latest_volume.load(Ordering::Acquire).min(100) * u32::from(u16::MAX) / 100) as u16,
    );
    let mixer = kit.mixer.clone();
    let flush = kit.flush_audio.clone();
    let mut events = kit.player.get_player_event_channel();
    let modes = PlayModes::saved();
    let mut offline = Offline {
        player: kit.player.clone(),
        queue: OfflineQueue::new(
            modes.shuffle,
            Repeat::parse(&modes.repeat),
            crate::offline::now(),
        ),
        emit,
    };
    ready.store(true, Ordering::Release);
    diagnostic("audio offline: playing downloads");
    emit(NativeEvent::Ready(OFFLINE_DEVICE.into()));
    offline.modes();
    let mut playing = false;
    let mut probe = tokio::time::interval(PROBE_EVERY);
    probe.tick().await;
    let online = loop {
        tokio::select! {
            _ = &mut *stopped => break false,
            _ = probe.tick() => {
                if spotify_reachable().await {
                    diagnostic("audio offline: Spotify reachable again");
                    break true;
                }
            }
            action = commands.recv() => match action {
                Some(action) => offline.act(account, action, &mixer, &flush),
                None => break false,
            },
            event = events.recv() => match event {
                Some(event) => {
                    loaded.store(true, Ordering::Release);
                    offline.heard(event, &mut playing);
                }
                None => break false,
            },
            Some(request) = playlists.recv() => {
                let _ = request.reply.send(downloaded_page(account, &request));
            }
            // Other reads need Spotify; dropping them answers "unavailable".
            Some(_) = metadata.recv() => {}
        }
    };
    ready.store(false, Ordering::Release);
    offline.player.stop();
    online
}
