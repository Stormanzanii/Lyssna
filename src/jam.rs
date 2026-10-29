//! Spotify Jams hosted from this computer, through the signed-in native
//! session's social-connect service, as Spotify's own app does it. No Web API
//! or developer app is involved.
use anyhow::{Context, Result, ensure};
use librespot_core::{Session, error::ErrorKind};
use reqwest::{Method, header};
use serde::Serialize;
use serde_json::Value;
use std::{
    collections::HashMap,
    sync::{LazyLock, Mutex},
    time::Duration,
};

#[derive(Clone, Debug, Default, PartialEq, Serialize)]
pub struct JamMember {
    pub id: String,
    pub username: String,
    pub display_name: String,
    pub image_url: Option<String>,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize)]
pub struct Jam {
    pub session_id: String,
    pub owner_id: String,
    pub is_owner: bool,
    pub members: Vec<JamMember>,
    /// The link guests open to join: Spotify's short `spotify.link` one when
    /// Spotify hands it out, else the long `open.spotify.com` one.
    pub invite_url: String,
    #[serde(skip)]
    join_token: String,
    #[serde(skip)]
    join_uri: String,
    /// The same link as a QR code, for phones.
    pub qr_svg: String,
    /// Guests may only add to the queue, not change what's playing.
    pub queue_only: bool,
}

/// Session IDs and join tokens go into request paths and the invite link.
fn token(value: &str) -> Option<&str> {
    (!value.is_empty()
        && value.len() <= 128
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"-_".contains(&byte)))
    .then_some(value)
}

fn qr(text: &str) -> String {
    use qrcode::render::svg::Color;
    qrcode::QrCode::new(text)
        .map(|code| {
            code.render::<Color>()
                .quiet_zone(false)
                .dark_color(Color("#000"))
                .light_color(Color("#fff"))
                .build()
        })
        .unwrap_or_default()
}

pub fn parse(session: &Value) -> Option<Jam> {
    let session_id = token(session["session_id"].as_str()?)?;
    let join = token(session["join_session_token"].as_str()?)?;
    let text = |value: &Value| value.as_str().unwrap_or_default().to_owned();
    let invite_url = format!("https://open.spotify.com/socialsession/{join}");
    Some(Jam {
        session_id: session_id.to_owned(),
        owner_id: text(&session["session_owner_id"]),
        is_owner: session["is_session_owner"].as_bool().unwrap_or_default(),
        members: session["session_members"]
            .as_array()
            .map(|members| {
                members
                    .iter()
                    .map(|member| JamMember {
                        id: text(&member["id"]),
                        username: text(&member["username"]),
                        display_name: text(&member["display_name"]),
                        image_url: member["image_url"]
                            .as_str()
                            .filter(|url| url.starts_with("https://"))
                            .map(str::to_owned),
                    })
                    .collect()
            })
            .unwrap_or_default(),
        qr_svg: qr(&invite_url),
        invite_url,
        join_token: join.to_owned(),
        // The URI Spotify's share sheet shortens; built from the token when
        // the session names none.
        join_uri: session["join_session_uri"]
            .as_str()
            .filter(|uri| {
                uri.strip_prefix("spotify:socialsession:")
                    .and_then(token)
                    .is_some()
            })
            .map_or_else(|| format!("spotify:socialsession:{join}"), str::to_owned),
        queue_only: session["queue_only_mode"].as_bool().unwrap_or_default(),
    })
}

/// Spotify's own short invite link, as its share sheet makes it.
fn short_link(value: &Value) -> Option<String> {
    let url = value["shareable_url"].as_str()?;
    let code = url.strip_prefix("https://spotify.link/")?;
    (!code.is_empty() && code.len() <= 64 && code.bytes().all(|byte| byte.is_ascii_alphanumeric()))
        .then(|| url.to_owned())
}

static SHORT_LINKS: LazyLock<Mutex<HashMap<String, String>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

/// Swap the long invite link for Spotify's short one, made once per Jam.
async fn with_short_link(session: &Session, mut jam: Jam) -> Jam {
    let cached = SHORT_LINKS
        .lock()
        .ok()
        .and_then(|links| links.get(&jam.join_token).cloned());
    let link = match cached {
        Some(link) => Some(link),
        None => {
            let token = &jam.join_token;
            let body = serde_json::json!({
                "spotify_uri": jam.join_uri,
                "custom_data": [
                    {"key": "ssp", "value": "1"},
                    {"key": "app_destination", "value": "socialsession"}
                ],
                "link_preview": {
                    "title": "Join my Jam on Spotify",
                    "image_url": format!("https://shareables.scdn.co/publish/socialsession/{token}")
                },
                "utm_parameters": {
                    "utm_medium": "share-link",
                    "utm_source": "share-options-sheet"
                }
            });
            let link = request(
                session,
                Method::POST,
                "/url-dispenser/v1/generate-url",
                Some(&body),
            )
            .await
            .ok()
            .flatten()
            .as_ref()
            .and_then(short_link);
            if let (Some(link), Ok(mut links)) = (&link, SHORT_LINKS.lock()) {
                links.insert(token.clone(), link.clone());
            }
            link
        }
    };
    if let Some(link) = link {
        jam.qr_svg = qr(&link);
        jam.invite_url = link;
    }
    jam
}

async fn call(session: &Session, method: Method, path: &str) -> Result<Option<Value>> {
    request(session, method, &format!("/social-connect{path}"), None).await
}

async fn request(
    session: &Session,
    method: Method,
    path: &str,
    body: Option<&Value>,
) -> Result<Option<Value>> {
    let mut headers = header::HeaderMap::new();
    headers.insert(header::ACCEPT, "application/json".parse()?);
    headers.insert(header::CONTENT_TYPE, "application/json".parse()?);
    let response = tokio::time::timeout(
        Duration::from_secs(10),
        session.spclient().request(
            &method,
            path,
            Some(headers),
            body.map(serde_json::to_vec).transpose()?.as_deref(),
        ),
    )
    .await
    .map_err(|_| anyhow::anyhow!("Spotify Jam timed out"))?;
    match response {
        Ok(body) if body.is_empty() => Ok(None),
        Ok(body) => {
            ensure!(body.len() <= 1_000_000, "Jam response too large");
            Ok(Some(serde_json::from_slice(&body)?))
        }
        Err(error) if error.kind == ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error.into()),
    }
}

/// The Jam this computer is in, if any.
pub async fn current(session: &Session) -> Result<Option<Jam>> {
    let device = token(session.device_id()).context("Invalid device ID")?;
    Ok(
        match call(
            session,
            Method::GET,
            &format!("/v2/devices/{device}/jam_status"),
        )
        .await?
        .and_then(|status| parse(&status["session"]))
        {
            Some(jam) => Some(with_short_link(session, jam).await),
            None => None,
        },
    )
}

pub async fn start(session: &Session) -> Result<Jam> {
    let jam = call(
        session,
        Method::GET,
        "/v2/sessions/current_or_new?activate=true",
    )
    .await?
    .as_ref()
    .and_then(parse)
    .context("Spotify could not start a Jam")?;
    Ok(with_short_link(session, jam).await)
}

pub async fn end(session: &Session, id: &str) -> Result<()> {
    let id = token(id).context("Invalid Jam")?;
    call(session, Method::DELETE, &format!("/v3/sessions/{id}")).await?;
    Ok(())
}

pub async fn leave(session: &Session, id: &str) -> Result<()> {
    let id = token(id).context("Invalid Jam")?;
    call(session, Method::POST, &format!("/v3/sessions/{id}/leave")).await?;
    Ok(())
}

/// Whether guests may change what's playing, or only add to the queue.
pub async fn let_others_control(session: &Session, allowed: bool) -> Result<Option<Jam>> {
    let mode = if allowed { "disabled" } else { "enabled" };
    let jam = call(
        session,
        Method::PUT,
        &format!("/v2/sessions/current/queue_only_mode/{mode}"),
    )
    .await?
    .as_ref()
    .and_then(parse);
    Ok(match jam {
        Some(jam) => Some(with_short_link(session, jam).await),
        None => None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn a_session_becomes_a_jam_with_an_invite_link_and_qr_code() {
        let jam = parse(&json!({
            "session_id": "abc123",
            "join_session_token": "Tok_en-9",
            "session_owner_id": "host",
            "is_session_owner": true,
            "queue_only_mode": false,
            "session_members": [
                {"id": "host", "username": "host", "display_name": "Host",
                 "image_url": "https://i.scdn.co/image/x"},
                {"id": "guest", "username": "guest", "display_name": "",
                 "image_url": "http://insecure.example/x"}
            ]
        }))
        .unwrap();
        assert_eq!(
            jam.invite_url,
            "https://open.spotify.com/socialsession/Tok_en-9"
        );
        assert!(jam.qr_svg.starts_with("<?xml") && jam.qr_svg.contains("<svg"));
        assert!(jam.is_owner && !jam.queue_only);
        assert_eq!(jam.members.len(), 2);
        assert_eq!(jam.members[1].image_url, None);
    }

    #[test]
    fn only_spotify_short_links_replace_the_invite() {
        assert_eq!(
            short_link(&json!({"shareable_url": "https://spotify.link/IdREaHOTC7b"})).as_deref(),
            Some("https://spotify.link/IdREaHOTC7b")
        );
        for bad in [
            "http://spotify.link/IdREaHOTC7b",
            "https://evil.example/IdREaHOTC7b",
            "https://spotify.link/",
            "https://spotify.link/a/b",
            "https://spotify.link/a?b",
        ] {
            assert_eq!(short_link(&json!({"shareable_url": bad})), None, "{bad}");
        }
    }

    #[test]
    fn tokens_that_could_change_the_request_path_are_refused() {
        for bad in ["", "../x", "a/b", "a?b=1", "a b", &"x".repeat(129)] {
            assert!(
                parse(&json!({"session_id": bad, "join_session_token": "ok"})).is_none(),
                "{bad}"
            );
            assert!(
                parse(&json!({"session_id": "ok", "join_session_token": bad})).is_none(),
                "{bad}"
            );
        }
    }
}
