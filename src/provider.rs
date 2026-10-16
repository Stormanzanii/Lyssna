//! Deployment configuration stays in the OS credential store, separate from source.
use std::io::Read;

use anyhow::{Context, Result, bail, ensure};
use reqwest::blocking::Client;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};
use url::Url;

use crate::{
    lyrics::{Line, Lyrics, Word},
    model::Track,
};

const SERVICE: &str = "SpotiFlex/Lyrics";

#[derive(Serialize, Deserialize)]
struct Provider {
    host: String,
    share_access_token: bool,
    #[serde(default)]
    spicy_api: bool,
    #[serde(default)]
    api_key: String,
}

fn validate_host(host: &str) -> Result<Url> {
    let url = Url::parse(host).map_err(|_| anyhow::anyhow!("Enter a valid HTTPS lyrics host"))?;
    ensure!(
        url.scheme() == "https"
            && url
                .domain()
                .is_some_and(|domain| domain.contains('.') && domain != "localhost")
            && url.username().is_empty()
            && url.password().is_none()
            && url.port_or_known_default() == Some(443)
            && url.query().is_none()
            && url.fragment().is_none()
            && url.path() == "/",
        "Lyrics host must be an HTTPS domain without a path, credentials, or custom port"
    );
    Ok(url)
}

pub fn configure(host: &str, allow_access_token: bool) -> Result<()> {
    let host = validate_host(host.trim())?;
    let configuration = Provider {
        host: host.as_str().to_owned(),
        share_access_token: allow_access_token,
        spicy_api: false,
        api_key: String::new(),
    };
    keyring::Entry::new(SERVICE, "provider")?
        .set_password(&serde_json::to_string(&configuration)?)
        .map_err(|_| anyhow::anyhow!("Cannot store protected lyrics configuration"))
}

fn validate_public_key(key: &str) -> Result<()> {
    ensure!(
        !key.starts_with("sl_sk_"),
        "Use a publishable sl_pk_ key. Secret sl_sk_ keys cannot be stored in the desktop client."
    );
    ensure!(
        key.starts_with("sl_pk_")
            && (16..=512).contains(&key.len())
            && key
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || b"_-".contains(&byte)),
        "Enter a valid publishable sl_pk_ key"
    );
    Ok(())
}

pub fn configure_spicy(key: &str, consent: bool) -> Result<()> {
    ensure!(consent, "Confirm consent for Spicy Lyrics in Settings");
    let key = key.trim();
    validate_public_key(key)?;
    let configuration = Provider {
        host: "https://api.spicylyrics.org/".into(),
        share_access_token: false,
        spicy_api: true,
        api_key: key.to_owned(),
    };
    keyring::Entry::new(SERVICE, "provider")?
        .set_password(&serde_json::to_string(&configuration)?)
        .map_err(|_| anyhow::anyhow!("Cannot store protected lyrics configuration"))
}

pub fn requires_spotify_token() -> bool {
    load().is_ok_and(|provider| !provider.spicy_api)
}

pub fn configured() -> bool {
    load().is_ok()
}
pub fn builtin_configured() -> bool {
    option_env!("SPOTIFLEX_SPICY_LYRICS_KEY").is_some_and(|key| validate_public_key(key).is_ok())
}
pub fn kind() -> Option<String> {
    load().ok().map(|provider| {
        if provider.spicy_api {
            "spicy".to_owned()
        } else {
            "legacy".to_owned()
        }
    })
}

fn load() -> Result<Provider> {
    if let Some(key) =
        option_env!("SPOTIFLEX_SPICY_LYRICS_KEY").filter(|key| validate_public_key(key).is_ok())
    {
        return Ok(Provider {
            host: "https://api.spicylyrics.org/".into(),
            share_access_token: false,
            spicy_api: true,
            api_key: key.into(),
        });
    }
    let text = keyring::Entry::new(SERVICE, "provider")?
        .get_password()
        .map_err(|_| {
            anyhow::anyhow!(
                "Configure your protected lyrics host in Settings, or import local lyrics"
            )
        })?;
    let provider: Provider = serde_json::from_str(&text)
        .map_err(|_| anyhow::anyhow!("Protected lyrics configuration is invalid; save it again"))?;
    validate_host(&provider.host)?;
    Ok(provider)
}

pub fn cache_namespace() -> Result<String> {
    use sha2::{Digest, Sha256};
    let provider = load()?;
    Ok(format!(
        "{:x}",
        Sha256::digest(format!("v4:{}:{}", provider.spicy_api, provider.host).as_bytes())
    ))
}

pub fn fetch(client: &Client, track: &Track, access_token: &str) -> Result<Lyrics> {
    let provider = load()?;
    if provider.spicy_api {
        return fetch_spicy(client, track, &provider.api_key);
    }
    ensure!(
        provider.share_access_token,
        "Lyrics provider requires an access token. Enable consent in Settings or use local lyrics."
    );
    ensure!(
        !access_token.is_empty(),
        "Sign in before requesting provider lyrics"
    );
    let id = track
        .id
        .as_deref()
        .context("Provider lyrics are unavailable for local files")?;
    let url = validate_host(&provider.host)?.join("query")?;
    let response = client.post(url).header("X-mode", "2")
        .header("SpicyLyrics-Version", "100.10.50")
        .header("SpicyLyrics-WebAuth", format!("Bearer {access_token}"))
        .json(&json!({"queries":[{"operation":"lyrics","variables":{"id":id,"auth":"SpicyLyrics-WebAuth"}}],"client":{"version":"100.10.50"}}))
        .send().map_err(|_| anyhow::anyhow!("Cannot reach configured lyrics provider"))?;
    ensure!(
        response.status().is_success(),
        "Configured lyrics provider returned HTTP {}",
        response.status().as_u16()
    );
    let mut bytes = Vec::new();
    response
        .take(2_000_001)
        .read_to_end(&mut bytes)
        .map_err(|_| anyhow::anyhow!("Cannot read lyrics provider response"))?;
    ensure!(
        bytes.len() <= 2_000_000,
        "Lyrics provider response exceeds 2 MB"
    );
    let response: Value = serde_json::from_slice(&bytes)
        .map_err(|_| anyhow::anyhow!("Lyrics provider returned invalid JSON"))?;
    let result = response["queries"]
        .as_array()
        .and_then(|queries| {
            queries
                .iter()
                .find(|query| query["operationId"].as_str() == Some("0"))
        })
        .and_then(|query| query.get("result"))
        .context("Lyrics provider returned no result")?;
    let status = result["httpStatus"].as_u64().unwrap_or(0);
    if status == 503 {
        bail!("Provider is preparing lyrics. Retry shortly.");
    }
    ensure!(
        status == 200,
        "Lyrics provider could not return lyrics (status {status})"
    );
    let data = &result["data"];
    let data = if data.is_array() {
        unpack(data)?
    } else {
        data.clone()
    };
    parse(&data, track.duration_ms)
}

fn spicy_request(
    client: &Client,
    id: &str,
    key: &str,
) -> Result<reqwest::blocking::RequestBuilder> {
    validate_public_key(key)?;
    ensure!(
        id.len() == 22 && id.bytes().all(|byte| byte.is_ascii_alphanumeric()),
        "Lyrics require a 22-character Spotify track ID"
    );
    Ok(client
        .get(format!("https://api.spicylyrics.org/v1/lyrics/{id}"))
        .bearer_auth(key))
}

fn fetch_spicy(client: &Client, track: &Track, key: &str) -> Result<Lyrics> {
    let id = track
        .id
        .as_deref()
        .context("Provider lyrics are unavailable for local files")?;
    let response = spicy_request(client, id, key)?
        .send()
        .map_err(|_| anyhow::anyhow!("Cannot reach Spicy Lyrics"))?;
    match response.status().as_u16() {
        200 => {}
        401 => bail!("Spicy Lyrics key is invalid or expired. Update it in Settings."),
        403 => bail!(
            "Spicy Lyrics denied client access. Enable Client access and No origin header in its developer dashboard."
        ),
        404 => bail!("Spicy Lyrics has no lyrics for this track"),
        429 => bail!("Spicy Lyrics rate limit reached. Retry later."),
        status => bail!("Spicy Lyrics request failed (HTTP {status})"),
    }
    let mut bytes = Vec::new();
    response
        .take(2_000_001)
        .read_to_end(&mut bytes)
        .map_err(|_| anyhow::anyhow!("Cannot read Spicy Lyrics response"))?;
    ensure!(
        bytes.len() <= 2_000_000,
        "Lyrics provider response exceeds 2 MB"
    );
    let response: Value = serde_json::from_slice(&bytes)
        .map_err(|_| anyhow::anyhow!("Spicy Lyrics returned invalid JSON"))?;
    parse_spicy_response(&response, track.duration_ms)
}

fn parse_spicy_response(response: &Value, duration_ms: u64) -> Result<Lyrics> {
    ensure!(
        response["Status"].as_u64() == Some(200),
        "Spicy Lyrics did not return lyrics"
    );
    parse(
        response
            .get("Body")
            .context("Spicy Lyrics response has no Body")?,
        duration_ms,
    )
}

fn seconds(value: &Value) -> Option<u64> {
    let value = value.as_f64()?;
    (value.is_finite() && (0.0..=604_800.0).contains(&value))
        .then_some((value * 1000.0).round() as u64)
}

pub fn parse(value: &Value, duration_ms: u64) -> Result<Lyrics> {
    let kind = value["Type"]
        .as_str()
        .context("Unknown provider lyrics format")?;
    ensure!(
        ["Static", "Line", "Syllable"].contains(&kind),
        "Unsupported provider lyrics format"
    );
    let synced = kind != "Static";
    let content = value[if synced { "Content" } else { "Lines" }]
        .as_array()
        .context("Provider lyrics have no lines")?;
    let mut lines = Vec::new();
    for entry in content {
        if synced && entry["Type"].as_str() != Some("Vocal") {
            continue;
        }
        let lead = entry.get("Lead").unwrap_or(entry);
        let start = seconds(&entry["StartTime"])
            .or_else(|| seconds(&lead["StartTime"]))
            .unwrap_or(0);
        let end = seconds(&entry["EndTime"])
            .or_else(|| seconds(&lead["EndTime"]))
            .unwrap_or(duration_ms);
        let mut line = parse_line(lead, start, end);
        if line.text.is_empty() {
            line.text = entry["Text"].as_str().unwrap_or_default().into();
        }
        let opposite = entry["OppositeAligned"].as_bool().unwrap_or(false);
        line.opposite = opposite;
        if !line.text.is_empty() {
            lines.push((start, line));
        }
        if let Some(background) = entry["Background"].as_array() {
            for vocal in background {
                let mut line = parse_line(vocal, start, end);
                line.background = true;
                line.opposite = opposite;
                crate::lyrics::fit_to_words(&mut line);
                crate::lyrics::strip_background_parentheses(&mut line);
                if !line.text.is_empty() {
                    lines.push((start, line));
                }
            }
        }
    }
    ensure!(!lines.is_empty(), "Provider returned empty lyrics");
    let lines = crate::lyrics::order_with_background(lines);
    Ok(Lyrics {
        lines,
        source: value["source"]
            .as_str()
            .unwrap_or("Lyrics provider")
            .to_owned(),
        attribution: value
            .get("UploadAttribution")
            .filter(|_| value["source"].as_str() == Some("spicy_lyrics"))
            .and_then(|value| serde_json::from_value(value.clone()).ok()),
        synced,
        instrumental: false,
        songwriters: ["SongWriters", "Songwriters", "songwriters", "Writers"]
            .iter()
            .find_map(|key| value[*key].as_array())
            .map(|writers| {
                writers
                    .iter()
                    .take(100)
                    .filter_map(|writer| writer.as_str().or_else(|| writer["name"].as_str()))
                    .map(str::to_owned)
                    .collect()
            })
            .unwrap_or_default(),
    })
}

fn parse_line(value: &Value, start_ms: u64, end_ms: u64) -> Line {
    let mut line = Line {
        start_ms,
        end_ms,
        text: value["Text"].as_str().unwrap_or_default().into(),
        romanization: value["TransliteratedText"]
            .as_str()
            .unwrap_or_default()
            .into(),
        translation: value["TranslatedText"].as_str().unwrap_or_default().into(),
        ..Line::default()
    };
    if let Some(syllables) = value["Syllables"].as_array() {
        for (index, syllable) in syllables.iter().enumerate() {
            let text = syllable["Text"].as_str().unwrap_or_default();
            let prefix = if index > 0
                && !syllables[index - 1]["IsPartOfWord"]
                    .as_bool()
                    .unwrap_or(false)
            {
                " "
            } else {
                ""
            };
            line.words.push(Word {
                start_ms: seconds(&syllable["StartTime"]).unwrap_or(start_ms),
                end_ms: seconds(&syllable["EndTime"]).unwrap_or(end_ms),
                text: format!("{prefix}{text}"),
            });
        }
        line.text = line.words.iter().map(|word| word.text.as_str()).collect();
        let romanized = syllables
            .iter()
            .map(|syllable| syllable["TransliteratedText"].as_str().unwrap_or_default())
            .collect::<Vec<_>>()
            .join(" ");
        if !romanized.trim().is_empty() {
            line.romanization = romanized;
        }
    }
    line
}

/// Decode the provider's dictionary and instruction stream with fixed work limits.
pub fn unpack(value: &Value) -> Result<Value> {
    let payload = value.as_array().context("Invalid packed lyrics")?;
    ensure!(payload.len() == 2, "Invalid packed lyrics");
    let values = payload[0].as_array().context("Invalid packed dictionary")?;
    let stream = payload[1].as_array().context("Invalid packed stream")?;
    ensure!(
        values.len() <= 100_000
            && stream.len() <= 200_000
            && values
                .iter()
                .all(|value| !value.is_object() && !value.is_array()),
        "Packed lyrics exceed limits"
    );
    let mut decoder = Decoder {
        values,
        stream,
        cursor: 0,
        budget: 200_000,
        bytes_remaining: 4_000_000,
    };
    let result = decoder.value(0)?;
    ensure!(
        decoder.cursor == stream.len(),
        "Trailing packed lyrics data"
    );
    Ok(result)
}

struct Decoder<'a> {
    values: &'a [Value],
    stream: &'a [Value],
    cursor: usize,
    budget: usize,
    bytes_remaining: usize,
}

impl Decoder<'_> {
    fn integer(&mut self) -> Result<i64> {
        let value = self
            .stream
            .get(self.cursor)
            .and_then(Value::as_i64)
            .context("Invalid packed instruction")?;
        self.cursor += 1;
        Ok(value)
    }

    fn count(&mut self) -> Result<usize> {
        let count = usize::try_from(self.integer()?).context("Negative packed count")?;
        ensure!(count <= self.budget, "Packed lyrics work limit exceeded");
        self.budget -= count;
        Ok(count)
    }

    fn keys(&mut self, count: usize) -> Result<Vec<String>> {
        let mut keys = Vec::with_capacity(count);
        for _ in 0..count {
            let pointer = usize::try_from(self.integer()?).context("Invalid dictionary pointer")?;
            let key = self
                .values
                .get(pointer)
                .and_then(Value::as_str)
                .context("Invalid packed object key")?;
            ensure!(
                !["__proto__", "constructor", "prototype"].contains(&key),
                "Rejected packed object key"
            );
            ensure!(
                key.len() <= self.bytes_remaining,
                "Packed lyrics expansion limit exceeded"
            );
            self.bytes_remaining -= key.len();
            keys.push(key.to_owned());
        }
        Ok(keys)
    }

    fn object(&mut self, keys: &[String], depth: usize) -> Result<Value> {
        let mut object = Map::new();
        for key in keys {
            ensure!(
                key.len() <= self.bytes_remaining,
                "Packed lyrics expansion limit exceeded"
            );
            self.bytes_remaining -= key.len();
            object.insert(key.clone(), self.value(depth + 1)?);
        }
        Ok(Value::Object(object))
    }

    fn value(&mut self, depth: usize) -> Result<Value> {
        ensure!(
            depth <= 64 && self.budget > 0,
            "Packed lyrics nesting or work limit exceeded"
        );
        self.budget -= 1;
        let instruction = self.integer()?;
        match instruction {
            0.. => {
                let value = self
                    .values
                    .get(instruction as usize)
                    .context("Invalid packed dictionary pointer")?;
                let size = value.as_str().map_or(16, str::len);
                ensure!(
                    size <= self.bytes_remaining,
                    "Packed lyrics expansion limit exceeded"
                );
                self.bytes_remaining -= size;
                Ok(value.clone())
            }
            -1 => {
                let count = self.count()?;
                let keys = self.keys(count)?;
                self.object(&keys, depth)
            }
            -2 => {
                let count = self.count()?;
                Ok(Value::Array(
                    (0..count)
                        .map(|_| self.value(depth + 1))
                        .collect::<Result<_>>()?,
                ))
            }
            -3 => {
                let rows = self.count()?;
                let columns = self.count()?;
                ensure!(
                    rows.saturating_mul(columns) <= self.budget,
                    "Packed schema work limit exceeded"
                );
                let keys = self.keys(columns)?;
                Ok(Value::Array(
                    (0..rows)
                        .map(|_| self.object(&keys, depth))
                        .collect::<Result<_>>()?,
                ))
            }
            -4 => Ok(json!([])),
            -5 => Ok(Value::Array(vec![self.value(depth + 1)?])),
            -6 => Ok(json!({})),
            _ => bail!("Unknown packed lyrics instruction"),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn direct_requests_use_only_publishable_key_and_valid_track_id() {
        let client = crate::auth::http_client().unwrap();
        let request = spicy_request(
            &client,
            "0123456789abcdefghijkl",
            "sl_pk_example_publishable_key",
        )
        .unwrap()
        .build()
        .unwrap();
        assert_eq!(request.method(), reqwest::Method::GET);
        assert_eq!(request.url().path(), "/v1/lyrics/0123456789abcdefghijkl");
        assert!(
            request
                .headers()
                .get("authorization")
                .unwrap()
                .to_str()
                .unwrap()
                .starts_with("Bearer sl_pk_")
        );
        assert!(!request.headers().contains_key("origin"));
        assert!(!request.headers().contains_key("SpicyLyrics-WebAuth"));
        assert!(
            spicy_request(
                &client,
                "0123456789abcdefghijkl",
                "sl_sk_example_secret_key"
            )
            .is_err()
        );
        assert!(spicy_request(&client, "../bad", "sl_pk_example_publishable_key").is_err());
    }
    #[test]
    fn response_preserves_source_and_credits_through_cache_round_trip() {
        let mut data = json!({"Status":200,"Body":{"Type":"Static","Lines":[{"Text":"Hello"}],"source":"spicy_lyrics","UploadAttribution":{"Uploader":{"id":"1","username":"Uploader","url":"https://spicylyrics.org/uid/1"},"Maker":{"id":"2","username":"Maker","url":"https://spicylyrics.org/uid/2"}}}});
        let lyrics = parse_spicy_response(&data, 1000).unwrap();
        let cached: Lyrics = serde_json::from_slice(&serde_json::to_vec(&lyrics).unwrap()).unwrap();
        assert_eq!(cached.source, "spicy_lyrics");
        assert_eq!(cached.attribution.unwrap().maker.unwrap().username, "Maker");
        data["Body"]["source"] = json!("apple_music");
        assert!(
            parse_spicy_response(&data, 1000)
                .unwrap()
                .attribution
                .is_none()
        );
        data["Status"] = json!(404);
        assert!(parse_spicy_response(&data, 1000).is_err());
    }

    #[test]
    fn packed_strings_cannot_expand_past_memory_budget() {
        let mut stream = vec![json!(-2), json!(100)];
        stream.extend(std::iter::repeat_n(json!(0), 100));
        let packed = json!([["x".repeat(64_000)], stream]);
        assert!(
            unpack(&packed)
                .unwrap_err()
                .to_string()
                .contains("expansion limit")
        );
    }

    #[test]
    fn host_rejects_plaintext_credentials_paths_and_redirect_parameters() {
        assert!(validate_host("https://lyrics.example.com").is_ok());
        for host in [
            "http://lyrics.example.com",
            "https://name:password@lyrics.example.com",
            "https://lyrics.example.com/path",
            "https://lyrics.example.com?redirect=somewhere",
            "https://127.0.0.1",
            "https://lyrics.example.com:444",
        ] {
            assert!(validate_host(host).is_err());
        }
    }

    #[test]
    fn packed_decoder_handles_schema_and_rejects_trailing_or_oversized_data() {
        assert_eq!(
            unpack(&json!([["Text", "Hello", "World"], [-3, 2, 1, 0, 1, 2]])).unwrap(),
            json!([{"Text":"Hello"},{"Text":"World"}])
        );
        assert!(unpack(&json!([["Hello"], [0, 0]])).is_err());
        assert!(unpack(&json!([[], [-2, 9999999]])).is_err());
        assert!(unpack(&json!([["__proto__"], [-1, 1, 0, -6]])).is_err());
    }

    #[test]
    fn provider_syllables_keep_spacing_timing_and_background() {
        let data = json!({"Type":"Syllable","Content":[{"Type":"Vocal","StartTime":1.0,"EndTime":4.0,"Lead":{"Syllables":[{"Text":"Hel","IsPartOfWord":true,"StartTime":1.0,"EndTime":1.5},{"Text":"lo","StartTime":1.5,"EndTime":2.0},{"Text":"world","StartTime":2.0,"EndTime":3.0}]},"Background":[{"Text":"echo"}]}]});
        let lyrics = parse(&data, 5000).unwrap();
        assert_eq!(lyrics.lines[0].text, "Hello world");
        assert_eq!(lyrics.lines[0].words[1].start_ms, 1500);
        assert!(lyrics.lines[1].background);
    }
}
