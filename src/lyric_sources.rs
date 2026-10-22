//! Lyric sources and the order they are tried in, as chosen in Lyrics
//! settings → Sources. Reimplements the source manager of the Spicy Lyrics
//! fork (iPixelGalaxy/spicy-lyrics, `src/utils/Lyrics/Sources`, AGPL-3.0):
//! the same six sources, default order and quality-first selection.
//!
//! What each source receives:
//! - Spicy Lyrics / Apple Music: the configured Spicy Lyrics provider (one
//!   request; Apple Music is its `apple_music`-tagged answer).
//! - Musixmatch: title, artists, album, length and Spotify track ID, sent to
//!   Musixmatch's desktop-app endpoint with the fork's public desktop token.
//!   This is not an official Musixmatch API and may stop working.
//! - Spotify: the track ID, through the signed-in native Spotify session.
//! - LRCLIB: title, artist, album and length (lrclib.net).
//! - Netease: title and artist, through the third-party proxy the fork uses.
//!
//! No source receives Spotify access or refresh tokens.

use std::sync::{Mutex, OnceLock};

use anyhow::{Context, Result, anyhow, ensure};
use reqwest::blocking::Client;
use serde_json::Value;

use crate::lyrics::{Line, Lyrics, Word};
use crate::model::Track;

/// Every known source, in default order.
pub const DEFAULT_ORDER: [&str; 6] = [
    "spicy",
    "apple",
    "musixmatch",
    "spotify",
    "lrclib",
    "netease",
];
/// Sources the fork leaves off until chosen.
pub const DEFAULT_DISABLED: [&str; 2] = ["lrclib", "netease"];

static ACTIVE: Mutex<Option<Vec<String>>> = Mutex::new(None);

/// Known source IDs in the saved order, with any missing ones appended.
pub fn normalize_order(order: &[String]) -> Vec<String> {
    let mut result: Vec<String> = Vec::new();
    for id in order
        .iter()
        .map(String::as_str)
        .chain(DEFAULT_ORDER.iter().copied())
    {
        if DEFAULT_ORDER.contains(&id) && !result.iter().any(|known| known == id) {
            result.push(id.to_owned());
        }
    }
    result
}

/// Sources added since the settings were saved start in their default
/// state: off when the fork leaves them off, otherwise on.
pub fn migrate(order: &[String], disabled: &mut Vec<String>) -> Vec<String> {
    for id in DEFAULT_DISABLED {
        if !order.iter().any(|known| known == id) && !disabled.iter().any(|off| off == id) {
            disabled.push(id.to_owned());
        }
    }
    disabled.retain(|id| DEFAULT_ORDER.contains(&id.as_str()));
    normalize_order(order)
}

/// Applies the saved order and the sources that are turned off.
pub fn configure(order: &[String], disabled: &[String]) {
    let enabled = normalize_order(order)
        .into_iter()
        .filter(|id| !disabled.contains(id))
        .collect();
    if let Ok(mut active) = ACTIVE.lock() {
        *active = Some(enabled);
    }
}

/// Sources to try, in order. Before settings load, the fork's defaults.
pub fn enabled() -> Vec<String> {
    ACTIVE
        .lock()
        .ok()
        .and_then(|active| active.clone())
        .unwrap_or_else(|| {
            DEFAULT_ORDER
                .iter()
                .filter(|id| !DEFAULT_DISABLED.contains(id))
                .map(|id| (*id).to_owned())
                .collect()
        })
}

/// How good a result is: word-synced 3, line-synced 2, plain 1.
pub fn quality(lyrics: &Lyrics) -> u8 {
    if lyrics.instrumental || lyrics.lines.iter().any(|line| !line.words.is_empty()) {
        3
    } else if lyrics.synced && !lyrics.lines.is_empty() {
        2
    } else if !lyrics.lines.is_empty() {
        1
    } else {
        0
    }
}

/// Queries every enabled source at once, then picks in the chosen order like
/// the fork: the first word-synced result wins; otherwise the best found.
/// Once a preferred source (Spicy, Musixmatch, Apple) has lyrics, LRCLIB and
/// Netease are not consulted.
pub fn fetch_best(
    sources: &[String],
    fetch: &(dyn Fn(&str) -> Result<Lyrics> + Sync),
) -> Result<Lyrics> {
    let results: Vec<Result<Lyrics>> = std::thread::scope(|scope| {
        let handles: Vec<_> = sources
            .iter()
            .map(|source| scope.spawn(move || fetch(source)))
            .collect();
        handles
            .into_iter()
            .map(|handle| {
                handle
                    .join()
                    .unwrap_or_else(|_| Err(anyhow!("Lyrics source failed")))
            })
            .collect()
    });
    let mut best: Option<Lyrics> = None;
    let mut failure = None;
    let mut preferred = false;
    for (source, result) in sources.iter().zip(results) {
        if preferred && matches!(source.as_str(), "lrclib" | "netease") {
            continue;
        }
        let lyrics = match result {
            Ok(lyrics) => lyrics,
            Err(error) => {
                failure = Some(error);
                continue;
            }
        };
        let score = quality(&lyrics);
        if score == 0 {
            continue;
        }
        if matches!(source.as_str(), "spicy" | "musixmatch" | "apple") {
            preferred = true;
        }
        if score == 3 {
            return Ok(lyrics);
        }
        if best.as_ref().is_none_or(|known| score > quality(known)) {
            best = Some(lyrics);
        }
    }
    best.ok_or_else(|| {
        failure.unwrap_or_else(|| anyhow!("No lyrics source found lyrics for this song"))
    })
}

/// Splits the Spicy Lyrics provider's answer: Apple Music lyrics belong to
/// the Apple Music source, everything else to Spicy Lyrics.
pub fn split_provider(lyrics: &Lyrics, source: &str) -> Option<Lyrics> {
    let apple = matches!(lyrics.source.as_str(), "apple_music" | "aml");
    (apple == (source == "apple")).then(|| lyrics.clone())
}

fn first_artist(track: &Track) -> &str {
    track
        .artists
        .first()
        .map(|artist| artist.name.as_str())
        .unwrap_or_default()
}

fn track_id(track: &Track) -> Option<&str> {
    track
        .id
        .as_deref()
        .or_else(|| track.uri.strip_prefix("spotify:track:"))
        .filter(|id| id.len() == 22 && id.bytes().all(|byte| byte.is_ascii_alphanumeric()))
}

/// Lines with no end time end where the next starts, or at the song's end.
fn close_lines(lines: &mut [Line], duration_ms: u64) {
    for index in 0..lines.len() {
        if lines[index].end_ms > lines[index].start_ms {
            continue;
        }
        let next = lines
            .get(index + 1)
            .map(|line| line.start_ms)
            .unwrap_or(duration_ms.max(lines[index].start_ms + 4_000));
        lines[index].end_ms = next.max(lines[index].start_ms + 1);
    }
}

fn plain_lines<'a>(lines: impl Iterator<Item = &'a str>) -> Vec<Line> {
    lines
        .map(str::trim)
        .filter(|text| !text.is_empty() && !is_note_only(text))
        .take(2_000)
        .map(|text| Line {
            text: text.chars().take(500).collect(),
            ..Line::default()
        })
        .collect()
}

fn is_note_only(text: &str) -> bool {
    text.chars()
        .all(|char| char.is_whitespace() || "♪♫♬♩".contains(char))
}

/// Song titles compared without features, brackets or punctuation.
fn title_key(text: &str) -> String {
    let lower = text.to_lowercase();
    let main = lower.split(" - ").next().unwrap_or_default();
    let mut result = String::new();
    let mut depth = 0u32;
    for char in main.chars() {
        match char {
            '(' | '[' | '{' => depth += 1,
            ')' | ']' | '}' => depth = depth.saturating_sub(1),
            _ if depth == 0 && char.is_alphanumeric() => result.push(char),
            _ => {}
        }
    }
    result
}

// ---------------------------------------------------------------- LRCLIB

/// Looks the song up on LRCLIB, preferring time-synced lyrics.
pub fn lrclib(client: &Client, track: &Track) -> Result<Lyrics> {
    let artist = first_artist(track);
    ensure!(
        !track.name.is_empty() && !artist.is_empty(),
        "LRCLIB needs a title and artist"
    );
    let mut query = vec![
        ("track_name", track.name.clone()),
        ("artist_name", artist.to_owned()),
    ];
    if !track.album.name.is_empty() {
        query.push(("album_name", track.album.name.clone()));
    }
    if track.duration_ms > 0 {
        query.push(("duration", (track.duration_ms / 1000).to_string()));
    }
    let response = client
        .get("https://lrclib.net/api/get")
        .query(&query)
        .send()
        .context("LRCLIB is unreachable")?;
    ensure!(
        response.status().is_success(),
        "LRCLIB has no lyrics for this song"
    );
    let value: Value = response.json().context("LRCLIB returned invalid data")?;
    from_lrclib(&value, track.duration_ms)
}

/// Converts an LRCLIB record: synced LRC first, then plain text.
pub fn from_lrclib(value: &Value, duration_ms: u64) -> Result<Lyrics> {
    if value["instrumental"].as_bool() == Some(true) {
        return Ok(Lyrics {
            instrumental: true,
            source: "LRCLIB".into(),
            ..Lyrics::default()
        });
    }
    if let Some(synced) = value["syncedLyrics"]
        .as_str()
        .filter(|text| !text.trim().is_empty())
        && let Ok(mut lyrics) = crate::lyrics::parse_lrc(synced, duration_ms)
    {
        lyrics.source = "LRCLIB".into();
        return Ok(lyrics);
    }
    let plain = value["plainLyrics"]
        .as_str()
        .filter(|text| !text.trim().is_empty())
        .context("LRCLIB has no lyrics for this song")?;
    Ok(Lyrics {
        lines: plain_lines(plain.lines()),
        source: "LRCLIB".into(),
        synced: false,
        ..Lyrics::default()
    })
}

// ------------------------------------------------------------- Spotify

/// Converts Spotify's color-lyrics answer (line-synced or plain).
pub fn from_spotify(value: &Value, duration_ms: u64) -> Result<Lyrics> {
    let lyrics = &value["lyrics"];
    let rows = lyrics["lines"]
        .as_array()
        .filter(|rows| !rows.is_empty())
        .context("Spotify has no lyrics for this song")?;
    let provider = lyrics["provider"].as_str().unwrap_or_default().trim();
    let source = if provider.eq_ignore_ascii_case("musixmatch") {
        "Spotify (through Musixmatch)".to_owned()
    } else if provider.is_empty() {
        "Spotify".to_owned()
    } else {
        format!("Spotify ({provider})")
    };
    let synced = lyrics["syncType"].as_str() == Some("LINE_SYNCED");
    let mut lines: Vec<Line> = Vec::new();
    for row in rows.iter().take(2_000) {
        let text = row["words"].as_str().unwrap_or_default().trim();
        if text.is_empty() || is_note_only(text) {
            continue;
        }
        let start_ms = row["startTimeMs"]
            .as_str()
            .and_then(|value| value.parse().ok())
            .or_else(|| row["startTimeMs"].as_u64())
            .unwrap_or(0);
        lines.push(Line {
            start_ms: if synced { start_ms } else { 0 },
            text: text.chars().take(500).collect(),
            ..Line::default()
        });
    }
    ensure!(!lines.is_empty(), "Spotify has no lyrics for this song");
    if synced {
        close_lines(&mut lines, duration_ms);
    }
    Ok(Lyrics {
        lines,
        source,
        synced,
        ..Lyrics::default()
    })
}

/// Fetches Spotify's own lyrics through the native session.
pub fn spotify(native: &crate::native::NativeControls, track: &Track) -> Result<Lyrics> {
    let id = track_id(track).context("Spotify lyrics need a Spotify track")?;
    let body = native.lyrics(id)?;
    let value: Value = serde_json::from_slice(&body).context("Spotify returned invalid lyrics")?;
    from_spotify(&value, track.duration_ms)
}

// ----------------------------------------------------------- Musixmatch

/// The Musixmatch desktop app's public token, as used by the fork.
const MUSIXMATCH_TOKEN: &str = "21051986b9886beabe1ce01c3ce94c96319411f8f2c122676365e3";
const MUSIXMATCH: &str = "https://apic-desktop.musixmatch.com/ws/1.1/";

static MUSIXMATCH_USER: OnceLock<Mutex<String>> = OnceLock::new();

fn musixmatch_token() -> String {
    MUSIXMATCH_USER
        .get_or_init(|| Mutex::new(MUSIXMATCH_TOKEN.into()))
        .lock()
        .map(|token| token.clone())
        .unwrap_or_else(|_| MUSIXMATCH_TOKEN.into())
}

/// Asks Musixmatch for a fresh desktop token after a 401. Placeholder
/// (all-zero) tokens are ignored.
fn refresh_musixmatch_token(client: &Client) -> Option<String> {
    let value: Value = client
        .get(format!("{MUSIXMATCH}token.get"))
        .query(&[("app_id", "web-desktop-app-v1.0")])
        .header("cookie", "x-mxm-token-guid=")
        .send()
        .ok()?
        .json()
        .ok()?;
    let token = value["message"]["body"]["user_token"]
        .as_str()
        .filter(|token| !token.trim().is_empty() && token.chars().any(|char| char != '0'))?
        .to_owned();
    if let Ok(mut current) = MUSIXMATCH_USER
        .get_or_init(|| Mutex::new(MUSIXMATCH_TOKEN.into()))
        .lock()
    {
        *current = token.clone();
    }
    Some(token)
}

fn musixmatch_get(client: &Client, method: &str, query: &[(&str, String)]) -> Result<Value> {
    let request = |token: String| -> Result<Value> {
        let mut query = query.to_vec();
        query.push(("app_id", "web-desktop-app-v1.0".into()));
        query.push(("format", "json".into()));
        query.push(("usertoken", token));
        client
            .get(format!("{MUSIXMATCH}{method}"))
            .query(&query)
            .header("cookie", "x-mxm-token-guid=")
            .send()
            .context("Musixmatch is unreachable")?
            .json()
            .context("Musixmatch returned invalid data")
    };
    let value = request(musixmatch_token())?;
    if value["message"]["header"]["status_code"].as_u64() == Some(401)
        && let Some(token) = refresh_musixmatch_token(client)
    {
        return request(token);
    }
    Ok(value)
}

/// Looks the song up on Musixmatch: word-synced first, then line-synced,
/// then plain lyrics.
pub fn musixmatch(client: &Client, track: &Track) -> Result<Lyrics> {
    let artist = track
        .artists
        .iter()
        .map(|artist| artist.name.as_str())
        .collect::<Vec<_>>()
        .join(", ");
    ensure!(
        !track.name.is_empty() && !artist.is_empty(),
        "Musixmatch needs a title and artist"
    );
    let seconds = track.duration_ms / 1000;
    let macros = musixmatch_get(
        client,
        "macro.subtitles.get",
        &[
            ("namespace", "lyrics_richsynched".into()),
            ("subtitle_format", "mxm".into()),
            ("q_album", track.album.name.clone()),
            ("q_artist", first_artist(track).into()),
            ("q_artists", artist),
            ("q_track", track.name.clone()),
            ("track_spotify_id", track.uri.clone()),
            (
                "q_duration",
                format!("{:.3}", track.duration_ms as f64 / 1000.0),
            ),
            ("f_subtitle_length", seconds.to_string()),
            (
                "part",
                "track_lyrics_translation_status,track_structure,track_performer_tagging".into(),
            ),
        ],
    )?;
    let calls = &macros["message"]["body"]["macro_calls"];
    let matcher = &calls["matcher.track.get"]["message"];
    ensure!(
        matcher["header"]["status_code"].as_u64() == Some(200),
        "Musixmatch has no match for this song"
    );
    ensure!(
        calls["track.lyrics.get"]["message"]["body"]["lyrics"]["restricted"].as_u64() != Some(1)
            && calls["track.lyrics.get"]["message"]["body"]["lyrics"]["restricted"].as_bool()
                != Some(true),
        "Musixmatch lyrics are restricted for this song"
    );
    let meta = &matcher["body"]["track"];
    let (expected, found) = (
        title_key(&track.name),
        title_key(meta["track_name"].as_str().unwrap_or_default()),
    );
    // The matcher can return a different song; only accept a title match.
    ensure!(
        !expected.is_empty()
            && !found.is_empty()
            && (expected.contains(&found) || found.contains(&expected)),
        "Musixmatch matched a different song"
    );
    let flag = |key: &str| meta[key].as_u64() == Some(1) || meta[key].as_bool() == Some(true);
    if flag("instrumental") {
        return Ok(Lyrics {
            instrumental: true,
            source: "Musixmatch".into(),
            ..Lyrics::default()
        });
    }
    if flag("has_richsync")
        && let Some(common) = meta["commontrack_id"].as_u64()
        && let Ok(rich) = musixmatch_get(
            client,
            "track.richsync.get",
            &[
                ("subtitle_format", "mxm".into()),
                ("commontrack_id", common.to_string()),
                ("q_duration", meta["track_length"].to_string()),
                ("f_subtitle_length", meta["track_length"].to_string()),
            ],
        )
        && let Some(body) = rich["message"]["body"]["richsync"]["richsync_body"].as_str()
        && let Ok(value) = serde_json::from_str::<Value>(body)
        && let Some(lyrics) = from_musixmatch_richsync(&value)
    {
        return Ok(lyrics);
    }
    if flag("has_subtitles")
        && let Some(body) = calls["track.subtitles.get"]["message"]["body"]["subtitle_list"][0]
            ["subtitle"]["subtitle_body"]
            .as_str()
        && let Ok(value) = serde_json::from_str::<Value>(body)
        && let Some(lyrics) = from_musixmatch_subtitles(&value, track.duration_ms)
    {
        return Ok(lyrics);
    }
    let plain = calls["track.lyrics.get"]["message"]["body"]["lyrics"]["lyrics_body"]
        .as_str()
        .unwrap_or_default();
    let lines: Vec<Line> = plain_lines(
        plain
            .lines()
            .filter(|line| !line.contains("This Lyrics is NOT for Commercial use"))
            .filter(|line| !line.trim_start().starts_with("***")),
    );
    ensure!(!lines.is_empty(), "Musixmatch has no lyrics for this song");
    Ok(Lyrics {
        lines,
        source: "Musixmatch".into(),
        synced: false,
        ..Lyrics::default()
    })
}

fn joins_next(current: &str, next: &str) -> bool {
    let (current, next) = (current.trim(), next.trim());
    !current.is_empty()
        && !next.is_empty()
        && (next.starts_with(|char: char| "'’-–—/.,!?;:%)]}".contains(char))
            || current.ends_with(|char: char| "([{'\"“‘-–—/".contains(char)))
}

/// Musixmatch richsync: lines of `{ts, te, l: [{c, o}]}`, word offsets in
/// seconds from the line start.
pub fn from_musixmatch_richsync(value: &Value) -> Option<Lyrics> {
    let mut lines = Vec::new();
    for row in value.as_array()?.iter().take(2_000) {
        let start = (row["ts"].as_f64().unwrap_or(0.0) * 1000.0).round() as u64;
        let end = (row["te"].as_f64().unwrap_or(0.0) * 1000.0).round() as u64;
        let tokens: Vec<(&str, f64)> = row["l"]
            .as_array()
            .map(|tokens| {
                tokens
                    .iter()
                    .map(|token| {
                        (
                            token["c"].as_str().unwrap_or_default(),
                            token["o"].as_f64().unwrap_or(0.0),
                        )
                    })
                    .collect()
            })
            .unwrap_or_default();
        let mut words: Vec<Word> = Vec::new();
        let mut join = false;
        for (index, (text, offset)) in tokens.iter().enumerate() {
            let clean = text.trim();
            if clean.is_empty() || is_note_only(clean) {
                continue;
            }
            let word_start = start + (offset * 1000.0).round() as u64;
            let word_end = tokens
                .get(index + 1)
                .map(|(_, next)| start + (next * 1000.0).round() as u64)
                .unwrap_or(end)
                .max(word_start);
            let next_text = tokens.get(index + 1).map(|(text, _)| *text).unwrap_or("");
            words.push(Word {
                start_ms: word_start,
                end_ms: word_end,
                text: format!("{}{clean}", if words.is_empty() || join { "" } else { " " }),
            });
            join = joins_next(text, next_text);
        }
        if words.is_empty() {
            continue;
        }
        lines.push(Line {
            start_ms: words[0].start_ms,
            end_ms: end.max(words.last()?.end_ms),
            text: words.iter().map(|word| word.text.as_str()).collect(),
            words,
            ..Line::default()
        });
    }
    (!lines.is_empty()).then(|| Lyrics {
        lines,
        source: "Musixmatch".into(),
        synced: true,
        ..Lyrics::default()
    })
}

/// Musixmatch line-synced subtitles: `[{text, time: {total}}]`.
pub fn from_musixmatch_subtitles(value: &Value, duration_ms: u64) -> Option<Lyrics> {
    let mut lines: Vec<Line> = Vec::new();
    for row in value.as_array()?.iter().take(2_000) {
        let text = row["text"].as_str().unwrap_or_default().trim();
        let start = (row["time"]["total"].as_f64().unwrap_or(0.0) * 1000.0).round() as u64;
        if text.is_empty() || is_note_only(text) {
            // Instrumental markers end the line before them.
            if let Some(last) = lines.last_mut()
                && last.end_ms == 0
            {
                last.end_ms = start;
            }
            continue;
        }
        lines.push(Line {
            start_ms: start,
            text: text.chars().take(500).collect(),
            ..Line::default()
        });
    }
    if lines.is_empty() {
        return None;
    }
    close_lines(&mut lines, duration_ms);
    Some(Lyrics {
        lines,
        source: "Musixmatch".into(),
        synced: true,
        ..Lyrics::default()
    })
}

// ------------------------------------------------------------- Netease

/// Lines Netease adds for credits (lyricist, composer, mixing and so on).
fn netease_credit(text: &str) -> bool {
    let Some((label, _)) = text.split_once([':', '：']) else {
        return false;
    };
    let label = label.trim().to_lowercase();
    [
        "作词", "作曲", "编曲", "监制", "制作", "混音", "缩混", "录音", "和声", "吉他", "贝斯",
        "鼓", "弦乐", "钢琴", "出品", "发行", "原唱", "lrc", "publish", "vocal", "guitar",
        "program", "produce", "write", "mix",
    ]
    .iter()
    .any(|keyword| label.contains(keyword))
}

/// Looks the song up through the Netease proxy the fork uses.
pub fn netease(client: &Client, track: &Track) -> Result<Lyrics> {
    const BASE: &str = "https://music.xianqiao.wang/neteaseapiv2/";
    const AGENT: &str =
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:93.0) Gecko/20100101 Firefox/93.0";
    let query = format!("{} {}", track.name, first_artist(track));
    let search: Value = client
        .get(format!("{BASE}search"))
        .query(&[("limit", "10"), ("type", "1"), ("keywords", query.trim())])
        .header("user-agent", AGENT)
        .send()
        .context("Netease is unreachable")?
        .json()
        .context("Netease returned invalid data")?;
    let songs = search["result"]["songs"]
        .as_array()
        .filter(|songs| !songs.is_empty())
        .context("Netease has no match for this song")?;
    let album = title_key(&track.album.name);
    let title = title_key(&track.name);
    let song = songs
        .iter()
        .find(|song| {
            !album.is_empty() && title_key(song["album"]["name"].as_str().unwrap_or("")) == album
        })
        .or_else(|| {
            songs.iter().find(|song| {
                song["duration"]
                    .as_u64()
                    .is_some_and(|duration| duration.abs_diff(track.duration_ms) < 3_000)
            })
        })
        .or_else(|| {
            songs
                .iter()
                .find(|song| title_key(song["name"].as_str().unwrap_or("")) == title)
        })
        .unwrap_or(&songs[0]);
    let id = song["id"]
        .as_u64()
        .context("Netease has no match for this song")?;
    let body: Value = client
        .get(format!("{BASE}lyric"))
        .query(&[("id", id.to_string())])
        .header("user-agent", AGENT)
        .send()
        .context("Netease is unreachable")?
        .json()
        .context("Netease returned invalid data")?;
    from_netease(&body, track.duration_ms)
}

/// Converts a Netease lyric answer, dropping credit lines.
pub fn from_netease(value: &Value, duration_ms: u64) -> Result<Lyrics> {
    let text = value["lrc"]["lyric"]
        .as_str()
        .filter(|text| !text.trim().is_empty())
        .context("Netease has no lyrics for this song")?;
    let mut lyrics =
        crate::lyrics::parse_lrc(text, duration_ms).or_else(|_| -> Result<Lyrics> {
            Ok(Lyrics {
                lines: plain_lines(text.lines()),
                ..Lyrics::default()
            })
        })?;
    lyrics
        .lines
        .retain(|line| !netease_credit(&line.text) && line.text.trim() != "纯音乐, 请欣赏");
    ensure!(
        !lyrics.lines.is_empty(),
        "Netease has no lyrics for this song"
    );
    lyrics.source = "Netease".into();
    Ok(lyrics)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn timed(words: bool, synced: bool) -> Lyrics {
        Lyrics {
            lines: vec![Line {
                text: "Hi".into(),
                words: if words {
                    vec![Word {
                        start_ms: 0,
                        end_ms: 100,
                        text: "Hi".into(),
                    }]
                } else {
                    Vec::new()
                },
                ..Line::default()
            }],
            synced,
            ..Lyrics::default()
        }
    }

    #[test]
    fn order_keeps_known_sources_once_and_appends_missing() {
        assert_eq!(
            normalize_order(&["lrclib".into(), "bogus".into(), "lrclib".into()]),
            vec![
                "lrclib",
                "spicy",
                "apple",
                "musixmatch",
                "spotify",
                "netease"
            ]
        );
        configure(&["lrclib".into(), "spicy".into()], &["spicy".into()]);
        assert_eq!(enabled()[0], "lrclib");
        assert!(!enabled().contains(&"spicy".to_owned()));
    }

    #[test]
    fn new_sources_start_in_the_forks_default_state() {
        let mut disabled = vec!["lrclib".to_owned()];
        let order = migrate(&["spicy".into(), "lrclib".into()], &mut disabled);
        assert_eq!(order.len(), 6);
        assert!(disabled.contains(&"netease".to_owned()));
        assert!(!disabled.contains(&"musixmatch".to_owned()));
        // A source the user turned on is not turned back off.
        let mut chosen = Vec::new();
        migrate(&DEFAULT_ORDER.map(String::from), &mut chosen);
        assert!(chosen.is_empty());
    }

    #[test]
    fn best_source_wins_by_quality_then_order() {
        let order: Vec<String> = ["spicy", "musixmatch", "lrclib"].map(String::from).to_vec();
        let pick = |spicy: Lyrics, musixmatch: Lyrics| {
            fetch_best(&order, &|source| match source {
                "spicy" => Ok(spicy.clone()),
                "musixmatch" => Ok(musixmatch.clone()),
                _ => Ok(timed(true, true)),
            })
            .unwrap()
        };
        // Line-synced Spicy loses to word-synced Musixmatch.
        assert!(
            !pick(timed(false, true), timed(true, true)).lines[0]
                .words
                .is_empty()
        );
        // A preferred source's answer stops LRCLIB being used.
        assert!(
            pick(timed(false, true), Lyrics::default()).lines[0]
                .words
                .is_empty()
        );
        let failing = fetch_best(&order, &|_| Err(anyhow!("down")));
        assert!(failing.is_err());
    }

    #[test]
    fn provider_answers_split_between_spicy_and_apple() {
        let apple = Lyrics {
            source: "apple_music".into(),
            ..Lyrics::default()
        };
        assert!(split_provider(&apple, "apple").is_some());
        assert!(split_provider(&apple, "spicy").is_none());
        let community = Lyrics {
            source: "spicy_lyrics".into(),
            ..Lyrics::default()
        };
        assert!(split_provider(&community, "spicy").is_some());
    }

    #[test]
    fn lrclib_prefers_synced_lyrics_and_falls_back_to_plain() {
        let synced = from_lrclib(
            &json!({"syncedLyrics":"[00:01.00]Hello\n[00:03.50]World","plainLyrics":"Hello\nWorld"}),
            10_000,
        )
        .unwrap();
        assert!(synced.synced);
        assert_eq!(synced.lines[1].start_ms, 3_500);
        let plain = from_lrclib(&json!({"plainLyrics":"Hello\nWorld"}), 0).unwrap();
        assert!(!plain.synced);
        assert!(
            from_lrclib(&json!({"instrumental":true}), 0)
                .unwrap()
                .instrumental
        );
        assert!(from_lrclib(&json!({}), 0).is_err());
    }

    #[test]
    fn spotify_lines_end_where_the_next_begins() {
        let lyrics = from_spotify(
            &json!({"lyrics":{"syncType":"LINE_SYNCED","provider":"MusixMatch","lines":[
                {"startTimeMs":"1000","words":"Hello"},
                {"startTimeMs":"2000","words":"♪"},
                {"startTimeMs":"3000","words":"World"}]}}),
            10_000,
        )
        .unwrap();
        assert_eq!(lyrics.source, "Spotify (through Musixmatch)");
        assert_eq!(lyrics.lines.len(), 2);
        assert_eq!(lyrics.lines[0].end_ms, 3_000);
        assert_eq!(lyrics.lines[1].end_ms, 10_000);
    }

    #[test]
    fn musixmatch_richsync_becomes_word_timing() {
        let lyrics = from_musixmatch_richsync(&json!([
            {"ts":1.0,"te":3.0,"l":[{"c":"Don't","o":0.0},{"c":" ","o":0.4},{"c":"stop","o":0.5},{"c":"!","o":1.5}]}
        ]))
        .unwrap();
        let words: Vec<_> = lyrics.lines[0]
            .words
            .iter()
            .map(|word| word.text.as_str())
            .collect();
        assert_eq!(words, vec!["Don't", " stop", "!"]);
        assert_eq!(lyrics.lines[0].words[1].start_ms, 1_500);
        assert_eq!(lyrics.lines[0].text, "Don't stop!");
        let subtitles = from_musixmatch_subtitles(
            &json!([{"text":"Hi","time":{"total":1.0}},{"text":"","time":{"total":2.5}},{"text":"Bye","time":{"total":4.0}}]),
            9_000,
        )
        .unwrap();
        assert_eq!(subtitles.lines[0].end_ms, 2_500);
    }

    #[test]
    fn netease_drops_credit_lines() {
        let lyrics = from_netease(
            &json!({"lrc":{"lyric":"[00:00.00]作词 : Someone\n[00:01.00]Hello\n[00:02.00]World"}}),
            5_000,
        )
        .unwrap();
        assert_eq!(
            lyrics
                .lines
                .iter()
                .map(|line| line.text.as_str())
                .collect::<Vec<_>>(),
            vec!["Hello", "World"]
        );
    }

    #[test]
    fn titles_match_without_features_or_brackets() {
        assert_eq!(
            title_key("Lose Yourself (feat. X) - Remastered"),
            "loseyourself"
        );
        assert_ne!(title_key("NOKIA"), title_key("Lose Yourself"));
    }

    /// Live check against the real services: `cargo test live_sources -- --ignored`.
    #[test]
    #[ignore]
    fn live_sources() {
        let client = crate::auth::http_client().unwrap();
        let track = Track {
            uri: "spotify:track:0VjIjW4GlUZAMYd2vXMi3b".into(),
            id: Some("0VjIjW4GlUZAMYd2vXMi3b".into()),
            name: "Blinding Lights".into(),
            artists: vec![crate::model::Artist {
                name: "The Weeknd".into(),
                ..Default::default()
            }],
            album: crate::model::Album {
                name: "After Hours".into(),
                ..Default::default()
            },
            duration_ms: 200_040,
            ..Default::default()
        };
        for (name, result) in [
            ("musixmatch", musixmatch(&client, &track)),
            ("lrclib", lrclib(&client, &track)),
            ("netease", netease(&client, &track)),
        ] {
            match result {
                Ok(lyrics) => println!(
                    "{name}: quality {} lines {}",
                    quality(&lyrics),
                    lyrics.lines.len()
                ),
                Err(error) => println!("{name}: {error}"),
            }
        }
    }
}
