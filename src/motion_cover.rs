use std::{
    collections::HashMap,
    path::PathBuf,
    sync::{LazyLock, Mutex},
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use anyhow::{Context, Result, bail, ensure};
use base64::Engine;
use reqwest::blocking::Client;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::native::NativeControls;

// Apple Music's motion artwork, found through the public token its web player
// ships. The token is read from the site at runtime, kept until it expires,
// and read again whenever Apple rotates or rejects it.
const SITE: &str = "https://music.apple.com";
const API: &str = "https://amp-api.music.apple.com";
const STOREFRONT: &str = "us";
const VIDEO_HOST: &str = "mvod.itunes.apple.com";
const TARGET_SIZE: u32 = 720;
const HIT_DAYS: u64 = 30;
const MISS_DAYS: u64 = 7;

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct MotionCover {
    pub avc: Option<String>,
    pub hevc: Option<String>,
}

#[derive(Serialize, Deserialize)]
struct Entry {
    cover: Option<MotionCover>,
    checked: u64,
}

#[derive(Default, Serialize, Deserialize)]
struct Store {
    token: Option<(String, u64)>,
    albums: HashMap<String, Entry>,
}

static STORE: LazyLock<Mutex<Option<Store>>> = LazyLock::new(|| Mutex::new(None));

fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|time| time.as_secs())
        .unwrap_or_default()
}

fn path() -> Result<PathBuf> {
    ensure!(!cfg!(test), "Tests keep the cache in memory");
    Ok(crate::config::data_dir()?.join("motion-covers.json"))
}

fn with_store<T>(work: impl FnOnce(&mut Store) -> T) -> T {
    let mut guard = STORE
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let store = guard.get_or_insert_with(|| {
        path()
            .ok()
            .and_then(|path| std::fs::read(path).ok())
            .and_then(|bytes| serde_json::from_slice(&bytes).ok())
            .unwrap_or_default()
    });
    work(store)
}

fn save() {
    let bytes = with_store(|store| {
        let now = now();
        store
            .albums
            .retain(|_, entry| now.saturating_sub(entry.checked) < HIT_DAYS * 86_400);
        serde_json::to_vec(store)
    });
    if let (Ok(bytes), Ok(path)) = (bytes, path()) {
        let _ = std::fs::write(path, bytes);
    }
}

fn client() -> Result<Client> {
    Ok(Client::builder()
        .connect_timeout(Duration::from_secs(10))
        .timeout(Duration::from_secs(20))
        .redirect(reqwest::redirect::Policy::custom(|attempt| {
            let apple = attempt.url().scheme() == "https"
                && attempt
                    .url()
                    .host_str()
                    .is_some_and(|host| host == "apple.com" || host.ends_with(".apple.com"));
            if apple && attempt.previous().len() < 5 {
                attempt.follow()
            } else {
                attempt.stop()
            }
        }))
        .user_agent("Mozilla/5.0")
        .build()?)
}

fn text(client: &Client, url: &str, limit: usize) -> Result<String> {
    let response = client.get(url).send()?.error_for_status()?;
    let bytes = response.bytes()?;
    ensure!(bytes.len() <= limit, "Response too large");
    Ok(String::from_utf8_lossy(&bytes).into_owned())
}

/// The web player's token inside one of its scripts, if it is still valid.
fn find_token(script: &str, now: u64) -> Option<(String, u64)> {
    let token_char = |c: char| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.');
    let mut rest = script;
    while let Some(at) = rest.find("eyJ") {
        let candidate: String = rest[at..].chars().take_while(|&c| token_char(c)).collect();
        rest = &rest[at + 3..];
        let parts: Vec<&str> = candidate.split('.').collect();
        if parts.len() != 3 || parts.iter().any(|part| part.is_empty()) {
            continue;
        }
        let Ok(payload) =
            base64::engine::general_purpose::URL_SAFE_NO_PAD.decode(parts[1].trim_end_matches('='))
        else {
            continue;
        };
        let Ok(claims) = serde_json::from_slice::<Value>(&payload) else {
            continue;
        };
        let expires = claims["exp"].as_u64().unwrap_or_default();
        if claims["iss"] == "AMPWebPlay" && expires > now {
            return Some((candidate, expires));
        }
    }
    None
}

fn scripts(page: &str) -> Vec<String> {
    let mut found = Vec::new();
    let mut rest = page;
    while let Some(at) = rest.find("/assets/") {
        let path: String = rest[at..]
            .chars()
            .take_while(|&c| !matches!(c, '"' | '\'' | ' ' | '>' | ')'))
            .collect();
        rest = &rest[at + 8..];
        if path.ends_with(".js")
            && path[8..].starts_with("index")
            && path.len() < 200
            && !found.contains(&path)
        {
            found.push(path);
        }
    }
    found
}

fn token(client: &Client, fresh: bool) -> Result<String> {
    let now = now();
    if !fresh
        && let Some((token, _)) =
            with_store(|store| store.token.clone()).filter(|(_, expires)| *expires > now + 3_600)
    {
        return Ok(token);
    }
    let page = text(client, &format!("{SITE}/{STOREFRONT}/browse"), 4_000_000)?;
    for script in scripts(&page) {
        let Ok(body) = text(client, &format!("{SITE}{script}"), 16_000_000) else {
            continue;
        };
        if let Some(found) = find_token(&body, now) {
            with_store(|store| store.token = Some(found.clone()));
            save();
            return Ok(found.0);
        }
    }
    bail!("Apple Music token not found")
}

struct Rejected;

fn songs(client: &Client, token: &str, isrc: &str) -> Result<std::result::Result<Value, Rejected>> {
    let url = format!(
        "{API}/v1/catalog/{STOREFRONT}/songs?filter%5Bisrc%5D={isrc}&include=albums&extend%5Balbums%5D=editorialVideo"
    );
    let response = client
        .get(url)
        .bearer_auth(token)
        .header("Origin", SITE)
        .send()?;
    if matches!(response.status().as_u16(), 401 | 403) {
        return Ok(Err(Rejected));
    }
    let bytes = response.error_for_status()?.bytes()?;
    ensure!(bytes.len() <= 4_000_000, "Response too large");
    Ok(Ok(serde_json::from_slice(&bytes)?))
}

fn folded(name: &str) -> String {
    name.chars()
        .filter(|c| c.is_alphanumeric())
        .flat_map(char::to_lowercase)
        .collect()
}

/// The square motion artwork playlist, preferring the album Spotify names.
fn pick_master(songs: &Value, album: &str) -> Option<String> {
    let wanted = folded(album);
    let mut first = None;
    for song in songs["data"].as_array()? {
        for entry in song["relationships"]["albums"]["data"].as_array()? {
            let attributes = &entry["attributes"];
            let video = &attributes["editorialVideo"];
            let Some(url) = video["motionSquareVideo1x1"]["video"]
                .as_str()
                .or_else(|| video["motionDetailSquare"]["video"].as_str())
            else {
                continue;
            };
            if !wanted.is_empty()
                && attributes["name"]
                    .as_str()
                    .is_some_and(|name| folded(name) == wanted)
            {
                return Some(url.to_owned());
            }
            first.get_or_insert_with(|| url.to_owned());
        }
    }
    first
}

fn attribute<'a>(line: &'a str, name: &str) -> Option<&'a str> {
    let at = line.find(&format!("{name}="))? + name.len() + 1;
    let rest = &line[at..];
    Some(match rest.strip_prefix('"') {
        Some(quoted) => &quoted[..quoted.find('"')?],
        None => rest.split(',').next()?,
    })
}

/// The variant playlists to use: per codec, the smallest SDR square at least
/// TARGET_SIZE wide, or the largest below it.
fn pick_variants(master: &str) -> (Option<String>, Option<String>) {
    let mut best: [Option<(u32, String)>; 2] = [None, None];
    let mut lines = master.lines();
    while let Some(line) = lines.next() {
        let Some(info) = line.strip_prefix("#EXT-X-STREAM-INF:") else {
            continue;
        };
        let Some(uri) = lines.next().map(str::trim) else {
            break;
        };
        if attribute(info, "VIDEO-RANGE").is_some_and(|range| range != "SDR") {
            continue;
        }
        let codecs = attribute(info, "CODECS").unwrap_or_default();
        let slot = if codecs.starts_with("avc1") {
            0
        } else if codecs.starts_with("hvc1") || codecs.starts_with("hev1") {
            1
        } else {
            continue;
        };
        let Some(width) = attribute(info, "RESOLUTION")
            .and_then(|size| size.split('x').next())
            .and_then(|width| width.parse::<u32>().ok())
        else {
            continue;
        };
        let better = match &best[slot] {
            None => true,
            Some((current, _)) => {
                if *current >= TARGET_SIZE {
                    width >= TARGET_SIZE && width < *current
                } else {
                    width > *current
                }
            }
        };
        if better {
            best[slot] = Some((width, uri.to_owned()));
        }
    }
    let [avc, hevc] = best;
    (avc.map(|(_, uri)| uri), hevc.map(|(_, uri)| uri))
}

fn trusted_video(url: &url::Url) -> bool {
    url.scheme() == "https"
        && url.host_str() == Some(VIDEO_HOST)
        && url.username().is_empty()
        && url.password().is_none()
        && url.port_or_known_default() == Some(443)
}

/// A variant playlist is one fragmented MP4 read by byte ranges, so the file
/// itself plays in a video element without an HLS player.
fn video_file(client: &Client, base: &url::Url, variant: &str) -> Result<String> {
    let playlist = base.join(variant)?;
    ensure!(trusted_video(&playlist), "Untrusted video host");
    let body = text(client, playlist.as_str(), 1_000_000)?;
    let file = body
        .lines()
        .find_map(|line| {
            line.strip_prefix("#EXT-X-MAP:")
                .and_then(|map| attribute(map, "URI"))
        })
        .context("Video file missing")?;
    let url = playlist.join(file)?;
    ensure!(trusted_video(&url), "Untrusted video host");
    Ok(url.into())
}

fn cover(client: &Client, master: &str) -> Result<Option<MotionCover>> {
    let base = url::Url::parse(master)?;
    ensure!(trusted_video(&base), "Untrusted video host");
    let (avc, hevc) = pick_variants(&text(client, master, 1_000_000)?);
    let cover = MotionCover {
        avc: avc.and_then(|variant| video_file(client, &base, &variant).ok()),
        hevc: hevc.and_then(|variant| video_file(client, &base, &variant).ok()),
    };
    Ok((cover.avc.is_some() || cover.hevc.is_some()).then_some(cover))
}

fn look_up(controls: &NativeControls, track: &str, album: &str) -> Result<Option<MotionCover>> {
    let Some(isrc) = controls.isrc(track)? else {
        return Ok(None);
    };
    let client = client()?;
    let found = match songs(&client, &token(&client, false)?, &isrc)? {
        Ok(found) => found,
        Err(Rejected) => match songs(&client, &token(&client, true)?, &isrc)? {
            Ok(found) => found,
            Err(Rejected) => bail!("Apple Music rejected the token"),
        },
    };
    match pick_master(&found, album) {
        Some(master) => cover(&client, &master),
        None => Ok(None),
    }
}

pub fn resolve(
    controls: &NativeControls,
    track: &str,
    album_id: Option<&str>,
    album_name: &str,
) -> Result<Option<MotionCover>> {
    let key = album_id.unwrap_or(track).to_owned();
    let now = now();
    if let Some(cover) = with_store(|store| {
        store.albums.get(&key).and_then(|entry| {
            let days = if entry.cover.is_some() {
                HIT_DAYS
            } else {
                MISS_DAYS
            };
            (now.saturating_sub(entry.checked) < days * 86_400).then(|| entry.cover.clone())
        })
    }) {
        return Ok(cover);
    }
    // Network failures are not remembered, so the next play tries again.
    let cover = look_up(controls, track, album_name)?;
    with_store(|store| {
        store.albums.insert(
            key,
            Entry {
                cover: cover.clone(),
                checked: now,
            },
        )
    });
    save();
    Ok(cover)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn jwt(claims: &str) -> String {
        let encode = |text: &str| base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(text);
        format!("{}.{}.sig", encode(r#"{"alg":"ES256"}"#), encode(claims))
    }

    #[test]
    fn finds_only_a_live_web_player_token() {
        let live = jwt(r#"{"iss":"AMPWebPlay","exp":2000}"#);
        let other = jwt(r#"{"iss":"Someone","exp":2000}"#);
        let old = jwt(r#"{"iss":"AMPWebPlay","exp":500}"#);
        let script = format!(r#"a="{other}";b="{old}";c="{live}";"#);
        assert_eq!(find_token(&script, 1000), Some((live, 2000)));
        assert_eq!(find_token(&format!("x={old}"), 1000), None);
    }

    #[test]
    fn finds_index_scripts_once() {
        let page = r#"<script src="/assets/index~ab12.js"></script><link href="/assets/index~ab12.js"><script src="/assets/vendor~x.js"></script>"#;
        assert_eq!(scripts(page), vec!["/assets/index~ab12.js".to_owned()]);
    }

    #[test]
    fn prefers_the_album_spotify_names() {
        let songs = serde_json::json!({"data":[
            {"relationships":{"albums":{"data":[{"attributes":{"name":"Deluxe","editorialVideo":{"motionSquareVideo1x1":{"video":"https://mvod.itunes.apple.com/a.m3u8"}}}}]}}},
            {"relationships":{"albums":{"data":[{"attributes":{"name":"Single","editorialVideo":{}}}]}}},
            {"relationships":{"albums":{"data":[{"attributes":{"name":"Midnights","editorialVideo":{"motionDetailSquare":{"video":"https://mvod.itunes.apple.com/b.m3u8"}}}}]}}}
        ]});
        assert_eq!(
            pick_master(&songs, "Midnights").as_deref(),
            Some("https://mvod.itunes.apple.com/b.m3u8")
        );
        assert_eq!(
            pick_master(&songs, "Something else").as_deref(),
            Some("https://mvod.itunes.apple.com/a.m3u8")
        );
    }

    #[test]
    fn picks_the_smallest_square_at_or_over_the_target_per_codec() {
        let master = r#"#EXTM3U
#EXT-X-I-FRAME-STREAM-INF:CODECS="avc1.64001f",RESOLUTION=486x486,URI="trick.m3u8"
#EXT-X-STREAM-INF:BANDWIDTH=1,VIDEO-RANGE=SDR,CODECS="avc1.64001f",RESOLUTION=486x486
avc486.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=1,VIDEO-RANGE=SDR,CODECS="avc1.64001f",RESOLUTION=1080x1080
avc1080.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=1,VIDEO-RANGE=SDR,CODECS="avc1.64001f",RESOLUTION=768x768
avc768.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=1,VIDEO-RANGE=PQ,CODECS="hvc1.2.4.L123.B0",RESOLUTION=720x720
hdr.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=1,VIDEO-RANGE=SDR,CODECS="hvc1.2.4.L123.B0",RESOLUTION=456x456
hevc456.m3u8
"#;
        assert_eq!(
            pick_variants(master),
            (Some("avc768.m3u8".into()), Some("hevc456.m3u8".into()))
        );
    }

    #[test]
    #[ignore = "reaches Apple Music"]
    fn finds_live_motion_artwork() {
        let client = client().unwrap();
        let token = token(&client, true).unwrap();
        let Ok(found) = songs(&client, &token, "USUG12205734").unwrap() else {
            panic!("token rejected");
        };
        let master = pick_master(&found, "Midnights").unwrap();
        let cover = cover(&client, &master).unwrap().unwrap();
        assert!(cover.avc.unwrap().ends_with(".mp4"));
        assert!(cover.hevc.unwrap().ends_with(".mp4"));
    }

    #[test]
    fn trusts_only_apple_video_over_https() {
        let ok = url::Url::parse("https://mvod.itunes.apple.com/a/b.mp4").unwrap();
        assert!(trusted_video(&ok));
        for bad in [
            "http://mvod.itunes.apple.com/a.mp4",
            "https://mvod.itunes.apple.com.evil.test/a.mp4",
            "https://user@mvod.itunes.apple.com/a.mp4",
            "https://mvod.itunes.apple.com:8443/a.mp4",
        ] {
            assert!(!trusted_video(&url::Url::parse(bad).unwrap()), "{bad}");
        }
    }
}
