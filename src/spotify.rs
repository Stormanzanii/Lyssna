//! Account-scoped Spotify access. Native sessions never fall back to the Web API.
use std::sync::{
    Arc,
    atomic::{AtomicBool, Ordering},
};

use anyhow::{Result, ensure};
use reqwest::blocking::Client;

use crate::{
    api::{self, PlayerAction},
    auth::Tokens,
    model::{Artist, BrowseInfo, Device, Playback, Playlist, Profile, Track},
    native::NativeControls,
};

#[derive(Clone)]
enum Access {
    Native {
        controls: NativeControls,
        profile: Profile,
    },
    Developer(api::Spotify),
}

#[derive(Clone)]
pub struct Spotify {
    pub client: Client,
    access: Access,
    active: Arc<AtomicBool>,
}

macro_rules! dispatch {
    ($this:ident, $native:ident => $body:expr, $method:ident($($argument:expr),* $(,)?)) => {{
        $this.check_active()?;
        match &mut $this.access {
            Access::Native { controls: $native, .. } => $body,
            Access::Developer(api) => api.$method($($argument),*),
        }
    }};
}

impl Spotify {
    pub fn new(client: Client, client_id: String, tokens: Tokens) -> Self {
        Self {
            client: client.clone(),
            access: Access::Developer(api::Spotify::new(client, client_id, tokens)),
            active: Arc::new(AtomicBool::new(true)),
        }
    }

    pub fn native(client: Client, controls: NativeControls, profile: Profile) -> Result<Self> {
        let controls = controls.scoped(&profile.id)?;
        Ok(Self {
            client,
            access: Access::Native { controls, profile },
            active: Arc::new(AtomicBool::new(true)),
        })
    }

    fn check_active(&self) -> Result<()> {
        ensure!(
            self.active.load(Ordering::Acquire),
            "Spotify account signed out"
        );
        Ok(())
    }

    pub fn is_native(&self) -> bool {
        matches!(self.access, Access::Native { .. })
    }

    pub fn account(&self) -> Option<&str> {
        match &self.access {
            Access::Native { profile, .. } => Some(&profile.id),
            Access::Developer(api) => api
                .tokens
                .profile
                .as_ref()
                .map(|profile| profile.id.as_str()),
        }
    }

    pub fn save_profile(&mut self, profile: Profile) -> Result<()> {
        self.check_active()?;
        match &mut self.access {
            Access::Native {
                profile: current, ..
            } => {
                ensure!(current.id == profile.id, "Spotify account changed");
                *current = profile;
            }
            Access::Developer(api) => {
                api.tokens.profile = Some(profile);
                api.tokens.save(&api.client_id)?;
            }
        }
        Ok(())
    }

    pub fn refresh_credentials(&mut self) -> Result<()> {
        self.check_active()?;
        if let Access::Developer(api) = &mut self.access {
            api.tokens.refresh_if_needed(&api.client, &api.client_id)?;
        }
        Ok(())
    }

    pub fn provider_token(&mut self) -> Result<String> {
        self.refresh_credentials()?;
        match &self.access {
            Access::Native { controls, .. } => controls.provider_token(),
            Access::Developer(api) => Ok(api.tokens.access_token.clone()),
        }
    }

    pub fn background(&self) -> Self {
        let mut value = self.clone();
        if let Access::Developer(api) = &self.access {
            value.access = Access::Developer(api.background());
        }
        value
    }

    pub fn cancel_background(&self) {
        self.active.store(false, Ordering::Release);
        if let Access::Developer(api) = &self.access {
            api.cancel_background();
        }
    }

    pub fn cooling_down(&self) -> bool {
        matches!(&self.access, Access::Developer(api) if api.cooling_down())
    }

    #[cfg(test)]
    pub(crate) fn count_network_attempts(&mut self) -> Arc<std::sync::atomic::AtomicUsize> {
        match &mut self.access {
            Access::Developer(api) => api.count_network_attempts(),
            Access::Native { .. } => Arc::new(Default::default()),
        }
    }

    pub fn profile(&mut self) -> Result<Profile> {
        self.check_active()?;
        match &mut self.access {
            Access::Native { profile, .. } => Ok(profile.clone()),
            Access::Developer(api) => api.profile(),
        }
    }

    pub fn playback(&mut self) -> Result<Playback> {
        dispatch!(self, native => native.remote_playback(), playback())
    }
    pub fn devices(&mut self) -> Result<Vec<Device>> {
        dispatch!(self, native => native.devices(), devices())
    }
    pub fn playlists(&mut self) -> Result<Vec<Playlist>> {
        dispatch!(self, native => native.library().map(|value| value.0), playlists())
    }
    pub fn search(&mut self, query: &str) -> Result<Vec<Track>> {
        dispatch!(self, native => native.playlist_tracks(&format!("search:{query}"), 0), search(query))
    }
    pub fn search_catalogue(&mut self, query: &str) -> Result<crate::search::SearchResults> {
        dispatch!(self, native => native.search_catalogue(query), search_catalogue(query))
    }
    pub fn search_playlists(&mut self, query: &str) -> Result<Vec<Playlist>> {
        dispatch!(self, native => native.search_playlists(query), search_playlists(query))
    }
    pub fn saved_tracks(&mut self, offset: usize) -> Result<Vec<Track>> {
        dispatch!(self, native => native.playlist_tracks("liked", offset), saved_tracks(offset))
    }
    pub fn recent(&mut self) -> Result<Vec<Track>> {
        dispatch!(self, native => native.recent(), recent())
    }
    pub fn last_played(&mut self) -> Result<Option<crate::resume::LastPlayed>> {
        self.check_active()?;
        match &mut self.access {
            Access::Developer(api) => api.last_played(),
            Access::Native { controls, .. } => {
                Ok(controls.recent()?.into_iter().next().map(|track| {
                    let played_at = time::OffsetDateTime::parse(
                        &track.added_at,
                        &time::format_description::well_known::Rfc3339,
                    )
                    .map(|value| (value.unix_timestamp_nanos() / 1_000_000).max(0) as u64)
                    .unwrap_or(0);
                    crate::resume::LastPlayed {
                        track,
                        played_at,
                        position_ms: 0,
                        queue: Vec::new(),
                        dj_context: None,
                        context: None,
                        queued: Vec::new(),
                    }
                }))
            }
        }
    }
    pub fn playlist_tracks(&mut self, id: &str, offset: usize) -> Result<Vec<Track>> {
        dispatch!(self, native => native.playlist_tracks(id, offset), playlist_tracks(id, offset))
    }
    pub fn queue(&mut self) -> Result<Vec<Track>> {
        dispatch!(self, native => native.remote_queue(), queue())
    }
    pub fn artist(&mut self, id: &str) -> Result<Artist> {
        let client = self.client.clone();
        dispatch!(self, native => native.catalogue("artist", id, 0).and_then(|entity| crate::catalogue::base_info(&entity, "artist", id)?.artist.ok_or_else(|| anyhow::anyhow!("Artist unavailable"))).or_else(|_| crate::artist::basic(&client, id)), artist(id))
    }
    pub fn track(&mut self, uri: &str) -> Result<Track> {
        dispatch!(self, native => native.track(uri), track(uri))
    }
    pub fn browse_info(&mut self, key: &str) -> Result<BrowseInfo> {
        dispatch!(self, native => {
            if let Some(id) = key.strip_prefix("playlist:") { native.playlist_info(id) }
            else { let (kind, id) = key.split_once(':').ok_or_else(|| anyhow::anyhow!("Unknown page"))?; native.catalogue(kind, id, 0).and_then(|entity| crate::catalogue::base_info(&entity, kind, id)) }
        }, browse_info(key))
    }
    pub fn album_tracks(&mut self, id: &str, offset: usize) -> Result<Vec<Track>> {
        dispatch!(self, native => native.playlist_tracks(&format!("album:{id}"), offset), album_tracks(id, offset))
    }
    pub fn saved_item(&mut self, uri: &str) -> Result<bool> {
        dispatch!(self, native => native.saved_items(&[uri.into()]).map(|values| values.first().copied().unwrap_or(false)), saved_item(uri))
    }
    pub fn saved_items(&mut self, uris: &[String]) -> Result<Vec<bool>> {
        dispatch!(self, native => native.saved_items(uris), saved_items(uris))
    }
    pub fn set_saved_item(&mut self, uri: &str, saved: bool) -> Result<()> {
        dispatch!(self, native => native.set_saved(uri, saved), set_saved_item(uri, saved))
    }
    pub fn save_track(&mut self, uri: &str) -> Result<()> {
        dispatch!(self, native => native.set_saved(uri, true), save_track(uri))
    }
    pub fn player_action(&mut self, action: PlayerAction, device: Option<&str>) -> Result<()> {
        dispatch!(self, native => native.remote_action(action, device), player_action(action, device))
    }
    pub fn add_to_playlist(&mut self, id: &str, tracks: &[Track]) -> Result<usize> {
        dispatch!(self, native => match native.add_to_playlist(id, tracks)? { crate::native_browse::Added::Count(count) => Ok(count), crate::native_browse::Added::NotWritten(error) => Err(error) }, add_to_playlist(id, tracks))
    }
}

#[cfg(test)]
mod native_tests {
    use super::*;

    fn native_account(account: &str) -> Spotify {
        let (controls, _) = NativeControls::test_active(account);
        Spotify::native(
            Client::new(),
            controls,
            Profile {
                id: account.into(),
                ..Default::default()
            },
        )
        .unwrap()
    }

    #[test]
    fn native_access_requires_matching_account_and_revokes_background_work() {
        let (controls, _) = NativeControls::test_active("alice");
        assert!(
            Spotify::native(
                Client::new(),
                controls,
                Profile {
                    id: "bob".into(),
                    ..Default::default()
                }
            )
            .is_err()
        );
        let spotify = native_account("alice");
        let mut background = spotify.background();
        assert!(background.is_native());
        assert_eq!(background.account(), Some("alice"));
        spotify.cancel_background();
        assert!(
            background
                .profile()
                .err()
                .unwrap()
                .to_string()
                .contains("signed out")
        );
        assert!(background.refresh_credentials().is_err());
        assert!(background.provider_token().is_err());
    }

    #[test]
    fn disconnected_native_access_does_not_retry_using_web_api() {
        let mut spotify = native_account("alice");
        spotify.refresh_credentials().unwrap();
        assert!(spotify.saved_tracks(0).is_err());
        assert!(spotify.search_catalogue("example").is_err());
        assert!(
            spotify
                .saved_items(&["spotify:track:0123456789abcdefghijkl".into()])
                .is_err()
        );
        assert!(
            spotify
                .set_saved_item("spotify:track:0123456789abcdefghijkl", true)
                .is_err()
        );
        assert!(spotify.provider_token().is_err());
        assert!(spotify.is_native());
    }
}
