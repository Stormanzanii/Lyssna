//! Lyric sources and the order they are tried in, as chosen in Lyrics
//! settings → Sources (after Spicy Lyrics' source manager).
//!
//! Spicy Lyrics is the configured provider. LRCLIB (https://lrclib.net) is a
//! free, open lyrics database; it receives only the song title, artist,
//! album and duration over HTTPS, never Spotify tokens.

use std::sync::Mutex;

use anyhow::{Context, Result, ensure};
use reqwest::blocking::Client;
use serde_json::Value;

use crate::lyrics::{Line, Lyrics};
use crate::model::Track;

/// Every known source, in the default order.
pub const DEFAULT_ORDER: [&str; 2] = ["spicy", "lrclib"];

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

/// Sources to try, in order. Before settings load, Spicy Lyrics only.
pub fn enabled() -> Vec<String> {
    ACTIVE
        .lock()
        .ok()
        .and_then(|active| active.clone())
        .unwrap_or_else(|| vec!["spicy".into()])
}

/// Looks the song up on LRCLIB, preferring time-synced lyrics.
pub fn lrclib(client: &Client, track: &Track) -> Result<Lyrics> {
    let artist = track
        .artists
        .first()
        .map(|artist| artist.name.as_str())
        .unwrap_or_default();
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
        lines: plain
            .lines()
            .take(2_000)
            .map(|text| Line {
                text: text.trim().chars().take(500).collect(),
                ..Line::default()
            })
            .collect(),
        source: "LRCLIB".into(),
        synced: false,
        ..Lyrics::default()
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn order_keeps_known_sources_once_and_appends_missing() {
        assert_eq!(
            normalize_order(&["lrclib".into(), "bogus".into(), "lrclib".into()]),
            vec!["lrclib", "spicy"]
        );
        configure(&["lrclib".into(), "spicy".into()], &["spicy".into()]);
        assert_eq!(enabled(), vec!["lrclib"]);
        configure(&[], &[]);
        assert_eq!(enabled(), vec!["spicy", "lrclib"]);
    }

    #[test]
    fn lrclib_prefers_synced_lyrics_and_falls_back_to_plain() {
        let synced = from_lrclib(
            &json!({"syncedLyrics":"[00:01.00]Hello\n[00:03.50]World","plainLyrics":"Hello\nWorld"}),
            10_000,
        )
        .unwrap();
        assert!(synced.synced);
        assert_eq!(synced.source, "LRCLIB");
        assert_eq!(synced.lines[1].start_ms, 3_500);
        let plain = from_lrclib(&json!({"plainLyrics":"Hello\nWorld"}), 0).unwrap();
        assert!(!plain.synced);
        assert_eq!(plain.lines.len(), 2);
        assert!(
            from_lrclib(&json!({"instrumental":true}), 0)
                .unwrap()
                .instrumental
        );
        assert!(from_lrclib(&json!({}), 0).is_err());
    }
}
