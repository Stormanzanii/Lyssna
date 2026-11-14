use std::collections::HashMap;
use std::io::Read;
use std::sync::{Arc, LazyLock, Mutex, OnceLock};
use std::time::{Duration, Instant};

use anyhow::{Context, Result, ensure};
use serde_json::Value;

pub const DEFAULT_ENDPOINT: &str = "https://discord-lookup.lookupbotdc.workers.dev/search/";

const FOUND_FOR: Duration = Duration::from_secs(5 * 60);
const FAILED_FOR: Duration = Duration::from_secs(30);
const LIMITED_FOR: Duration = Duration::from_secs(60);
const TIMEOUT: Duration = Duration::from_secs(5);

#[derive(Clone, Debug, PartialEq)]
enum Outcome {
    Found(String),
    Failed,
    Limited(Duration),
}

impl Outcome {
    fn lasts(&self) -> Duration {
        match self {
            Outcome::Found(_) => FOUND_FOR,
            Outcome::Failed => FAILED_FOR,
            Outcome::Limited(wait) => *wait,
        }
    }
}

struct Entry {
    started: Instant,
    outcome: Arc<OnceLock<Outcome>>,
}

static ENTRIES: LazyLock<Mutex<HashMap<String, Entry>>> = LazyLock::new(Default::default);
static PAUSED_UNTIL: Mutex<Option<Instant>> = Mutex::new(None);

pub fn valid_id(id: &str) -> bool {
    (15..=20).contains(&id.len()) && id.bytes().all(|byte| byte.is_ascii_digit())
}

/// Discord username for `id`, or `None` while it cannot be looked up.
/// Callers asking for the same ID at once share one request.
pub fn username(endpoint: &str, id: &str) -> Option<String> {
    if !valid_id(id) {
        return None;
    }
    resolve(id, || fetch(endpoint, id))
}

fn resolve(id: &str, fetch: impl FnOnce() -> Outcome) -> Option<String> {
    let outcome = {
        let mut entries = ENTRIES.lock().ok()?;
        let fresh = entries
            .get(id)
            .is_some_and(|entry| match entry.outcome.get() {
                Some(done) => entry.started.elapsed() < done.lasts(),
                None => true,
            });
        if !fresh {
            if entries.len() >= 512 {
                entries.retain(|_, entry| entry.outcome.get().is_none());
            }
            entries.insert(
                id.to_owned(),
                Entry {
                    started: Instant::now(),
                    outcome: Arc::default(),
                },
            );
        }
        entries.get(id)?.outcome.clone()
    };
    match outcome.get_or_init(fetch) {
        Outcome::Found(name) => Some(name.clone()),
        _ => None,
    }
}

fn fetch(endpoint: &str, id: &str) -> Outcome {
    if PAUSED_UNTIL
        .lock()
        .ok()
        .and_then(|until| *until)
        .is_some_and(|until| Instant::now() < until)
    {
        return Outcome::Failed;
    }
    let outcome = request(endpoint, id).unwrap_or(Outcome::Failed);
    // The service limits everyone at once, so a 429 pauses every lookup.
    if let Outcome::Limited(wait) = outcome
        && let Ok(mut until) = PAUSED_UNTIL.lock()
    {
        *until = Some(Instant::now() + wait);
    }
    outcome
}

fn request(endpoint: &str, id: &str) -> Result<Outcome> {
    let url = lookup_url(endpoint, id)?;
    let client = reqwest::blocking::Client::builder()
        .timeout(TIMEOUT)
        .redirect(reqwest::redirect::Policy::none())
        .user_agent("Lyssna")
        .build()?;
    let response = client
        .get(url)
        .header(reqwest::header::ACCEPT, "application/json")
        .send()?;
    let status = response.status().as_u16();
    if status == 429 {
        let wait = response
            .headers()
            .get(reqwest::header::RETRY_AFTER)
            .and_then(|value| value.to_str().ok()?.trim().parse::<u64>().ok())
            .map_or(LIMITED_FOR, |seconds| {
                Duration::from_secs(seconds.clamp(5, 600))
            });
        return Ok(Outcome::Limited(wait));
    }
    if !(200..300).contains(&status) {
        return Ok(Outcome::Failed);
    }
    let mut bytes = Vec::new();
    response.take(64 * 1024 + 1).read_to_end(&mut bytes)?;
    ensure!(bytes.len() <= 64 * 1024, "Discord lookup answer too large");
    Ok(parse(&bytes, id).map_or(Outcome::Failed, Outcome::Found))
}

pub fn lookup_url(endpoint: &str, id: &str) -> Result<reqwest::Url> {
    let base = reqwest::Url::parse(endpoint.trim()).context("Invalid Discord lookup URL")?;
    ensure!(
        base.scheme() == "https" && base.username().is_empty() && base.password().is_none(),
        "Discord lookup URL must be plain HTTPS"
    );
    let mut url = base;
    url.path_segments_mut()
        .map_err(|_| anyhow::anyhow!("Invalid Discord lookup URL"))?
        .pop_if_empty()
        .push(id);
    Ok(url)
}

/// Reads `user.username`; IDs stay strings, since they exceed what a JSON
/// number can hold exactly in JavaScript.
fn parse(bytes: &[u8], id: &str) -> Option<String> {
    let body: Value = serde_json::from_slice(bytes).ok()?;
    let user = body.get("user")?;
    if user.get("id")?.as_str()? != id {
        return None;
    }
    let name = user.get("username")?.as_str()?.trim();
    (!name.is_empty() && name.len() <= 64).then(|| name.to_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_the_username_for_the_requested_id_only() {
        let body =
            br#"{"user":{"id":"155149108183695360","username":"Dyno","global_name":"Dyno Bot"}}"#;
        assert_eq!(parse(body, "155149108183695360").as_deref(), Some("Dyno"));
        assert_eq!(parse(body, "155149108183695361"), None);
        for bad in [
            &br#"{"user":{"id":155149108183695360,"username":"Dyno"}}"#[..],
            br#"{"user":{"id":"155149108183695360","username":""}}"#,
            br#"{"user":{"id":"155149108183695360"}}"#,
            br#"{"error":"not found"}"#,
            b"<html>",
        ] {
            assert_eq!(parse(bad, "155149108183695360"), None);
        }
    }

    #[test]
    fn lookup_url_appends_the_id_and_needs_https() {
        for endpoint in [DEFAULT_ENDPOINT, DEFAULT_ENDPOINT.trim_end_matches('/')] {
            assert_eq!(
                lookup_url(endpoint, "155149108183695360").unwrap().as_str(),
                "https://discord-lookup.lookupbotdc.workers.dev/search/155149108183695360"
            );
        }
        assert!(lookup_url("http://example.com/search/", "1").is_err());
        assert!(lookup_url("https://user:pass@example.com/", "1").is_err());
        assert!(!valid_id("12345"));
        assert!(!valid_id("1551491081836953600000"));
        assert!(!valid_id("15514910818369536a"));
        assert!(valid_id("155149108183695360"));
    }

    #[test]
    fn simultaneous_lookups_share_one_request() {
        use std::sync::atomic::{AtomicUsize, Ordering};
        static CALLS: AtomicUsize = AtomicUsize::new(0);
        let waiting: Vec<_> = (0..4)
            .map(|_| {
                std::thread::spawn(|| {
                    resolve("999999999999999991", || {
                        CALLS.fetch_add(1, Ordering::SeqCst);
                        std::thread::sleep(Duration::from_millis(100));
                        Outcome::Found("shared".into())
                    })
                })
            })
            .collect();
        for handle in waiting {
            assert_eq!(handle.join().unwrap().as_deref(), Some("shared"));
        }
        assert_eq!(CALLS.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn failures_are_remembered_briefly_without_retrying() {
        use std::sync::atomic::{AtomicUsize, Ordering};
        static CALLS: AtomicUsize = AtomicUsize::new(0);
        let fail = || {
            CALLS.fetch_add(1, Ordering::SeqCst);
            Outcome::Failed
        };
        assert_eq!(resolve("999999999999999992", fail), None);
        assert_eq!(resolve("999999999999999992", fail), None);
        assert_eq!(CALLS.load(Ordering::SeqCst), 1);
        assert!(FAILED_FOR < FOUND_FOR);
        assert_eq!(FOUND_FOR, Duration::from_secs(300));
    }
}
