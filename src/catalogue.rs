//! Read-only desktop catalogue queries. Native credentials stay inside Rust.
use anyhow::{Context, Result, ensure};
use librespot_core::Session;
use serde_json::{Value, json};
use std::time::Duration;

pub async fn entity(session: &Session, kind: &str, id: &str) -> Result<Value> {
    page(session, kind, id, 0).await
}
pub async fn page(session: &Session, kind: &str, id: &str, offset: usize) -> Result<Value> {
    ensure!(
        id.len() == 22 && id.bytes().all(|byte| byte.is_ascii_alphanumeric()),
        "Invalid catalogue ID"
    );
    // Persisted query identifiers verified against Spotify's desktop web client.
    let (operation, hash, field) = match kind {
        "artist" => (
            "queryArtistOverview",
            "9f8134ef565e78621f1e1793555bd6633c5ac144ae0f89604ed3ae3f80b3c8e6",
            "artistUnion",
        ),
        "album" => (
            "getAlbum",
            "0b6ce3511e1b02e4a40fa95440f992acbe85080eb308af9194322d708fc1914f",
            "albumUnion",
        ),
        _ => anyhow::bail!("Unsupported catalogue query"),
    };
    let token = session.login5().auth_token().await?;
    let client_token = session.spclient().client_token().await?;
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(8))
        .build()?;
    let mut response=client.post("https://api-partner.spotify.com/pathfinder/v2/query").bearer_auth(token.access_token).header("client-token",client_token).header("app-platform","WebPlayer").header("spotify-app-version","896000000").json(&json!({"operationName":operation,"variables":{"uri":format!("spotify:{kind}:{id}"),"locale":"","preReleaseV2":false,"offset":offset,"limit":50},"extensions":{"persistedQuery":{"version":1,"sha256Hash":hash}}})).send().await?.error_for_status()?;
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await? {
        ensure!(
            bytes.len() + chunk.len() <= 2_000_000,
            "Catalogue response too large"
        );
        bytes.extend_from_slice(&chunk);
    }
    let mut data: Value = serde_json::from_slice(&bytes)?;
    let entity = data["data"][field].take();
    ensure!(
        entity["uri"].as_str() == Some(format!("spotify:{kind}:{id}").as_str()),
        "Desktop catalogue data unavailable"
    );
    entity.as_object().context("Invalid catalogue data")?;
    Ok(entity)
}
