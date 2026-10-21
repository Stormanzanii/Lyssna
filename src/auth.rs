use std::{
    io::{Read, Write},
    net::{TcpListener, TcpStream},
    sync::atomic::{AtomicBool, Ordering},
    thread,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use anyhow::{Context, Result, bail, ensure};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use reqwest::blocking::Client;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use url::Url;

use crate::config::{REDIRECT_URI, valid_client_id};

#[derive(Clone, Serialize)]
pub struct LoginIssue {
    pub message: String,
    pub retry_saved: bool,
}

impl LoginIssue {
    pub fn from_error(error: &anyhow::Error, restoring: bool) -> Self {
        Self {
            message: error.to_string(),
            retry_saved: restoring && error.downcast_ref::<SignInRequired>().is_none(),
        }
    }
}

#[derive(Debug)]
pub(crate) enum SignInRequired {
    Rejected,
    NativeRejected,
    Damaged,
}
impl std::fmt::Display for SignInRequired {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(match self {
            Self::Rejected => {
                "Spotify rejected the saved sign-in. Check your Client ID, then sign in again."
            }
            Self::NativeRejected => "Spotify rejected the saved sign-in. Sign in again.",
            Self::Damaged => "Saved Spotify sign-in is damaged. Sign in again to replace it.",
        })
    }
}
impl std::error::Error for SignInRequired {}

fn token_status(status: reqwest::StatusCode, refreshing: bool) -> Result<()> {
    if status.is_success() {
        return Ok(());
    }
    if refreshing && matches!(status.as_u16(), 400 | 401 | 403) {
        return Err(SignInRequired::Rejected.into());
    }
    if status == reqwest::StatusCode::TOO_MANY_REQUESTS || status.is_server_error() {
        bail!("Spotify sign-in is temporarily unavailable. Wait a moment, then retry.");
    }
    bail!(
        "Spotify token request failed (HTTP {}). Check Client ID and registered redirect URI, then sign in again.",
        status.as_u16()
    );
}

/// Match librespot's public audio OAuth client and its registered loopback.
/// This is separate from the developer app's Web API login and uses PKCE.
pub(crate) const AUDIO_CLIENT_ID: &str = "65b708073fc0480ea92a077233ca87bd";
const AUDIO_REDIRECT_URI: &str = "http://127.0.0.1:8898/login";
const AUDIO_SCOPES: &str = "streaming";

/// One OAuth authorization-code-with-PKCE configuration.
struct Flow<'a> {
    client_id: &'a str,
    redirect_uri: &'a str,
    path: &'a str,
    scopes: &'a str,
}

fn app_flow(client_id: &str) -> Flow<'_> {
    Flow {
        client_id,
        redirect_uri: REDIRECT_URI,
        path: "/callback",
        scopes: SCOPES,
    }
}

const AUDIO_FLOW: Flow<'static> = Flow {
    client_id: AUDIO_CLIENT_ID,
    redirect_uri: AUDIO_REDIRECT_URI,
    path: "/login",
    scopes: AUDIO_SCOPES,
};

const SCOPES: &str = "streaming user-read-private user-read-playback-state user-read-currently-playing user-modify-playback-state playlist-read-private playlist-read-collaborative playlist-modify-private playlist-modify-public user-library-read user-library-modify user-read-recently-played user-follow-read user-follow-modify";

// Intentionally no Debug implementation: these values must never enter logs.
#[derive(Clone, Serialize, Deserialize)]
pub struct Tokens {
    pub access_token: String,
    pub refresh_token: String,
    pub expires_at: u64,
    #[serde(default)]
    pub scopes: String,
    #[serde(default)]
    pub profile: Option<crate::model::Profile>,
}

#[derive(Deserialize)]
struct TokenResponse {
    access_token: String,
    refresh_token: Option<String>,
    expires_in: u64,
    scope: Option<String>,
}

fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

pub fn http_client() -> Result<Client> {
    Ok(Client::builder()
        .connect_timeout(Duration::from_secs(10))
        .timeout(Duration::from_secs(20))
        .redirect(reqwest::redirect::Policy::none())
        .user_agent("SpotiFlex/0.1.0")
        .build()?)
}

fn random_string() -> Result<String> {
    let mut bytes = [0u8; 32];
    getrandom::fill(&mut bytes)
        .map_err(|_| anyhow::anyhow!("Operating system random source unavailable"))?;
    Ok(URL_SAFE_NO_PAD.encode(bytes))
}

fn challenge(verifier: &str) -> String {
    URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()))
}

#[cfg(test)]
fn authorization_url(client_id: &str, verifier: &str, state: &str) -> Result<Url> {
    authorization_url_for(&app_flow(client_id), verifier, state)
}

fn authorization_url_for(flow: &Flow<'_>, verifier: &str, state: &str) -> Result<Url> {
    ensure!(
        valid_client_id(flow.client_id),
        "Client ID must contain 32 hexadecimal characters"
    );
    let mut url = Url::parse("https://accounts.spotify.com/authorize")?;
    url.query_pairs_mut().extend_pairs([
        ("client_id", flow.client_id),
        ("response_type", "code"),
        ("redirect_uri", flow.redirect_uri),
        ("scope", flow.scopes),
        ("code_challenge_method", "S256"),
        ("code_challenge", &challenge(verifier)),
        ("state", state),
    ]);
    Ok(url)
}

/// Reject duplicate fields and validate state before trusting either code or error.
#[cfg(test)]
fn callback_code(target: &str, expected_state: &str) -> Result<String> {
    callback_code_for(target, expected_state, &app_flow(""))
}

fn callback_code_for(target: &str, expected_state: &str, flow: &Flow<'_>) -> Result<String> {
    ensure!(
        target.starts_with(flow.path) && target[flow.path.len()..].starts_with('?'),
        "Unexpected callback path"
    );
    let url = Url::parse(&format!(
        "{}{}",
        flow.redirect_uri,
        &target[flow.path.len()..]
    ))?;
    let parameters: Vec<_> = url.query_pairs().collect();
    let field = |name: &str| -> Result<Option<String>> {
        let values: Vec<_> = parameters.iter().filter(|(key, _)| key == name).collect();
        ensure!(values.len() <= 1, "Duplicate callback parameter");
        Ok(values.first().map(|(_, value)| value.to_string()))
    };
    ensure!(
        field("state")?.as_deref() == Some(expected_state),
        "Login state did not match"
    );
    if field("error")?.is_some() {
        bail!("Spotify sign-in was declined. Start sign-in again when ready.");
    }
    let code = field("code")?.context("Spotify did not return an authorization code")?;
    ensure!(
        !code.is_empty(),
        "Spotify returned an empty authorization code"
    );
    Ok(code)
}

fn read_target(stream: &mut TcpStream) -> Result<String> {
    stream.set_read_timeout(Some(Duration::from_millis(500)))?;
    let mut request = Vec::new();
    let mut buffer = [0; 1024];
    let deadline = Instant::now() + Duration::from_secs(2);
    while request.len() < 8192 && Instant::now() < deadline {
        let count = stream.read(&mut buffer)?;
        if count == 0 {
            break;
        }
        request.extend_from_slice(&buffer[..count]);
        if request.windows(4).any(|window| window == b"\r\n\r\n") {
            break;
        }
    }
    ensure!(request.len() < 8192, "Callback request too large");
    let text = std::str::from_utf8(&request)?;
    let mut parts = text.lines().next().unwrap_or_default().split_whitespace();
    ensure!(parts.next() == Some("GET"), "Callback requires GET");
    Ok(parts.next().context("Callback URL missing")?.to_owned())
}

fn reply(stream: &mut TcpStream, status: &str, message: &str) {
    let body = format!(
        "<!doctype html><html><head><meta name=viewport content='width=device-width'><title>SpotiFlex</title></head><body style='background:#121212;color:#fff;font:18px system-ui;padding:64px'><h1>SpotiFlex</h1><p>{message}</p><p>You can close this tab.</p></body></html>"
    );
    let _ = stream.set_write_timeout(Some(Duration::from_millis(500)));
    let _ = write!(
        stream,
        "HTTP/1.1 {status}\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nCache-Control: no-store\r\nContent-Security-Policy: default-src 'none'; style-src 'unsafe-inline'\r\nConnection: close\r\n\r\n{body}",
        body.len()
    );
}

fn wait_for_code(
    listener: &TcpListener,
    state: &str,
    cancelled: &AtomicBool,
    flow: &Flow<'_>,
) -> Result<String> {
    listener.set_nonblocking(true)?;
    let deadline = Instant::now() + Duration::from_secs(180);
    while Instant::now() < deadline {
        ensure!(!cancelled.load(Ordering::Relaxed), "Sign-in cancelled");
        match listener.accept() {
            Ok((mut stream, _)) => {
                let Ok(target) = read_target(&mut stream) else {
                    reply(&mut stream, "400 Bad Request", "Invalid callback request.");
                    continue;
                };
                if !target.starts_with(&format!("{}?", flow.path)) {
                    reply(&mut stream, "404 Not Found", "Page not found.");
                    continue;
                }
                match callback_code_for(&target, state, flow) {
                    Ok(code) => {
                        reply(
                            &mut stream,
                            "200 OK",
                            "Authorization received. Return to SpotiFlex to finish sign-in.",
                        );
                        return Ok(code);
                    }
                    Err(_) => {
                        // An unrelated local request must not cancel the legitimate login.
                        reply(
                            &mut stream,
                            "400 Bad Request",
                            "Sign-in callback rejected. Return to SpotiFlex or retry sign-in.",
                        );
                        if callback_has_valid_denial(&target, state) {
                            bail!("Spotify sign-in was declined");
                        }
                    }
                }
            }
            Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                thread::sleep(Duration::from_millis(50))
            }
            Err(error) => return Err(error.into()),
        }
    }
    bail!(
        "Spotify browser authorization timed out after three minutes. Retry sign-in in Settings; your existing session is unchanged."
    )
}

fn callback_has_valid_denial(target: &str, state: &str) -> bool {
    let Ok(url) = Url::parse(&format!("http://127.0.0.1{target}")) else {
        return false;
    };
    let states: Vec<_> = url
        .query_pairs()
        .filter(|(key, _)| key == "state")
        .map(|(_, value)| value.into_owned())
        .collect();
    states == [state] && url.query_pairs().any(|(key, _)| key == "error")
}

pub fn login(client: &Client, client_id: &str, cancelled: &AtomicBool) -> Result<Tokens> {
    authorize(client, &app_flow(client_id), "127.0.0.1:43821", cancelled)
}

/// One-time browser authorization for native audio. Returns a short-lived
/// access token for librespot; its refresh token is discarded because
/// librespot's own reusable credentials are stored instead.
pub fn authorize_audio(client: &Client, cancelled: &AtomicBool) -> Result<String> {
    Ok(authorize(client, &AUDIO_FLOW, "127.0.0.1:8898", cancelled)?.access_token)
}

fn authorize(
    client: &Client,
    flow: &Flow<'_>,
    address: &str,
    cancelled: &AtomicBool,
) -> Result<Tokens> {
    ensure!(!cancelled.load(Ordering::Relaxed), "Sign-in cancelled");
    let verifier = random_string()?;
    let state = random_string()?;
    let url = authorization_url_for(flow, &verifier, &state)?;
    let listener = TcpListener::bind(address).with_context(|| {
        format!("Login port {address} is busy. Close other SpotiFlex or librespot apps and retry.")
    })?;
    ensure!(!cancelled.load(Ordering::Relaxed), "Sign-in cancelled");
    webbrowser::open(url.as_str()).context("Cannot open default browser for Spotify sign-in")?;
    let code = wait_for_code(&listener, &state, cancelled, flow)?;
    ensure!(!cancelled.load(Ordering::Relaxed), "Sign-in cancelled");
    exchange(
        client,
        &[
            ("grant_type", "authorization_code"),
            ("client_id", flow.client_id),
            ("code", &code),
            ("redirect_uri", flow.redirect_uri),
            ("code_verifier", &verifier),
        ],
        None,
    )
}

fn exchange(
    client: &Client,
    fields: &[(&str, &str)],
    previous_refresh: Option<&str>,
) -> Result<Tokens> {
    let response = client
        .post("https://accounts.spotify.com/api/token")
        .form(fields)
        .send()
        .map_err(|_| anyhow::anyhow!("Cannot reach Spotify sign-in service"))?;
    token_status(response.status(), previous_refresh.is_some())?;
    let result: TokenResponse = response
        .json()
        .context("Spotify returned an invalid token response")?;
    let refresh_token = result
        .refresh_token
        .or_else(|| previous_refresh.map(str::to_owned))
        .context("Spotify did not return a refresh token")?;
    ensure!(
        !result.access_token.is_empty() && !refresh_token.is_empty(),
        "Spotify returned empty credentials"
    );
    Ok(Tokens {
        access_token: result.access_token,
        refresh_token,
        expires_at: now() + result.expires_in,
        scopes: result.scope.unwrap_or_default(),
        profile: None,
    })
}

impl Tokens {
    pub fn refresh_if_needed(&mut self, client: &Client, client_id: &str) -> Result<()> {
        if self.expires_at <= now() + 60 {
            let mut refreshed = exchange(
                client,
                &[
                    ("grant_type", "refresh_token"),
                    ("client_id", client_id),
                    ("refresh_token", &self.refresh_token),
                ],
                Some(&self.refresh_token),
            )?;
            if refreshed.scopes.is_empty() {
                refreshed.scopes = self.scopes.clone();
            }
            refreshed.profile = self.profile.clone();
            *self = refreshed;
            self.save(client_id)?;
        }
        Ok(())
    }

    pub fn save(&self, client_id: &str) -> Result<()> {
        keyring::Entry::new("SpotiFlex/Spotify", client_id)?
            .set_password(&serde_json::to_string(self)?)
            .context("Cannot save login to the operating system credential store")
    }

    pub fn load(client_id: &str) -> Result<Option<Self>> {
        if !valid_client_id(client_id) {
            return Ok(None);
        }
        match keyring::Entry::new("SpotiFlex/Spotify", client_id)?.get_password() {
            Ok(value) => {
                Ok(Some(serde_json::from_str(&value).map_err(|_| {
                    anyhow::Error::new(SignInRequired::Damaged)
                })?))
            }
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(error) => Err(error).context("Cannot read saved Spotify login"),
        }
    }

    pub fn delete(client_id: &str) -> Result<()> {
        if !valid_client_id(client_id) {
            return Ok(());
        }
        match keyring::Entry::new("SpotiFlex/Spotify", client_id)?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(error) => Err(error).context("Cannot remove saved Spotify login"),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn recovery_distinguishes_rejected_credentials_from_temporary_service_failures() {
        for status in [400, 401, 403, 429, 500, 503] {
            let error = token_status(reqwest::StatusCode::from_u16(status).unwrap(), true)
                .unwrap_err()
                .context("Restore failed");
            let issue = LoginIssue::from_error(&error, true);
            assert_eq!(issue.retry_saved, status >= 429);
            assert!(!LoginIssue::from_error(&error, false).retry_saved);
        }
        assert!(!LoginIssue::from_error(&SignInRequired::Damaged.into(), true).retry_saved);
        assert!(token_status(reqwest::StatusCode::OK, true).is_ok());
    }

    #[test]
    fn pkce_matches_rfc_7636_test_vector() {
        assert_eq!(
            challenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"),
            "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"
        );
    }

    #[test]
    fn callback_rejects_mismatches_duplicates_and_denials() {
        assert_eq!(
            callback_code("/callback?code=hello%2Bworld&state=expected", "expected").unwrap(),
            "hello+world"
        );
        for target in [
            "/callback?code=secret&state=wrong",
            "/callback?code=secret",
            "/callback?code=a&code=b&state=expected",
            "/callback?code=a&state=expected&state=wrong",
            "/callback?error=access_denied&state=expected",
            "/other?code=a&state=expected",
        ] {
            assert!(callback_code(target, "expected").is_err());
        }
    }

    #[test]
    fn login_url_uses_pkce_loopback_and_no_secret() {
        let url =
            authorization_url("0123456789abcdef0123456789abcdef", "verifier", "state").unwrap();
        let parameters: std::collections::HashMap<_, _> = url.query_pairs().collect();
        assert_eq!(parameters["redirect_uri"], REDIRECT_URI);
        assert_eq!(parameters["code_challenge_method"], "S256");
        assert!(!parameters.contains_key("client_secret"));
        assert!(authorization_url("invalid", "verifier", "state").is_err());
    }

    #[test]
    fn audio_flow_uses_librespot_loopback_with_pkce_and_state() {
        let url = authorization_url_for(&AUDIO_FLOW, "verifier", "state").unwrap();
        let query: std::collections::HashMap<_, _> = url.query_pairs().into_owned().collect();
        assert_eq!(query["redirect_uri"], "http://127.0.0.1:8898/login");
        assert_eq!(query["scope"], "streaming");
        assert_eq!(query["code_challenge_method"], "S256");
        assert!(!query.contains_key("client_secret"));
        assert_eq!(
            callback_code_for("/login?code=abc&state=state", "state", &AUDIO_FLOW).unwrap(),
            "abc"
        );
        assert!(callback_code_for("/login?code=abc&state=other", "state", &AUDIO_FLOW).is_err());
        assert!(callback_code_for("/callback?code=abc&state=state", "state", &AUDIO_FLOW).is_err());
        assert_eq!(
            librespot_core::SessionConfig::default().client_id,
            AUDIO_CLIENT_ID
        );
    }

    #[test]
    fn cancelled_audio_login_stops_before_binding_or_opening_a_browser() {
        let client = http_client().unwrap();
        let error = authorize(
            &client,
            &AUDIO_FLOW,
            "invalid-listener-address",
            &AtomicBool::new(true),
        )
        .err()
        .expect("cancelled login must fail");
        assert_eq!(error.to_string(), "Sign-in cancelled");
    }

    #[test]
    fn local_callback_server_accepts_valid_request() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let sender = thread::spawn(move || {
            let mut stream = TcpStream::connect(address).unwrap();
            stream.write_all(b"GET /callback?state=expected&code=test-code HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n").unwrap();
            let mut response = String::new();
            stream.read_to_string(&mut response).unwrap();
            assert!(response.starts_with("HTTP/1.1 200 OK"));
            assert!(!response.contains("test-code"));
        });
        assert_eq!(
            wait_for_code(
                &listener,
                "expected",
                &AtomicBool::new(false),
                &app_flow("")
            )
            .unwrap(),
            "test-code"
        );
        sender.join().unwrap();
    }
}
