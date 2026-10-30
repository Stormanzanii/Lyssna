//! Following a Spotify Jam as a guest device.
//!
//! Spotify's Jam service drives each guest with Connect `transfer` requests,
//! resent whenever the host skips, seeks, pauses or resumes, and every few
//! seconds in between. A resend for the song already playing must not restart
//! it, so each one is compared with local playback first. Kept free of player
//! and network types so the decision is testable on its own.

use crate::{
    core::{SpotifyId, SpotifyUri},
    protocol::{
        context_page::ContextPage, context_track::ContextTrack, player::PlayerState,
        social_connect_v2::SessionUpdateReason,
    },
};

/// Spotify's Jam service sends guests their transfers from this device ID prefix.
pub const SOCIAL_CONNECT_DEVICE_PREFIX: &str = "social-connect";
/// The context a Jam plays from: the shared queue, which guests receive whole.
pub const JAM_LIST_PREFIX: &str = "spotify:list:jam-list:";

/// Drift tolerated before a guest seeks to the host's position. Transfers
/// arrive with network delay and audio starts with buffering delay, so a
/// tighter bound would make the guest stutter on every resend.
pub const MAX_DRIFT_MS: i64 = 2_000;

/// Whether a transfer comes from Spotify's Jam service rather than a
/// listener moving playback with Connect.
pub fn is_jam_transfer(sent_by_device_id: &str, context_uri: Option<&str>) -> bool {
    sent_by_device_id.starts_with(SOCIAL_CONNECT_DEVICE_PREFIX)
        || context_uri.is_some_and(|uri| uri.starts_with(JAM_LIST_PREFIX))
}

/// What a player state tells Spotify's Jam service, for comparing this
/// device's host state with the official app's: the kind of context, the
/// origin, modes and the names of metadata keys. IDs and values are left
/// out, apart from the origin's feature names and the modes.
pub fn state_summary(state: &PlayerState, jam_session: Option<&str>) -> String {
    let kind = |uri: &str| -> String {
        uri.split(':')
            .skip(1)
            .filter(|part| {
                !part.is_empty()
                    && part.len() <= 16
                    && part
                        .bytes()
                        .all(|byte| byte.is_ascii_lowercase() || byte == b'-')
            })
            .collect::<Vec<_>>()
            .join(":")
    };
    let keys = |map: &std::collections::HashMap<String, String>| {
        let mut keys: Vec<&str> = map.keys().map(String::as_str).collect();
        keys.sort_unstable();
        keys.join(",")
    };
    let origin = state.play_origin.as_ref();
    let modes = state.options.as_ref().map(|options| {
        let mut modes: Vec<String> = options
            .modes
            .iter()
            .map(|(key, value)| format!("{key}={value}"))
            .collect();
        modes.sort_unstable();
        modes.join(",")
    });
    let track = state.track.as_ref();
    let mut next_keys: Vec<&str> = state
        .next_tracks
        .iter()
        .take(3)
        .flat_map(|track| track.metadata.keys().map(String::as_str))
        .collect();
    next_keys.sort_unstable();
    next_keys.dedup();
    format!(
        "paused={} context={} origin={}/{} session={}{} playback_id={} queue_revision={} modes=[{}]          context_meta=[{}] page_meta=[{}] track_provider={} track_meta=[{}] next_meta=[{}]          signals={} command_id={} system={}",
        state.is_paused,
        kind(&state.context_uri),
        origin.map_or("", |origin| origin.feature_identifier.as_str()),
        origin.map_or("", |origin| origin.referrer_identifier.as_str()),
        state.session_id.len(),
        jam_session.map_or(String::new(), |jam| format!(
            " is_jam_session={}",
            state.session_id == jam
        )),
        !state.playback_id.is_empty(),
        !state.queue_revision.is_empty(),
        modes.unwrap_or_default(),
        keys(&state.context_metadata),
        keys(&state.page_metadata),
        track.map_or("", |track| track.provider.as_str()),
        track.map_or(String::new(), |track| keys(&track.metadata)),
        next_keys.join(","),
        state.signals.len(),
        !state.session_command_id.is_empty(),
        state.is_system_initiated,
    )
}

/// The host's song in a Jam transfer, with its URI. Transfers built from the
/// Jam's shared queue (`jam-list`) name the song only by its queue entry
/// UID, so the URI comes from that entry in the queue, or else its GID.
pub fn host_track(
    current: Option<ContextTrack>,
    current_uid: Option<&str>,
    pages: &[ContextPage],
) -> Option<ContextTrack> {
    let mut track = current.unwrap_or_default();
    if track.uri.as_deref().is_some_and(|uri| !uri.is_empty()) {
        return Some(track);
    }
    let uid = track
        .uid
        .clone()
        .filter(|uid| !uid.is_empty())
        .or_else(|| current_uid.filter(|uid| !uid.is_empty()).map(str::to_owned));
    let entry = uid.as_deref().and_then(|uid| {
        pages
            .iter()
            .flat_map(|page| &page.tracks)
            .find(|entry| entry.uid.as_deref() == Some(uid))
    });
    if let Some(entry) = entry {
        track.uri = entry.uri.clone().filter(|uri| !uri.is_empty());
        if track.gid.as_ref().is_none_or(Vec::is_empty) {
            track.gid = entry.gid.clone();
        }
        track.uid = entry.uid.clone();
        for (key, value) in &entry.metadata {
            track
                .metadata
                .entry(key.clone())
                .or_insert_with(|| value.clone());
        }
    }
    if track.uri.as_deref().is_none_or(str::is_empty) {
        track.uri = track
            .gid
            .as_deref()
            .filter(|gid| !gid.is_empty())
            .and_then(|gid| SpotifyId::from_raw(gid).ok())
            .map(|id| SpotifyUri::Track { id }.to_uri());
    }
    track
        .uri
        .as_deref()
        .is_some_and(|uri| !uri.is_empty())
        .then_some(track)
}

/// What this device is playing.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct LocalPlayback<'a> {
    /// The loaded track, or `None` when stopped.
    pub uri: Option<&'a str>,
    pub uid: Option<&'a str>,
    pub position_ms: u32,
    pub playing: bool,
}

/// What the host is playing, as a Jam transfer describes it.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct HostPlayback<'a> {
    pub uri: Option<&'a str>,
    pub uid: Option<&'a str>,
    /// Spotify's clock when `position_ms` was measured.
    pub timestamp_ms: i64,
    pub position_ms: u32,
    pub paused: bool,
}

impl HostPlayback<'_> {
    /// Where the host is at `server_now_ms`, by Spotify's clock.
    pub fn expected_position_ms(&self, server_now_ms: i64) -> u32 {
        let position = i64::from(self.position_ms);
        let position = if self.paused || self.timestamp_ms <= 0 {
            position
        } else {
            position + server_now_ms.saturating_sub(self.timestamp_ms).max(0)
        };
        position.clamp(0, i64::from(u32::MAX)) as u32
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Plan {
    /// Keep the loaded song; seek or change pause state where given.
    Continue {
        seek_ms: Option<u32>,
        pause: Option<bool>,
    },
    /// Load the host's song at its position.
    Load {
        uri: String,
        uid: Option<String>,
        position_ms: u32,
        play: bool,
    },
    /// Nothing to follow: the transfer names no song.
    Ignore,
}

fn present(value: Option<&str>) -> Option<&str> {
    value.filter(|value| !value.is_empty())
}

/// How a guest follows one Jam transfer.
pub fn plan(local: LocalPlayback, host: HostPlayback, server_now_ms: i64) -> Plan {
    let Some(uri) = present(host.uri) else {
        return Plan::Ignore;
    };
    let expected = host.expected_position_ms(server_now_ms);
    let host_uid = present(host.uid);
    // A song queued twice is two entries with one URI; the UID tells them
    // apart. When either side lacks one, the URI decides.
    let same_entry = present(local.uri) == Some(uri)
        && match (present(local.uid), host_uid) {
            (Some(local), Some(host)) => local == host,
            _ => true,
        };
    if !same_entry {
        return Plan::Load {
            uri: uri.to_owned(),
            uid: host_uid.map(str::to_owned),
            position_ms: expected,
            play: !host.paused,
        };
    }
    let drift = (i64::from(local.position_ms) - i64::from(expected)).abs();
    Plan::Continue {
        seek_ms: (drift >= MAX_DRIFT_MS).then_some(expected),
        pause: (local.playing == host.paused).then_some(host.paused),
    }
}

/// Whether this device follows Jam transfers.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum JamPhase {
    /// Not in a Jam yet; a Jam transfer starts following.
    #[default]
    Idle,
    /// Playing along with a Jam's host.
    Following,
    /// Left, was removed from, or saw the end of a Jam. Late transfers from
    /// it are ignored until this device joins a Jam again.
    Left,
}

impl JamPhase {
    /// Whether a Jam transfer should drive playback.
    pub fn follows_transfers(self) -> bool {
        self != JamPhase::Left
    }

    /// The phase after Spotify reports a change to this account's Jam.
    pub fn after_session_update(self, reason: SessionUpdateReason) -> JamPhase {
        use SessionUpdateReason::*;
        match reason {
            YOU_LEFT | YOU_WERE_KICKED | SESSION_DELETED => JamPhase::Left,
            YOU_JOINED | NEW_SESSION if self == JamPhase::Left => JamPhase::Idle,
            _ => self,
        }
    }

    /// The phase after Spotify switches the Jam mode for this device.
    pub fn after_jam_mode(self, on: bool) -> JamPhase {
        if on {
            JamPhase::Following
        } else {
            JamPhase::Left
        }
    }

    pub(crate) fn to_u8(self) -> u8 {
        match self {
            JamPhase::Idle => 0,
            JamPhase::Following => 1,
            JamPhase::Left => 2,
        }
    }

    pub(crate) fn from_u8(value: u8) -> JamPhase {
        match value {
            1 => JamPhase::Following,
            2 => JamPhase::Left,
            _ => JamPhase::Idle,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_jam_list_transfer_finds_the_hosts_song_by_its_queue_entry() {
        let entry = |uri: &str, uid: &str| ContextTrack {
            uri: Some(uri.into()),
            uid: Some(uid.into()),
            ..Default::default()
        };
        let pages = vec![ContextPage {
            tracks: vec![
                entry("spotify:track:aaaaaaaaaaaaaaaaaaaaaa", "u1"),
                entry("spotify:track:bbbbbbbbbbbbbbbbbbbbbb", "u2"),
            ],
            ..Default::default()
        }];
        // Only the UID in the current track.
        let current = ContextTrack {
            uid: Some("u2".into()),
            ..Default::default()
        };
        let found = host_track(Some(current), None, &pages).unwrap();
        assert_eq!(
            found.uri.as_deref(),
            Some("spotify:track:bbbbbbbbbbbbbbbbbbbbbb")
        );
        // No current track, only the session's current UID.
        let found = host_track(None, Some("u1"), &pages).unwrap();
        assert_eq!(
            found.uri.as_deref(),
            Some("spotify:track:aaaaaaaaaaaaaaaaaaaaaa")
        );
        // A URI given is kept; nothing to find is nothing to follow.
        let given = entry("spotify:track:cccccccccccccccccccccc", "u9");
        assert_eq!(host_track(Some(given.clone()), None, &pages), Some(given));
        assert_eq!(host_track(None, Some("missing"), &pages), None);
        // Only a GID: the URI comes from it.
        let gid = ContextTrack {
            gid: Some(vec![0; 16]),
            ..Default::default()
        };
        assert!(
            host_track(Some(gid), None, &[])
                .unwrap()
                .uri
                .unwrap()
                .starts_with("spotify:track:")
        );
    }

    #[test]
    fn a_state_summary_names_kinds_and_keys_but_no_ids() {
        let mut state = PlayerState {
            context_uri: "spotify:user:abc123xyz:collection".into(),
            session_id: "jam0123".into(),
            ..Default::default()
        };
        state
            .context_metadata
            .insert("is_jam_queue".into(), "secret-value".into());
        let summary = state_summary(&state, Some("jam0123"));
        assert!(summary.contains("context=user:collection"), "{summary}");
        assert!(summary.contains("is_jam_session=true"), "{summary}");
        assert!(summary.contains("context_meta=[is_jam_queue]"), "{summary}");
        assert!(!summary.contains("abc123xyz") && !summary.contains("secret-value"));
    }

    const SONG: &str = "spotify:track:0000000000000000000001";
    const OTHER: &str = "spotify:track:0000000000000000000002";

    fn local(position_ms: u32, playing: bool) -> LocalPlayback<'static> {
        LocalPlayback {
            uri: Some(SONG),
            uid: Some("a"),
            position_ms,
            playing,
        }
    }

    fn host(position_ms: u32, timestamp_ms: i64, paused: bool) -> HostPlayback<'static> {
        HostPlayback {
            uri: Some(SONG),
            uid: Some("a"),
            timestamp_ms,
            position_ms,
            paused,
        }
    }

    #[test]
    fn a_resend_for_the_playing_song_within_drift_changes_nothing() {
        assert_eq!(
            plan(local(31_500, true), host(30_000, 10_000, false), 11_000),
            Plan::Continue {
                seek_ms: None,
                pause: None
            }
        );
    }

    #[test]
    fn drift_past_two_seconds_seeks_to_the_hosts_position_now() {
        assert_eq!(
            plan(local(10_000, true), host(30_000, 10_000, false), 12_500),
            Plan::Continue {
                seek_ms: Some(32_500),
                pause: None
            }
        );
        // Exactly the bound seeks too.
        assert_eq!(
            plan(local(30_000, true), host(32_000, 10_000, false), 10_000),
            Plan::Continue {
                seek_ms: Some(32_000),
                pause: None
            }
        );
    }

    #[test]
    fn a_paused_host_is_not_extrapolated_and_pauses_the_guest() {
        assert_eq!(
            plan(local(30_400, true), host(30_000, 10_000, true), 60_000),
            Plan::Continue {
                seek_ms: None,
                pause: Some(true)
            }
        );
        assert_eq!(
            plan(local(90_000, true), host(30_000, 10_000, true), 60_000),
            Plan::Continue {
                seek_ms: Some(30_000),
                pause: Some(true)
            }
        );
    }

    #[test]
    fn a_resuming_host_resumes_a_paused_guest() {
        assert_eq!(
            plan(local(30_000, false), host(30_000, 10_000, false), 10_100),
            Plan::Continue {
                seek_ms: None,
                pause: Some(false)
            }
        );
    }

    #[test]
    fn another_song_loads_at_the_hosts_position() {
        let mut next = host(1_000, 10_000, false);
        next.uri = Some(OTHER);
        next.uid = Some("b");
        assert_eq!(
            plan(local(30_000, true), next, 10_500),
            Plan::Load {
                uri: OTHER.into(),
                uid: Some("b".into()),
                position_ms: 1_500,
                play: true
            }
        );
    }

    #[test]
    fn the_same_song_queued_again_loads_as_a_new_entry() {
        let mut again = host(0, 10_000, true);
        again.uid = Some("b");
        assert_eq!(
            plan(local(200_000, true), again, 10_500),
            Plan::Load {
                uri: SONG.into(),
                uid: Some("b".into()),
                position_ms: 0,
                play: false
            }
        );
    }

    #[test]
    fn a_missing_uid_compares_by_uri() {
        let mut no_uid = host(30_000, 10_000, false);
        no_uid.uid = None;
        assert!(matches!(
            plan(local(30_000, true), no_uid, 10_000),
            Plan::Continue { seek_ms: None, .. }
        ));
    }

    #[test]
    fn a_stopped_guest_loads_the_hosts_song() {
        assert!(matches!(
            plan(LocalPlayback::default(), host(5_000, 10_000, false), 10_000),
            Plan::Load {
                position_ms: 5_000,
                play: true,
                ..
            }
        ));
    }

    #[test]
    fn a_transfer_without_a_song_is_ignored() {
        let mut empty = host(0, 0, false);
        empty.uri = None;
        assert_eq!(plan(local(0, true), empty, 0), Plan::Ignore);
        empty.uri = Some("");
        assert_eq!(plan(local(0, true), empty, 0), Plan::Ignore);
    }

    #[test]
    fn a_host_timestamp_ahead_of_our_clock_does_not_rewind() {
        assert_eq!(
            host(30_000, 20_000, false).expected_position_ms(10_000),
            30_000
        );
    }

    #[test]
    fn jam_transfers_are_told_apart_from_connect_transfers() {
        assert!(is_jam_transfer("social-connect-0123abcd", None));
        assert!(is_jam_transfer(
            "0123abcd",
            Some("spotify:list:jam-list:0123abcd")
        ));
        assert!(!is_jam_transfer(
            "0123abcd",
            Some("spotify:playlist:0000000000000000000001")
        ));
        assert!(!is_jam_transfer("0123abcd", None));
    }

    #[test]
    fn leaving_or_an_ended_jam_stops_following_until_joining_again() {
        use SessionUpdateReason::*;
        for reason in [YOU_LEFT, YOU_WERE_KICKED, SESSION_DELETED] {
            let phase = JamPhase::Following.after_session_update(reason);
            assert_eq!(phase, JamPhase::Left, "{reason:?}");
            assert!(!phase.follows_transfers());
        }
        for reason in [USER_JOINED, USER_LEFT, UNKNOWN_UPDATE_TYPE] {
            assert_eq!(JamPhase::Left.after_session_update(reason), JamPhase::Left);
            assert_eq!(
                JamPhase::Following.after_session_update(reason),
                JamPhase::Following
            );
        }
        assert_eq!(
            JamPhase::Left.after_session_update(YOU_JOINED),
            JamPhase::Idle
        );
        assert!(JamPhase::Idle.follows_transfers());
        assert_eq!(JamPhase::Following.after_jam_mode(false), JamPhase::Left);
        assert_eq!(JamPhase::Left.after_jam_mode(true), JamPhase::Following);
        for phase in [JamPhase::Idle, JamPhase::Following, JamPhase::Left] {
            assert_eq!(JamPhase::from_u8(phase.to_u8()), phase);
        }
    }
}
