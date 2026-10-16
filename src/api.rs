use std::{
    collections::HashSet,
    time::{Duration, Instant},
};

use anyhow::{Context, Result, bail, ensure};
use reqwest::{Method, StatusCode, blocking::Client};
use serde::de::DeserializeOwned;
use serde_json::{Value, json};
use url::Url;

use crate::{
    auth::Tokens,
    model::{Device, Playback, Playlist, Profile, Track, unique_additions},
};

pub struct Spotify {
    pub client: Client,
    pub client_id: String,
    pub tokens: Tokens,
    retry_after: Option<Instant>,
}

impl Spotify {
    pub fn new(client: Client, client_id: String, tokens: Tokens) -> Self {
        Self {
            client,
            client_id,
            tokens,
            retry_after: None,
        }
    }

    fn request(
        &mut self,
        method: Method,
        path: &str,
        query: &[(&str, String)],
        body: Option<Value>,
    ) -> Result<Value> {
        if let Some(until) = self.retry_after.filter(|until| *until > Instant::now()) {
            bail!(
                "Spotify rate limit: retry in {} seconds",
                until.duration_since(Instant::now()).as_secs() + 1
            );
        }
        self.tokens
            .refresh_if_needed(&self.client, &self.client_id)?;
        let url = if path.starts_with("https://") {
            Url::parse(path)?
        } else {
            Url::parse(&format!("https://api.spotify.com/v1/{path}"))?
        };
        ensure!(
            url.scheme() == "https"
                && url.host_str() == Some("api.spotify.com")
                && url.port_or_known_default() == Some(443)
                && url.path().starts_with("/v1/")
                && url.username().is_empty()
                && url.password().is_none(),
            "Rejected unexpected Spotify API URL"
        );
        for attempt in 0..2 {
            let mut request = self
                .client
                .request(method.clone(), url.clone())
                .query(query)
                .bearer_auth(&self.tokens.access_token);
            if let Some(body) = &body {
                request = request.json(body);
            }
            let response = request
                .send()
                .map_err(|_| anyhow::anyhow!("Cannot reach Spotify. Check your connection."))?;
            match response.status() {
                StatusCode::UNAUTHORIZED if attempt == 0 => {
                    self.tokens.expires_at = 0;
                    self.tokens
                        .refresh_if_needed(&self.client, &self.client_id)?;
                    continue;
                }
                StatusCode::NO_CONTENT => return Ok(Value::Null),
                StatusCode::TOO_MANY_REQUESTS => {
                    let seconds = response
                        .headers()
                        .get("retry-after")
                        .and_then(|header| header.to_str().ok())
                        .and_then(|value| value.parse::<u64>().ok())
                        .unwrap_or(30)
                        .clamp(1, 86_400);
                    self.retry_after = Some(Instant::now() + Duration::from_secs(seconds));
                    bail!("Spotify rate limit: retry in {seconds} seconds");
                }
                StatusCode::FORBIDDEN => bail!(
                    "Spotify denied this action. Check Premium, Developer Dashboard access, and playlist ownership."
                ),
                StatusCode::NOT_FOUND => bail!(
                    "Spotify could not find this item or an active playback device. Select a device and retry."
                ),
                status if !status.is_success() => {
                    bail!("Spotify request failed (HTTP {})", status.as_u16())
                }
                _ => {}
            }
            let bytes = response.bytes()?;
            if bytes.is_empty() {
                return Ok(Value::Null);
            }
            return serde_json::from_slice(&bytes).context("Spotify returned invalid JSON");
        }
        bail!("Spotify login expired. Sign in again.")
    }

    fn get<T: DeserializeOwned>(&mut self, path: &str, query: &[(&str, String)]) -> Result<T> {
        serde_json::from_value(self.request(Method::GET, path, query, None)?)
            .context("Unexpected Spotify response format")
    }

    pub fn profile(&mut self) -> Result<Profile> {
        self.get("me", &[])
    }

    pub fn playback(&mut self) -> Result<Playback> {
        let response = self.request(Method::GET, "me/player", &[], None)?;
        if response.is_null() {
            return Ok(Playback::default());
        }
        serde_json::from_value(response).context("Cannot read Spotify playback state")
    }

    pub fn devices(&mut self) -> Result<Vec<Device>> {
        let response = self.request(Method::GET, "me/player/devices", &[], None)?;
        Ok(serde_json::from_value(response["devices"].clone())?)
    }

    pub fn playlists(&mut self) -> Result<Vec<Playlist>> {
        let mut playlists = Vec::new();
        let mut next = Some("https://api.spotify.com/v1/me/playlists?limit=50".to_owned());
        let mut visited = HashSet::new();
        while let Some(path) = next {
            ensure!(
                visited.insert(path.clone()),
                "Spotify repeated a playlist page"
            );
            let page = self.request(Method::GET, &path, &[], None)?;
            for item in page["items"]
                .as_array()
                .context("Playlist page has no items")?
            {
                if !item.is_null() {
                    playlists.push(serde_json::from_value(item.clone())?);
                }
            }
            next = page["next"].as_str().map(str::to_owned);
        }
        Ok(playlists)
    }

    pub fn search(&mut self, text: &str) -> Result<Vec<Track>> {
        let response = self.request(
            Method::GET,
            "search",
            &[
                ("q", text.to_owned()),
                ("type", "track".into()),
                ("limit", "10".into()),
            ],
            None,
        )?;
        Ok(serde_json::from_value(response["tracks"]["items"].clone())?)
    }

    pub fn saved_tracks(&mut self, offset: usize) -> Result<Vec<Track>> {
        let response = self.request(
            Method::GET,
            "me/tracks",
            &[("limit", "50".into()), ("offset", offset.to_string())],
            None,
        )?;
        parse_track_items(&response)
    }

    pub fn recent(&mut self) -> Result<Vec<Track>> {
        let response = self.request(
            Method::GET,
            "me/player/recently-played",
            &[("limit", "30".into())],
            None,
        )?;
        parse_track_items(&response)
    }

    pub fn playlist_tracks(&mut self, playlist_id: &str, offset: usize) -> Result<Vec<Track>> {
        ensure!(valid_id(playlist_id), "Invalid playlist ID");
        let response = self.request(
            Method::GET,
            &format!("playlists/{playlist_id}/items"),
            &[("limit", "50".into()), ("offset", offset.to_string())],
            None,
        )?;
        parse_track_items(&response)
    }

    pub fn queue(&mut self) -> Result<Vec<Track>> {
        let response = self.request(Method::GET, "me/player/queue", &[], None)?;
        let mut tracks = Vec::new();
        for item in response["queue"].as_array().context("Queue has no items")? {
            if item["type"].as_str() == Some("track") {
                tracks.push(serde_json::from_value(item.clone())?);
            }
        }
        Ok(tracks)
    }

    pub fn player_action(&mut self, action: PlayerAction, device: Option<&str>) -> Result<()> {
        let mut query = Vec::new();
        if let Some(device) = device {
            query.push(("device_id", device.to_owned()));
        }
        let (method, endpoint, body) = match action {
            PlayerAction::Play(uri) => (
                Method::PUT,
                "play",
                Some(uri.map_or(json!({}), |uri| json!({"uris":[uri]}))),
            ),
            PlayerAction::Pause => (Method::PUT, "pause", None),
            PlayerAction::Next => (Method::POST, "next", None),
            PlayerAction::Previous => (Method::POST, "previous", None),
            PlayerAction::Seek(position) => {
                query.push(("position_ms", position.to_string()));
                (Method::PUT, "seek", None)
            }
            PlayerAction::Volume(volume) => {
                query.push(("volume_percent", volume.min(100).to_string()));
                (Method::PUT, "volume", None)
            }
            PlayerAction::Shuffle(state) => {
                query.push(("state", state.to_string()));
                (Method::PUT, "shuffle", None)
            }
            PlayerAction::Repeat(state) => {
                ensure!(
                    ["off", "context", "track"].contains(&state.as_str()),
                    "Invalid repeat state"
                );
                query.push(("state", state));
                (Method::PUT, "repeat", None)
            }
            PlayerAction::Enqueue(uri) => {
                query.push(("uri", uri));
                (Method::POST, "queue", None)
            }
            PlayerAction::Transfer(id) => {
                self.request(
                    Method::PUT,
                    "me/player",
                    &[],
                    Some(json!({"device_ids":[id],"play":false})),
                )?;
                return Ok(());
            }
        };
        self.request(method, &format!("me/player/{endpoint}"), &query, body)?;
        Ok(())
    }

    pub fn save_track(&mut self, uri: &str) -> Result<()> {
        self.request(Method::PUT, "me/library", &[("uris", uri.to_owned())], None)?;
        Ok(())
    }

    pub fn add_to_playlist(&mut self, playlist_id: &str, tracks: &[Track]) -> Result<usize> {
        ensure!(valid_id(playlist_id), "Invalid playlist ID");
        let mut existing = HashSet::new();
        let mut visited = HashSet::new();
        let mut next = Some(format!(
            "https://api.spotify.com/v1/playlists/{playlist_id}/items?limit=50"
        ));
        while let Some(path) = next {
            ensure!(
                visited.insert(path.clone()),
                "Spotify repeated a playlist page"
            );
            let response = self.request(Method::GET, &path, &[], None)?;
            for track in parse_track_items(&response)? {
                existing.insert(track.uri);
            }
            next = response["next"].as_str().map(str::to_owned);
        }
        let additions = unique_additions(&existing, tracks);
        let mut added = 0;
        for batch in additions.chunks(100) {
            if let Err(error) = self.request(
                Method::POST,
                &format!("playlists/{playlist_id}/items"),
                &[],
                Some(json!({"uris": batch})),
            ) {
                bail!(
                    "Added {added} tracks before stopping: {error}. Retry safely; existing tracks are skipped."
                );
            }
            added += batch.len();
        }
        Ok(added)
    }
}

fn valid_id(value: &str) -> bool {
    !value.is_empty() && value.bytes().all(|byte| byte.is_ascii_alphanumeric())
}

fn parse_track_items(response: &Value) -> Result<Vec<Track>> {
    let mut tracks = Vec::new();
    for item in response["items"]
        .as_array()
        .context("Track page has no items")?
    {
        let track = item
            .get("item")
            .or_else(|| item.get("track"))
            .unwrap_or(&Value::Null);
        if track.is_null() || track["type"].as_str().is_some_and(|kind| kind != "track") {
            continue;
        }
        tracks.push(serde_json::from_value(track.clone()).context("Invalid track in playlist")?);
    }
    Ok(tracks)
}

pub enum PlayerAction {
    Play(Option<String>),
    Pause,
    Next,
    Previous,
    Seek(u64),
    Volume(u8),
    Shuffle(bool),
    Repeat(String),
    Enqueue(String),
    Transfer(String),
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn playlist_parser_handles_2026_and_legacy_fields_and_missing_tracks() {
        let page = json!({"items":[{"item":{"id":"one","uri":"spotify:track:one","name":"New","type":"track"}}, {"track":{"id":"two","name":"Old"}}, {"item":null}, {"item":{"type":"episode","name":"Podcast"}}]});
        let tracks = parse_track_items(&page).unwrap();
        assert_eq!(tracks.len(), 2);
        assert_eq!(tracks[0].name, "New");
        assert_eq!(tracks[1].name, "Old");
    }
}
