//! Browser PKCE login and verified restore without a developer Web API app.
use std::{
    sync::atomic::{AtomicBool, Ordering},
    time::Duration,
};

use crate::{
    auth,
    model::{Artwork, Profile},
    native,
};
use anyhow::{Context, Result, ensure};
use librespot_core::{Session, authentication::Credentials, config::SessionConfig};
use librespot_protocol::authentication::AuthenticationType;

struct Connected(Session);
impl Drop for Connected {
    fn drop(&mut self) {
        self.0.shutdown();
    }
}

fn previous_profile() -> Result<Option<Profile>> {
    if let Some(profile) = native::saved_profile()? {
        return Ok(Some(profile));
    }
    // Upgrade existing installations using only their stored account identity.
    let settings = crate::config::Settings::load()?;
    Ok(auth::Tokens::load(&settings.client_id)?.and_then(|tokens| tokens.profile))
}

pub fn authenticate(
    client: &reqwest::blocking::Client,
    restoring: bool,
    cancelled: &AtomicBool,
) -> Result<Option<(Profile, Credentials)>> {
    ensure!(!cancelled.load(Ordering::Acquire), "Sign-in cancelled");
    let previous = if restoring { previous_profile()? } else { None };
    let credentials = if restoring {
        let Some(profile) = previous.as_ref() else {
            return Ok(None);
        };
        let Some(credentials) = native::load_credentials(&profile.id)? else {
            return Ok(None);
        };
        credentials
    } else {
        Credentials::with_access_token(auth::authorize_audio(client, cancelled)?)
    };
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .worker_threads(2)
        .enable_all()
        .build()?;
    runtime.block_on(async {
        let connected = Connected(Session::new(SessionConfig { client_id: auth::AUDIO_CLIENT_ID.into(), ..Default::default() }, None));
        let session = &connected.0;
        let operation = async {
            tokio::time::timeout(Duration::from_secs(40), session.connect(credentials, false)).await
                .map_err(|_| anyhow::anyhow!("Spotify sign-in timed out. Check your connection and retry."))?
                .map_err(native::sign_in_error)?;
            let account = session.username();
            ensure!(!account.is_empty(), "Spotify did not authenticate an account");
            if let Some(previous) = previous.as_ref() { ensure!(account == previous.id, "Saved Spotify sign-in belongs to a different account"); }
            let encoded: String = url::form_urlencoded::byte_serialize(account.as_bytes()).collect();
            let bytes = tokio::time::timeout(Duration::from_secs(8), session.spclient().get_user_profile(&encoded, Some(0), Some(0))).await;
            let profile = match bytes {
                Ok(Ok(bytes)) => profile_from_response(&account, &bytes)?,
                _ => previous.clone().unwrap_or(Profile { id: account.clone(), ..Default::default() }),
            };
            let reusable = Credentials { username: Some(account), auth_type: AuthenticationType::AUTHENTICATION_STORED_SPOTIFY_CREDENTIALS, auth_data: session.auth_data() };
            ensure!(!cancelled.load(Ordering::Acquire), "Sign-in cancelled");
            Ok(Some((profile, reusable)))
        };
        tokio::select! {
            result = operation => result,
            () = async { while !cancelled.load(Ordering::Acquire) { tokio::time::sleep(Duration::from_millis(50)).await; } } => anyhow::bail!("Sign-in cancelled"),
        }
    })
}

fn profile_from_response(account: &str, bytes: &[u8]) -> Result<Profile> {
    ensure!(
        bytes.len() <= 1_000_000,
        "Spotify profile response too large"
    );
    let value: serde_json::Value =
        serde_json::from_slice(bytes).context("Cannot read Spotify profile")?;
    if let Some(uri) = value["uri"].as_str() {
        ensure!(
            uri == format!("spotify:user:{account}"),
            "Spotify profile belongs to a different account"
        );
    }
    let images = value["image_url"]
        .as_str()
        .and_then(|image| url::Url::parse(image).ok())
        .filter(|url| {
            url.scheme() == "https" && url.username().is_empty() && url.password().is_none()
        })
        .map(|url| {
            vec![Artwork {
                url: url.into(),
                ..Default::default()
            }]
        })
        .unwrap_or_default();
    Ok(Profile {
        id: account.into(),
        display_name: value["name"]
            .as_str()
            .map(str::trim)
            .filter(|name| !name.is_empty())
            .map(str::to_owned),
        images,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn authenticated_identity_is_authoritative_and_profile_images_are_https() {
        let profile = profile_from_response("listener", br#"{"uri":"spotify:user:listener","name":" Listener ","image_url":"https://i.scdn.co/image/avatar"}"#).unwrap();
        assert_eq!(profile.id, "listener");
        assert_eq!(profile.display_name.as_deref(), Some("Listener"));
        assert_eq!(profile.images.len(), 1);
        assert!(
            profile_from_response("listener", br#"{"uri":"spotify:user:someone-else"}"#).is_err()
        );
        assert!(
            profile_from_response("listener", br#"{"image_url":"http://localhost/avatar"}"#)
                .unwrap()
                .images
                .is_empty()
        );
    }
    #[test]
    fn cancelled_login_cannot_open_browser_or_read_credentials() {
        assert!(
            authenticate(
                &reqwest::blocking::Client::new(),
                false,
                &AtomicBool::new(true)
            )
            .err()
            .unwrap()
            .to_string()
            .contains("cancelled")
        );
    }
    #[test]
    #[ignore = "Read-only native sign-in, library, likes, search and Home using saved credentials; no playback or writes"]
    fn live_native_login_and_browsing_without_developer_app() {
        let result = authenticate(&auth::http_client().unwrap(), true, &AtomicBool::new(false))
            .unwrap()
            .expect("Saved native login required");
        let (profile, credentials) = result;
        assert!(!profile.id.is_empty());
        let runtime = tokio::runtime::Builder::new_multi_thread()
            .worker_threads(2)
            .enable_all()
            .build()
            .unwrap();
        runtime.block_on(async {
            let connected = Connected(Session::new(
                SessionConfig {
                    client_id: auth::AUDIO_CLIENT_ID.into(),
                    ..Default::default()
                },
                None,
            ));
            let session = &connected.0;
            tokio::time::timeout(Duration::from_secs(40), session.connect(credentials, false))
                .await
                .unwrap()
                .unwrap();
            assert_eq!(session.username(), profile.id);
            let library = crate::native_browse::library_with_folders(session)
                .await
                .expect("Native library failed");
            assert!(
                !library.0.is_empty(),
                "Saved account has no playlists to validate"
            );
            let liked = crate::native_browse::read(session, "liked", 0)
                .await
                .expect("Native liked songs failed");
            let search = crate::search::catalogue(session, "Daft Punk")
                .await
                .expect("Native search failed");
            assert!(
                !search.tracks.is_empty() || !search.artists.is_empty(),
                "Native search returned no music"
            );
            crate::home::fetch(session, "Australia/Sydney")
                .await
                .expect("Native Home failed");
            if let Some(track) = liked.first().filter(|track| track.album.id.is_some()) {
                crate::catalogue::page(session, "album", track.album.id.as_deref().unwrap(), 0)
                    .await
                    .expect("Native album failed");
            }
        });
    }
}
