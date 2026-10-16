use std::{
    sync::{Arc, mpsc},
    thread,
    time::Duration,
};

use librespot_connect::{ConnectConfig, Spirc};
use librespot_core::{Session, authentication::Credentials, config::SessionConfig};
use librespot_playback::{
    audio_backend,
    config::{AudioFormat, PlayerConfig},
    mixer::{Mixer, MixerConfig, softmixer::SoftMixer},
    player::{Player, PlayerEvent},
};
use tokio::sync::oneshot;

pub enum NativeEvent {
    Ready(String),
    Position {
        uri: String,
        position_ms: u64,
        playing: Option<bool>,
    },
    Error(String),
}

pub struct NativePlayer {
    stop: Option<oneshot::Sender<()>>,
}

impl NativePlayer {
    pub fn start(
        client_id: String,
        access_token: String,
        events: mpsc::Sender<NativeEvent>,
        repaint: eframe::egui::Context,
    ) -> Self {
        let (stop, mut stopped) = oneshot::channel();
        thread::spawn(move || {
            let emit = |event| {
                let _ = events.send(event);
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
            runtime.block_on(async {
                let session = Session::new(SessionConfig { client_id, ..SessionConfig::default() }, None);
                let mixer = match SoftMixer::open(MixerConfig::default()) {
                    Ok(mixer) => Arc::new(mixer),
                    Err(_) => { emit(NativeEvent::Error("Cannot initialize audio mixer".into())); return; }
                };
                let Some(backend) = audio_backend::find(Some("rodio".into())) else {
                    emit(NativeEvent::Error("Native audio backend missing".into())); return;
                };
                let player = Player::new(PlayerConfig::default(), session.clone(), mixer.get_soft_volume(), move || backend(None, AudioFormat::F32));
                let mut player_events = player.get_player_event_channel();
                let connection = tokio::select! {
                    _ = &mut stopped => { session.shutdown(); return; }
                    result = tokio::time::timeout(Duration::from_secs(40), Spirc::new(ConnectConfig { name: "SpotiFlex".into(), ..ConnectConfig::default() }, session.clone(), Credentials::with_access_token(access_token), player, mixer)) => result,
                };
                let (spirc, task) = match connection {
                    Ok(Ok(connection)) => connection,
                    _ => {
                        emit(NativeEvent::Error("Native audio could not connect. Check Premium and streaming access; retry from Settings. Other Spotify devices remain available.".into()));
                        session.shutdown();
                        return;
                    }
                };
                emit(NativeEvent::Ready(session.device_id().to_owned()));
                tokio::pin!(task);
                loop {
                    tokio::select! {
                        _ = &mut stopped => {
                            let _ = spirc.shutdown();
                            let _ = tokio::time::timeout(Duration::from_secs(2), &mut task).await;
                            break;
                        }
                        _ = &mut task => { emit(NativeEvent::Error("Native audio disconnected. Retry from Settings.".into())); break; }
                        event = player_events.recv() => {
                            match event {
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
            });
        });
        Self { stop: Some(stop) }
    }
}

impl Drop for NativePlayer {
    fn drop(&mut self) {
        if let Some(stop) = self.stop.take() {
            let _ = stop.send(());
        }
    }
}
