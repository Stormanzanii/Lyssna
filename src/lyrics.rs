use std::{fs, path::Path};

use anyhow::{Context, Result, bail, ensure};
use reqwest::blocking::Client;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::{config::data_dir, model::Track};

#[derive(Clone, Default, Serialize, Deserialize)]
pub struct Lyrics {
    pub lines: Vec<Line>,
    pub source: String,
    pub instrumental: bool,
    pub synced: bool,
}

#[derive(Clone, Default, Serialize, Deserialize)]
pub struct Line {
    pub start_ms: u64,
    pub end_ms: u64,
    pub text: String,
    pub translation: String,
    pub romanization: String,
    pub words: Vec<Word>,
    pub background: bool,
    pub opposite: bool,
}

#[derive(Clone, Default, Serialize, Deserialize)]
pub struct Word {
    pub start_ms: u64,
    pub end_ms: u64,
    pub text: String,
}

impl Lyrics {
    pub fn active_line(&self, position_ms: u64) -> Option<usize> {
        if !self.synced {
            return None;
        }
        let index = self
            .lines
            .partition_point(|line| line.start_ms <= position_ms);
        index
            .checked_sub(1)
            .filter(|index| position_ms < self.lines[*index].end_ms)
    }
}

fn timestamp(value: &str) -> Option<u64> {
    let value = value.trim();
    let seconds = if let Some(value) = value.strip_suffix("ms") {
        value.parse::<f64>().ok()? / 1000.0
    } else if let Some(value) = value.strip_suffix('s') {
        value.parse::<f64>().ok()?
    } else {
        let parts: Vec<_> = value.split(':').collect();
        match parts.as_slice() {
            [minutes, seconds] => {
                minutes.parse::<f64>().ok()? * 60.0 + seconds.parse::<f64>().ok()?
            }
            [hours, minutes, seconds] => {
                hours.parse::<f64>().ok()? * 3600.0
                    + minutes.parse::<f64>().ok()? * 60.0
                    + seconds.parse::<f64>().ok()?
            }
            _ => return None,
        }
    };
    (seconds.is_finite() && (0.0..=604_800.0).contains(&seconds))
        .then_some((seconds * 1000.0).round() as u64)
}

pub fn parse_lrc(source: &str, duration_ms: u64) -> Result<Lyrics> {
    let mut lines = Vec::new();
    let offset = source
        .lines()
        .find_map(|line| {
            line.trim()
                .strip_prefix("[offset:")?
                .strip_suffix(']')?
                .parse::<i64>()
                .ok()
        })
        .unwrap_or(0);
    for raw in source.lines() {
        let mut remainder = raw.trim();
        let mut times = Vec::new();
        while let Some(start) = remainder.strip_prefix('[') {
            let Some(end) = start.find(']') else {
                break;
            };
            if let Some(time) = timestamp(&start[..end]) {
                times.push(time.saturating_add_signed(offset));
            }
            remainder = &start[end + 1..];
        }
        if remainder.trim().is_empty() {
            continue;
        }
        for start_ms in times {
            lines.push(Line {
                start_ms,
                text: remainder.trim().to_owned(),
                ..Line::default()
            });
        }
    }
    ensure!(
        !lines.is_empty(),
        "No timestamped lyrics found in this LRC file"
    );
    lines.sort_by_key(|line| line.start_ms);
    for index in 0..lines.len() {
        lines[index].end_ms = lines[index + 1..]
            .iter()
            .find(|line| line.start_ms > lines[index].start_ms)
            .map_or(
                if duration_ms > lines[index].start_ms {
                    duration_ms
                } else {
                    lines[index].start_ms + 5000
                },
                |line| line.start_ms,
            );
    }
    Ok(Lyrics {
        lines,
        source: "Local LRC".into(),
        synced: true,
        ..Lyrics::default()
    })
}

fn attribute<'a>(node: roxmltree::Node<'a, 'a>, name: &str) -> Option<&'a str> {
    node.attributes()
        .find(|attribute| attribute.name() == name)
        .map(|attribute| attribute.value())
}

fn annotation(node: roxmltree::Node<'_, '_>) -> bool {
    attribute(node, "role").is_some_and(|role| {
        role.contains("translation") || role.contains("roman") || role.contains("transliteration")
    })
}

fn node_text(node: roxmltree::Node<'_, '_>, skip_annotations: bool) -> String {
    node.descendants()
        .filter(|child| child.is_text())
        .filter(|child| {
            !skip_annotations
                || !child
                    .ancestors()
                    .take_while(|parent| *parent != node)
                    .any(annotation)
        })
        .filter_map(|child| child.text())
        .collect::<String>()
}

/// Common lyric TTML uses absolute clock times. Offset values like `500ms`
/// within a paragraph are relative to that paragraph's begin time.
fn child_time(node: roxmltree::Node<'_, '_>, name: &str, parent_start: u64) -> Option<u64> {
    let value = attribute(node, name)?;
    timestamp(value).map(|time| {
        if value.contains(':') {
            time
        } else {
            parent_start.saturating_add(time)
        }
    })
}

pub fn parse_ttml(source: &str, duration_ms: u64) -> Result<Lyrics> {
    let document = roxmltree::Document::parse(source).context("Invalid TTML XML")?;
    let mut lines = Vec::new();
    for paragraph in document.descendants().filter(|node| node.has_tag_name("p")) {
        let Some(start_ms) = attribute(paragraph, "begin").and_then(timestamp) else {
            continue;
        };
        let end_ms = attribute(paragraph, "end")
            .and_then(timestamp)
            .or_else(|| {
                attribute(paragraph, "dur")
                    .and_then(timestamp)
                    .map(|time| start_ms + time)
            })
            .unwrap_or(if duration_ms > start_ms {
                duration_ms
            } else {
                start_ms + 5000
            });
        ensure!(end_ms >= start_ms, "TTML paragraph ends before it begins");
        let text = node_text(paragraph, true).trim().to_owned();
        let mut line = Line {
            start_ms,
            end_ms,
            text,
            background: attribute(paragraph, "role") == Some("x-bg"),
            opposite: attribute(paragraph, "agent").is_some_and(|agent| agent.ends_with('2')),
            ..Line::default()
        };
        for span in paragraph
            .descendants()
            .filter(|node| node.has_tag_name("span"))
        {
            let role = attribute(span, "role").unwrap_or_default();
            if role.contains("translation") {
                line.translation = node_text(span, false).trim().into();
                continue;
            }
            if role.contains("roman") || role.contains("transliteration") {
                line.romanization = node_text(span, false).trim().into();
                continue;
            }
            if span
                .ancestors()
                .take_while(|parent| *parent != paragraph)
                .any(annotation)
            {
                continue;
            }
            if span
                .children()
                .any(|child| child.is_element() && attribute(child, "begin").is_some())
            {
                continue;
            }
            if let Some(word_start) = child_time(span, "begin", start_ms) {
                let word_end = child_time(span, "end", start_ms).unwrap_or(end_ms);
                let text = node_text(span, true);
                if !text.trim().is_empty() && word_end >= word_start {
                    line.words.push(Word {
                        start_ms: word_start,
                        end_ms: word_end,
                        text,
                    });
                }
            }
        }
        if !line.text.is_empty() || !line.romanization.is_empty() {
            lines.push(line);
        }
    }
    ensure!(
        !lines.is_empty(),
        "No timed lyric paragraphs found in this TTML file"
    );
    lines.sort_by_key(|line| line.start_ms);
    Ok(Lyrics {
        lines,
        source: "Local TTML".into(),
        synced: true,
        ..Lyrics::default()
    })
}

fn track_key(track: &Track) -> String {
    format!("{:x}", Sha256::digest(track.uri.as_bytes()))
}

pub fn import_file(path: &Path, track: &Track) -> Result<Lyrics> {
    ensure!(
        fs::metadata(path)?.len() <= 2_000_000,
        "Lyric file exceeds 2 MB"
    );
    let text = fs::read_to_string(path).context("Cannot read lyrics as UTF-8")?;
    let extension = path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    let lyrics = match extension.as_str() {
        "lrc" => parse_lrc(&text, track.duration_ms)?,
        "ttml" | "xml" => parse_ttml(&text, track.duration_ms)?,
        _ => bail!("Choose an .lrc, .ttml, or .xml lyric file"),
    };
    let directory = data_dir()?.join("lyrics").join("local");
    fs::create_dir_all(&directory)?;
    fs::write(
        directory.join(format!("{}.json", track_key(track))),
        serde_json::to_vec(&lyrics)?,
    )?;
    Ok(lyrics)
}

pub fn fetch(client: &Client, track: &Track, access_token: &str) -> Result<Lyrics> {
    let root = data_dir()?.join("lyrics");
    let key = track_key(track);
    let local = root.join("local").join(format!("{key}.json"));
    if let Ok(bytes) = fs::read(local)
        && let Ok(lyrics) = serde_json::from_slice::<Lyrics>(&bytes)
    {
        return Ok(lyrics);
    }
    let cache = root.join("cache").join(crate::provider::cache_namespace()?);
    let file = cache.join(format!("{key}.json"));
    let fresh = fs::metadata(&file)
        .and_then(|metadata| metadata.modified())
        .ok()
        .and_then(|modified| modified.elapsed().ok())
        .is_some_and(|age| age < std::time::Duration::from_secs(3 * 86_400));
    if fresh
        && let Ok(bytes) = fs::read(&file)
        && let Ok(lyrics) = serde_json::from_slice::<Lyrics>(&bytes)
    {
        return Ok(lyrics);
    }
    let lyrics = crate::provider::fetch(client, track, access_token)?;
    if fs::create_dir_all(&cache).is_ok() {
        let _ = fs::write(file, serde_json::to_vec(&lyrics)?);
    }
    Ok(lyrics)
}
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lrc_handles_offsets_repeated_timestamps_and_seek_backwards() {
        let lyrics = parse_lrc(
            "[offset:-200]\n[00:01.00][00:05.500]Hello\n[00:03.25]World",
            10_000,
        )
        .unwrap();
        assert_eq!(
            lyrics
                .lines
                .iter()
                .map(|line| line.start_ms)
                .collect::<Vec<_>>(),
            vec![800, 3050, 5300]
        );
        assert_eq!(lyrics.active_line(0), None);
        assert_eq!(lyrics.active_line(4000), Some(1));
        assert_eq!(lyrics.active_line(1000), Some(0));
        assert_eq!(lyrics.active_line(10_001), None);
    }

    #[test]
    fn ttml_keeps_word_timing_translation_and_romanization_separate() {
        let text = r#"<tt xmlns="http://www.w3.org/ns/ttml" xmlns:ttm="http://www.w3.org/ns/ttml#metadata"><body><div><p begin="00:01.000" end="00:04.000" ttm:agent="v2"><span begin="00:01.000" end="00:02.000">Hello </span><span begin="00:02.000" end="00:03.000">world</span><span ttm:role="x-translation">Bonjour</span><span ttm:role="x-roman">Roman</span></p></div></body></tt>"#;
        let lyrics = parse_ttml(text, 5000).unwrap();
        let line = &lyrics.lines[0];
        assert_eq!(line.text, "Hello world");
        assert_eq!(line.translation, "Bonjour");
        assert_eq!(line.romanization, "Roman");
        assert!(line.opposite);
        assert_eq!(line.words[1].start_ms, 2000);
    }

    #[test]
    fn invalid_timing_and_empty_files_fail() {
        assert!(parse_lrc("[ar:Artist]\nUntimed", 5000).is_err());
        assert!(parse_ttml("<tt><p begin='5s' end='1s'>Bad</p></tt>", 5000).is_err());
        assert_eq!(timestamp("NaNs"), None);
        assert_eq!(timestamp("-1s"), None);
        assert_eq!(timestamp("00:01:30.125"), Some(90_125));
    }
}
