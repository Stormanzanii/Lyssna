//! Native list signals: bootstrap pagination, then use the server's per-item prompt action.
use super::Prompt;
use anyhow::{Context, Result, ensure};
use librespot_connect::{ContextPageFuture, ContextPageProvider};
use librespot_core::Session;
use librespot_protocol::context_page::ContextPage;
use librespot_protocol::{
    context::Context as PlayContext,
    playlist4_external::{ListSignals, SelectedListContent},
    signal_model::Signal,
};
use protobuf::Message;
use reqwest::{Client, Method};
use std::{collections::HashSet, sync::Arc};
use std::{
    sync::atomic::{AtomicBool, Ordering},
    time::Duration,
};

const PLAYLIST: &str = "/playlist/v2/playlist/37i9dQZF1EYkqdzj48dyYq";
const ITEMS: &str = "audio-track, audio-episode, video-episode, audiobook";

pub async fn prepare(
    session: &Session,
    prompt: Prompt,
    cancelled: &AtomicBool,
) -> Result<Prepared> {
    tokio::select! {
        result=prepare_inner(session,prompt,cancelled)=>result,
        _=async {while !cancelled.load(Ordering::Acquire){tokio::time::sleep(Duration::from_millis(25)).await;}}=>anyhow::bail!("DJ request cancelled"),
    }
}
async fn prepare_inner(
    session: &Session,
    prompt: Prompt,
    cancelled: &AtomicBool,
) -> Result<Prepared> {
    let client = Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(20))
        .build()?;
    check(cancelled)?;
    let initial = request(&client, session, Method::GET, PLAYLIST, None, cancelled).await?;
    let next = initial
        .contents
        .as_ref()
        .and_then(|c| {
            c.available_signals
                .iter()
                .find(|s| s.identifier == "list-next-page")
        })
        .context("Spotify did not offer DJ initialization")?
        .clone();
    let ready = signal(&client, session, &initial, next, cancelled).await?;
    let mut action =
        prompt_action(&ready).context("Spotify has not enabled DJ requests for this account")?;
    action.client_payload = prompt.parameters()?.into_bytes();
    let reply = signal(&client, session, &ready, action, cancelled).await?;
    check(cancelled)?;
    let source = Arc::new(Source {
        session: session.clone(),
        prefix: {
            use base64::Engine;
            let mut bytes = [0u8; 18];
            getrandom::fill(&mut bytes)
                .map_err(|_| anyhow::anyhow!("DJ session ID unavailable"))?;
            format!(
                "hm://spotiflex-dj/{}/",
                base64::prelude::BASE64_URL_SAFE_NO_PAD.encode(bytes)
            )
        },
        state: tokio::sync::Mutex::new(Pages {
            current: reply,
            seen: HashSet::new(),
            index: 0,
            cached: None,
            failed: false,
        }),
    });
    let uri = format!("{}0", source.prefix);
    let page = source.load(&uri).await?;
    check(cancelled)?;
    ensure!(
        !page.tracks.is_empty(),
        "Spotify has not prepared tracks for this request yet"
    );
    let context = PlayContext {
        uri: Some(crate::home::DJ_URI.into()),
        pages: vec![page],
        metadata: [("spotiflex.dj_request".into(), "true".into())].into(),
        ..Default::default()
    };
    Ok(Prepared {
        context,
        provider: source,
    })
}

#[derive(Clone)]
pub struct Prepared {
    pub context: PlayContext,
    pub provider: Arc<dyn ContextPageProvider>,
}
struct Source {
    session: Session,
    prefix: String,
    state: tokio::sync::Mutex<Pages>,
}
struct Pages {
    current: SelectedListContent,
    seen: HashSet<String>,
    index: usize,
    cached: Option<(String, ContextPage)>,
    failed: bool,
}
impl std::fmt::Debug for Source {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("DJ request pages")
    }
}
impl Source {
    async fn load(&self, uri: &str) -> Result<ContextPage> {
        ensure!(self.owns(uri), "DJ page belongs to another session");
        let mut state = self.state.lock().await;
        if let Some((key, page)) = &state.cached
            && key == uri
        {
            return Ok(page.clone());
        }
        ensure!(
            !state.failed && uri == format!("{}{}", self.prefix, state.index),
            "DJ page unavailable; ask DJ again"
        );
        // A failed mutation has an unknown outcome. Never retry its signal automatically.
        state.failed = true;
        let client = Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .timeout(Duration::from_secs(20))
            .build()?;
        let action = next_action(&state.current).context("DJ session has ended")?;
        let reply = signal(
            &client,
            &self.session,
            &state.current,
            action,
            &AtomicBool::new(false),
        )
        .await?;
        let page = super::context::page(&reply, &mut state.seen)?;
        ensure!(
            !page.tracks.is_empty(),
            "DJ has no new tracks; ask DJ again"
        );
        state.current = reply;
        state.index += 1;
        let mut page = page;
        if next_action(&state.current).is_some() {
            page.next_page_url = Some(format!("{}{}", self.prefix, state.index));
        }
        state.cached = Some((uri.into(), page.clone()));
        state.failed = false;
        Ok(page)
    }
}
impl ContextPageProvider for Source {
    fn owns(&self, uri: &str) -> bool {
        uri.strip_prefix(&self.prefix)
            .is_some_and(|tail| !tail.is_empty() && tail.bytes().all(|c| c.is_ascii_digit()))
    }
    fn page(&self, uri: String) -> ContextPageFuture<'_> {
        Box::pin(async move {
            self.load(&uri).await.map_err(|_| {
                librespot_core::Error::failed_precondition("DJ page unavailable; ask DJ again")
            })
        })
    }
}
fn next_action(value: &SelectedListContent) -> Option<Signal> {
    value
        .contents
        .as_ref()?
        .available_signals
        .iter()
        .find(|s| s.identifier == "list-next-page")
        .cloned()
}

fn check(cancelled: &AtomicBool) -> Result<()> {
    ensure!(!cancelled.load(Ordering::Acquire), "DJ request cancelled");
    Ok(())
}
fn prompt_action(value: &SelectedListContent) -> Option<Signal> {
    value
        .contents
        .as_ref()?
        .items
        .iter()
        .filter_map(|i| i.attributes.as_ref())
        .flat_map(|a| &a.available_signals)
        .find(|s| s.identifier == "prompt")
        .cloned()
}
async fn signal(
    client: &Client,
    session: &Session,
    current: &SelectedListContent,
    action: Signal,
    cancelled: &AtomicBool,
) -> Result<SelectedListContent> {
    let body = ListSignals {
        base_revision: current.revision.clone(),
        emitted_signals: vec![action],
        ..Default::default()
    }
    .write_to_bytes()?;
    request(
        client,
        session,
        Method::POST,
        &format!("{PLAYLIST}/signals"),
        Some(body),
        cancelled,
    )
    .await
}
async fn request(
    client: &Client,
    session: &Session,
    method: Method,
    path: &str,
    body: Option<Vec<u8>>,
    cancelled: &AtomicBool,
) -> Result<SelectedListContent> {
    check(cancelled)?;
    let base = session
        .spclient()
        .base_url()
        .await
        .context("Spotify connection unavailable")?;
    let url = url::Url::parse(&base)?;
    ensure!(
        url.scheme() == "https"
            && url.host_str().is_some_and(|h| h.ends_with(".spotify.com"))
            && url.username().is_empty()
            && url.password().is_none(),
        "Untrusted Spotify connection"
    );
    let access = session
        .login5()
        .auth_token()
        .await
        .context("Spotify sign-in expired")?;
    let token = session
        .spclient()
        .client_token()
        .await
        .context("Spotify client authorization unavailable")?;
    check(cancelled)?;
    let country = session.country();
    let mut request = client
        .request(method, format!("{base}{path}"))
        .query(&[("product", "0"), ("country", country.as_str())])
        .bearer_auth(access.access_token)
        .header("client-token", token)
        .header("spotify-list-player-enabled", "true")
        .header("x-accept-list-items", ITEMS);
    if let Some(body) = body {
        request = request
            .header("Content-Type", "application/x-protobuf")
            .header("Content-Length", body.len())
            .body(body);
    }
    // Signals mutate a DJ session. Never automatically retry them.
    let response = request
        .send()
        .await
        .map_err(|_| anyhow::anyhow!("Spotify DJ connection failed"))?;
    ensure!(
        response.status().is_success(),
        "Spotify rejected DJ request (HTTP {})",
        response.status().as_u16()
    );
    ensure!(
        response.content_length().is_none_or(|n| n <= 2_000_000),
        "DJ response too large"
    );
    let mut response = response;
    let mut bytes = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| anyhow::anyhow!("DJ response could not be read"))?
    {
        ensure!(
            bytes.len().saturating_add(chunk.len()) <= 2_000_000,
            "DJ response too large"
        );
        bytes.extend_from_slice(&chunk);
    }
    check(cancelled)?;
    SelectedListContent::parse_from_bytes(&bytes).context("Invalid DJ response")
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn prompt_uses_advertised_item_data_and_preserves_server_bytes() {
        use librespot_protocol::playlist4_external::{Item, ItemAttributes, ListItems};
        let action = Signal {
            identifier: "prompt".into(),
            data: vec![1, 9, 3],
            ..Default::default()
        };
        let ready = SelectedListContent {
            contents: Some(ListItems {
                items: vec![Item {
                    uri: Some("spotify:track:test".into()),
                    attributes: Some(ItemAttributes {
                        available_signals: vec![action.clone()],
                        ..Default::default()
                    })
                    .into(),
                    ..Default::default()
                }],
                ..Default::default()
            })
            .into(),
            ..Default::default()
        };
        assert_eq!(prompt_action(&ready), Some(action));
        assert!(prompt_action(&SelectedListContent::default()).is_none());
        assert!(check(&AtomicBool::new(true)).is_err());
    }
}
