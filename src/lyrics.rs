use std::{collections::HashMap, fs, path::Path};

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
    #[serde(default)]
    pub attribution: Option<Attribution>,
    #[serde(default)]
    pub songwriters: Vec<String>,
}

#[derive(Clone, Default, Serialize, Deserialize)]
pub struct Attribution {
    #[serde(alias = "Uploader")]
    pub uploader: Option<Contributor>,
    #[serde(alias = "Maker")]
    pub maker: Option<Contributor>,
}
#[derive(Clone, Default, Serialize, Deserialize)]
pub struct Contributor {
    #[serde(default)]
    pub id: String,
    pub username: String,
    /// Discord username from the person's public profile, when the lyrics
    /// metadata named them by display name instead.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub discord: Option<String>,
    pub url: Option<String>,
    pub avatar: Option<String>,
    #[serde(default, rename = "hasProfileBanner")]
    pub has_profile_banner: bool,
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
        (0..index)
            .rev()
            .find(|index| !self.lines[*index].background && position_ms < self.lines[*index].end_ms)
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

/// Narrow a line's timing to its timed words, so background vocals light up
/// with their own syllables rather than with the whole lead line.
pub fn fit_to_words(line: &mut Line) {
    if let (Some(first), Some(last)) = (line.words.first(), line.words.last()) {
        line.start_ms = first.start_ms;
        line.end_ms = last.end_ms.max(first.start_ms);
    }
}

/// Background vocals already render smaller beneath the lead, so drop the
/// parentheses sources wrap them in, e.g. `(oh yeah)` becomes `oh yeah`.
pub fn strip_background_parentheses(line: &mut Line) {
    fn unwrap(text: &str) -> String {
        let text = text.trim();
        let text = text.strip_prefix('(').unwrap_or(text);
        text.strip_suffix(')').unwrap_or(text).trim().to_owned()
    }
    line.text = unwrap(&line.text);
    line.romanization = unwrap(&line.romanization);
    if let Some(first) = line.words.first_mut() {
        let leading = first.text.len() - first.text.trim_start().len();
        if first.text[leading..].starts_with('(') {
            first.text.remove(leading);
        }
    }
    if let Some(last) = line.words.last_mut()
        && last.text.trim_end().ends_with(')')
    {
        let end = last.text.trim_end().len();
        last.text.remove(end - 1);
    }
    line.words.retain(|word| !word.text.trim().is_empty());
}

/// Sort lines chronologically by their source group while keeping each
/// background vocal directly after the lead line it belongs to.
pub fn order_with_background(mut lines: Vec<(u64, Line)>) -> Vec<Line> {
    lines.sort_by_key(|(group_start, _)| *group_start);
    lines.into_iter().map(|(_, line)| line).collect()
}

pub fn parse_ttml(source: &str, duration_ms: u64) -> Result<Lyrics> {
    let document = roxmltree::Document::parse(source).context("Invalid TTML XML")?;
    // Duets: the first `person` agent declared in the head is the lead (else
    // `v1`); other single agents sing opposite. Group agents such as `v1000`
    // stay on the lead side.
    let lead_agent = document
        .descendants()
        .filter(|node| node.has_tag_name("agent") && attribute(*node, "type") == Some("person"))
        .find_map(|agent| attribute(agent, "id"))
        .unwrap_or("v1");
    // Apple-style heads carry per-line romanization and translation keyed by
    // the paragraph's `itunes:key`.
    let mut head_romanization = HashMap::new();
    let mut head_translation = HashMap::new();
    for text in document
        .descendants()
        .filter(|node| node.has_tag_name("text"))
    {
        let Some(key) = attribute(text, "for") else {
            continue;
        };
        let value = node_text(text, true).trim().to_owned();
        match text
            .ancestors()
            .find_map(|ancestor| match ancestor.tag_name().name() {
                "transliteration" => Some(true),
                "translation" => Some(false),
                _ => None,
            }) {
            Some(true) => head_romanization.insert(key, value),
            Some(false) => head_translation.insert(key, value),
            None => None,
        };
    }
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
        // Some exported files carry a bogus paragraph end (e.g. 00:00.000).
        // Recover from word timings below; drop the paragraph if it has none.
        let broken_end = end_ms < start_ms;
        let end_ms = end_ms.max(start_ms);
        let opposite = attribute(paragraph, "agent")
            .is_some_and(|agent| agent != lead_agent && !agent.ends_with("000"));
        let mut line = Line {
            start_ms,
            end_ms,
            text: node_text(paragraph, true).trim().to_owned(),
            background: attribute(paragraph, "role") == Some("x-bg"),
            opposite,
            ..Line::default()
        };
        let mut background = Line {
            start_ms,
            end_ms,
            background: true,
            opposite,
            ..Line::default()
        };
        for span in paragraph
            .descendants()
            .filter(|node| node.has_tag_name("span"))
        {
            let in_background = span
                .ancestors()
                .skip(1)
                .take_while(|parent| *parent != paragraph)
                .any(|parent| attribute(parent, "role") == Some("x-bg"));
            let target = if in_background {
                &mut background
            } else {
                &mut line
            };
            let role = attribute(span, "role").unwrap_or_default();
            if role.contains("translation") {
                target.translation = node_text(span, false).trim().into();
                continue;
            }
            if role.contains("roman") || role.contains("transliteration") {
                target.romanization = node_text(span, false).trim().into();
                continue;
            }
            if role == "x-bg" {
                // An untimed background span still shows as a static line.
                if !span
                    .descendants()
                    .any(|child| child != span && attribute(child, "begin").is_some())
                {
                    background.text = node_text(span, true).trim().into();
                }
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
                let mut text = node_text(span, true);
                // Syllables of one word sit in adjacent spans; whitespace text
                // between spans is what separates words.
                let spaced = span
                    .prev_sibling()
                    .and_then(|sibling| sibling.text())
                    .is_some_and(|between| between.chars().any(char::is_whitespace));
                if spaced
                    && target
                        .words
                        .last()
                        .is_some_and(|word| !word.text.ends_with(char::is_whitespace))
                    && !text.starts_with(char::is_whitespace)
                {
                    text.insert(0, ' ');
                }
                if !text.trim().is_empty() && word_end >= word_start {
                    target.words.push(Word {
                        start_ms: word_start,
                        end_ms: word_end,
                        text,
                    });
                }
            }
        }
        for target in [&mut line, &mut background] {
            if !target.words.is_empty() {
                target.text = target
                    .words
                    .iter()
                    .map(|word| word.text.as_str())
                    .collect::<String>()
                    .trim()
                    .to_owned();
                fit_to_words(target);
            }
            if target.background {
                strip_background_parentheses(target);
            }
        }
        if broken_end && line.words.is_empty() {
            continue;
        }
        if let Some(key) = attribute(paragraph, "key") {
            if line.romanization.is_empty()
                && let Some(text) = head_romanization.get(key)
            {
                line.romanization = text.clone();
            }
            if line.translation.is_empty()
                && let Some(text) = head_translation.get(key)
            {
                line.translation = text.clone();
            }
        }
        if !line.text.is_empty() || !line.romanization.is_empty() {
            lines.push((start_ms, line));
        }
        if !background.text.is_empty() {
            lines.push((start_ms, background));
        }
    }
    ensure!(
        !lines.is_empty(),
        "No timed lyric paragraphs found in this TTML file"
    );
    let lines = order_with_background(lines);
    Ok(Lyrics {
        lines,
        source: "Local TTML".into(),
        songwriters: document
            .descendants()
            .filter(|node| {
                node.is_element() && node.tag_name().name().eq_ignore_ascii_case("songwriter")
            })
            .filter_map(|node| node.text())
            .map(str::trim)
            .filter(|text| !text.is_empty())
            .take(100)
            .map(str::to_owned)
            .collect(),
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
    import_text(
        path.file_name()
            .and_then(|name| name.to_str())
            .unwrap_or_default(),
        &text,
        track,
    )
}

/// How an imported lyric file is kept, following Spicy Lyrics' Load TTML
/// modes (iPixelGalaxy/spicy-lyrics, UploadTTMLModal, AGPL-3.0).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ImportMode {
    /// Saved on disk; used whenever the song plays.
    #[default]
    Persistent,
    /// Kept in memory until the app restarts.
    Session,
    /// Shown now only; the next lyrics load replaces it.
    Temporary,
}

static SESSION: std::sync::LazyLock<std::sync::Mutex<std::collections::HashMap<String, Lyrics>>> =
    std::sync::LazyLock::new(Default::default);

pub fn import_with_mode(
    filename: &str,
    text: &str,
    track: &Track,
    mode: ImportMode,
) -> Result<Lyrics> {
    match mode {
        ImportMode::Persistent => import_text(filename, text, track),
        ImportMode::Session => {
            let (lyrics, _) = parse_import(filename, text, track)?;
            if let Ok(mut session) = SESSION.lock() {
                if session.len() >= 256 {
                    session.clear();
                }
                session.insert(track_key(track), lyrics.clone());
            }
            Ok(lyrics)
        }
        ImportMode::Temporary => Ok(parse_import(filename, text, track)?.0),
    }
}

fn parse_import(filename: &str, text: &str, track: &Track) -> Result<(Lyrics, &'static str)> {
    ensure!(text.len() <= 2_000_000, "Lyric file exceeds 2 MB");
    let extension = Path::new(filename)
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    Ok(match extension.as_str() {
        "lrc" => (parse_lrc(text, track.duration_ms)?, "lrc"),
        "ttml" | "xml" => (parse_ttml(text, track.duration_ms)?, "ttml"),
        _ => bail!("Choose an .lrc, .ttml, or .xml lyric file"),
    })
}

/// A saved import, for the TTML database list.
#[derive(Clone, Debug, Default, serde::Serialize, serde::Deserialize, PartialEq, Eq)]
pub struct SavedLyrics {
    pub key: String,
    #[serde(default)]
    pub uri: String,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub artists: String,
    #[serde(default)]
    pub kind: String,
    #[serde(default)]
    pub saved_at: u64,
    /// A small cover of the song's album.
    #[serde(default)]
    pub image: String,
}

pub fn saved_imports() -> Result<Vec<SavedLyrics>> {
    let directory = data_dir()?.join("lyrics").join("local");
    let mut saved = saved_in(&directory);
    // Imports from before song details were kept are named only by a hash
    // of the song's URI; match them against songs from cached pages, and
    // keep the details beside the file so the lookup happens once.
    if saved
        .iter()
        .any(|item| item.name.is_empty() || item.image.is_empty())
    {
        let known = crate::library_cache::known_tracks();
        complete_unknown(&directory, &mut saved, |key| known.get(key).cloned());
    }
    Ok(saved)
}

/// Fill in details for saved imports from looked-up songs and keep them.
pub fn complete_saved(saved: &mut [SavedLyrics], tracks: &[Track]) {
    let Ok(directory) = data_dir().map(|dir| dir.join("lyrics").join("local")) else {
        return;
    };
    complete_unknown(&directory, saved, |key| {
        tracks.iter().find(|track| track_key(track) == key).cloned()
    });
}

fn complete_unknown(
    directory: &Path,
    saved: &mut [SavedLyrics],
    lookup: impl Fn(&str) -> Option<Track>,
) {
    for item in saved
        .iter_mut()
        .filter(|item| item.name.is_empty() || item.image.is_empty())
    {
        let Some(track) = lookup(&item.key) else {
            continue;
        };
        let details = song_details(&track);
        let before = (item.name.clone(), item.image.clone());
        if item.name.is_empty() {
            item.name = details.name;
            item.artists = details.artists;
        }
        if item.uri.is_empty() {
            item.uri = details.uri;
        }
        if item.image.is_empty() {
            item.image = details.image;
        }
        if (item.name.clone(), item.image.clone()) != before
            && let Ok(bytes) = serde_json::to_vec(item)
        {
            let _ = fs::write(directory.join(format!("{}.meta.json", item.key)), bytes);
        }
    }
}

/// Name, artists, URI and a small album cover for a saved import.
fn song_details(track: &Track) -> SavedLyrics {
    let covers = || {
        track
            .album
            .images
            .iter()
            .filter(|image| image.url.starts_with("https://"))
    };
    // The smallest cover at least 64 px wide fills the 56 px list artwork.
    let image = covers()
        .filter(|image| image.width.is_some_and(|width| width >= 64))
        .min_by_key(|image| image.width)
        .or_else(|| covers().next())
        .map(|image| image.url.clone())
        .unwrap_or_default();
    SavedLyrics {
        key: track_key(track),
        uri: track.uri.clone(),
        name: track.name.clone(),
        artists: track
            .artists
            .iter()
            .map(|artist| artist.name.as_str())
            .collect::<Vec<_>>()
            .join(", "),
        image,
        ..SavedLyrics::default()
    }
}

/// A saved import's file, named after its song, for downloading.
pub fn saved_file(key: &str) -> Result<(String, String)> {
    ensure!(
        key.len() == 64 && key.bytes().all(|byte| byte.is_ascii_hexdigit()),
        "Invalid lyrics entry"
    );
    let directory = data_dir()?.join("lyrics").join("local");
    let (path, kind) = ["ttml", "lrc", "json"]
        .into_iter()
        .map(|kind| (directory.join(format!("{key}.{kind}")), kind))
        .find(|(path, _)| path.is_file())
        .context("Saved lyrics not found")?;
    ensure!(
        fs::metadata(&path)?.len() <= 2_000_000,
        "Lyric file exceeds 2 MB"
    );
    let contents = fs::read_to_string(&path)?;
    let meta = saved_in(&directory)
        .into_iter()
        .find(|item| item.key == key)
        .unwrap_or_default();
    Ok((download_name(&meta, kind), contents))
}

/// "Artists - Song.ttml", kept valid as a Windows file name.
fn download_name(meta: &SavedLyrics, kind: &str) -> String {
    let title = if meta.name.is_empty() {
        meta.key.chars().take(12).collect()
    } else if meta.artists.is_empty() {
        meta.name.clone()
    } else {
        format!("{} - {}", meta.artists, meta.name)
    };
    let safe: String = title
        .chars()
        .map(|c| {
            if r#"<>:"/\|?*"#.contains(c) || c.is_control() {
                '_'
            } else {
                c
            }
        })
        .take(120)
        .collect();
    format!("{}.{kind}", safe.trim().trim_end_matches('.'))
}

fn saved_in(directory: &Path) -> Vec<SavedLyrics> {
    let Ok(entries) = fs::read_dir(directory) else {
        return Vec::new();
    };
    let mut saved: Vec<SavedLyrics> = entries
        .flatten()
        .filter_map(|entry| {
            let path = entry.path();
            let kind = path.extension()?.to_str()?.to_owned();
            if !matches!(kind.as_str(), "ttml" | "lrc" | "json") {
                return None;
            }
            let key = path.file_stem()?.to_str()?.to_owned();
            if key.contains('.') {
                return None;
            }
            let mut item = fs::read(directory.join(format!("{key}.meta.json")))
                .ok()
                .and_then(|bytes| serde_json::from_slice::<SavedLyrics>(&bytes).ok())
                .unwrap_or_default();
            item.key = key;
            item.kind = kind;
            if item.saved_at == 0 {
                item.saved_at = entry
                    .metadata()
                    .and_then(|metadata| metadata.modified())
                    .ok()
                    .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
                    .map_or(0, |age| age.as_secs());
            }
            Some(item)
        })
        .take(10_000)
        .collect();
    saved.sort_by_key(|item| std::cmp::Reverse(item.saved_at));
    saved
}

/// Delete one saved import by its key.
pub fn delete_saved(key: &str) -> Result<()> {
    ensure!(
        key.len() == 64 && key.bytes().all(|byte| byte.is_ascii_hexdigit()),
        "Invalid lyrics entry"
    );
    let directory = data_dir()?.join("lyrics").join("local");
    for extension in ["ttml", "lrc", "json", "meta.json"] {
        let _ = fs::remove_file(directory.join(format!("{key}.{extension}")));
    }
    Ok(())
}

pub fn import_text(filename: &str, text: &str, track: &Track) -> Result<Lyrics> {
    ensure!(text.len() <= 2_000_000, "Lyric file exceeds 2 MB");
    let path = Path::new(filename);
    let extension = path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    let (lyrics, kind) = match extension.as_str() {
        "lrc" => (parse_lrc(text, track.duration_ms)?, "lrc"),
        "ttml" | "xml" => (parse_ttml(text, track.duration_ms)?, "ttml"),
        _ => bail!("Choose an .lrc, .ttml, or .xml lyric file"),
    };
    // Keep the original file per track (keyed by the Spotify URI) so it is
    // re-parsed with the current parser every time the song plays again.
    let directory = data_dir()?.join("lyrics").join("local");
    fs::create_dir_all(&directory)?;
    forget_local_in(&directory, track);
    fs::write(
        directory.join(format!("{}.{kind}", track_key(track))),
        text.as_bytes(),
    )?;
    let meta = SavedLyrics {
        kind: kind.into(),
        saved_at: std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_or(0, |age| age.as_secs()),
        ..song_details(track)
    };
    let _ = fs::write(
        directory.join(format!("{}.meta.json", track_key(track))),
        serde_json::to_vec(&meta)?,
    );
    Ok(lyrics)
}

/// Lyrics imported for this track, if any.
pub fn load_local(track: &Track) -> Option<Lyrics> {
    let directory = data_dir().ok()?.join("lyrics").join("local");
    load_local_in(&directory, track)
}

fn load_local_in(directory: &Path, track: &Track) -> Option<Lyrics> {
    let key = track_key(track);
    if let Ok(text) = fs::read_to_string(directory.join(format!("{key}.ttml"))) {
        return parse_ttml(&text, track.duration_ms).ok();
    }
    if let Ok(text) = fs::read_to_string(directory.join(format!("{key}.lrc"))) {
        return parse_lrc(&text, track.duration_ms).ok();
    }
    // Imports from earlier versions stored parsed JSON only.
    fs::read(directory.join(format!("{key}.json")))
        .ok()
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
}

/// Remove lyrics imported for this track so provider lyrics are used again.
pub fn forget_local(track: &Track) -> Result<()> {
    forget_local_in(&data_dir()?.join("lyrics").join("local"), track);
    Ok(())
}

fn forget_local_in(directory: &Path, track: &Track) {
    let key = track_key(track);
    if let Ok(mut session) = SESSION.lock() {
        session.remove(&key);
    }
    for extension in ["ttml", "lrc", "json", "meta.json"] {
        let _ = fs::remove_file(directory.join(format!("{key}.{extension}")));
    }
}

/// Drop this track's saved source answers, so the next fetch asks every
/// source again and picks up newly uploaded lyrics. Imports are kept.
pub fn forget_cached(track: &Track) -> Result<()> {
    forget_cached_in(&data_dir()?.join("lyrics").join("cache"), track);
    Ok(())
}

fn forget_cached_in(directory: &Path, track: &Track) {
    let file = format!("{}.json", track_key(track));
    for namespace in fs::read_dir(directory).into_iter().flatten().flatten() {
        if namespace.file_type().is_ok_and(|kind| kind.is_dir()) {
            let _ = fs::remove_file(namespace.path().join(&file));
        }
    }
}

/// Delete every saved source answer; imported lyrics stay.
pub fn clear_cache() -> Result<()> {
    let directory = data_dir()?.join("lyrics").join("cache");
    match fs::remove_dir_all(&directory) {
        Err(error) if error.kind() != std::io::ErrorKind::NotFound => Err(error.into()),
        _ => Ok(()),
    }
}

pub fn fetch(
    client: &Client,
    track: &Track,
    access_token: &str,
    native: &crate::native::NativeControls,
) -> Result<Lyrics> {
    fetch_from(client, track, access_token, native, true)
}

/// The best lyrics already on disk, in the chosen source order, without any
/// request or token: shown at once while the sources are asked again.
pub fn cached(
    client: &Client,
    track: &Track,
    native: &crate::native::NativeControls,
) -> Option<Lyrics> {
    fetch_from(client, track, "", native, false).ok()
}

fn fetch_from(
    client: &Client,
    track: &Track,
    access_token: &str,
    native: &crate::native::NativeControls,
    network: bool,
) -> Result<Lyrics> {
    let root = data_dir()?.join("lyrics");
    let key = track_key(track);
    if let Some(lyrics) = SESSION
        .lock()
        .ok()
        .and_then(|session| session.get(&key).cloned())
    {
        return Ok(lyrics);
    }
    if let Some(lyrics) = load_local_in(&root.join("local"), track) {
        return Ok(lyrics);
    }
    // A local song's lyrics can sit beside it: song.ttml next to song.mp3.
    if track.is_local
        && let Some((name, text)) = crate::local_files::sidecar_lyrics(&track.uri)
        && let Ok(lyrics) = if name.ends_with(".ttml") {
            parse_ttml(&text, track.duration_ms)
        } else {
            parse_lrc(&text, track.duration_ms)
        }
    {
        return Ok(lyrics);
    }
    // Every enabled source is asked at once; the best answer in the chosen
    // order wins as soon as it is known, while slower sources finish in the
    // background and keep their own three-day cache.
    let cache = std::sync::Arc::new(SourceCache { root, key, network });
    // Spicy Lyrics and Apple Music share one provider request.
    // Errors keep whether the provider was unreachable, as text and a flag.
    let provider: std::sync::Arc<std::sync::OnceLock<std::result::Result<Lyrics, (String, bool)>>> =
        Default::default();
    let (client, track, access_token, native) = (
        client.clone(),
        track.clone(),
        access_token.to_owned(),
        native.clone(),
    );
    let (sources, prefer_apple, words) = (
        crate::lyric_sources::enabled(),
        crate::lyric_sources::prefer_apple(),
        crate::lyric_sources::musixmatch_words(),
    );
    let fetch = move |source: &str| -> Result<Lyrics> {
        match source {
            "spicy" | "apple" => {
                let answer = provider.get_or_init(|| {
                    crate::provider::cache_namespace()
                        .and_then(|namespace| {
                            cache.get(&namespace, &|| {
                                crate::provider::fetch(&client, &track, &access_token)
                            })
                        })
                        // Lyrics saved before usernames were looked up get them now.
                        .map(|mut lyrics| {
                            if cache.network {
                                crate::provider::resolve_contributors(&mut lyrics);
                            }
                            lyrics
                        })
                        .map_err(|error| {
                            (error.to_string(), crate::lyric_sources::unreachable(&error))
                        })
                });
                let lyrics = answer.as_ref().map_err(|(message, unreachable)| {
                    if *unreachable {
                        crate::lyric_sources::Unreachable(message.clone()).into()
                    } else {
                        anyhow::anyhow!(message.clone())
                    }
                })?;
                crate::lyric_sources::split_provider(lyrics, source)
                    .with_context(|| format!("No {source} lyrics from the provider"))
            }
            // Line-only answers are cached apart, so switching shows the other.
            "musixmatch" => cache.get(
                if words {
                    "musixmatch"
                } else {
                    "musixmatch-lines"
                },
                &|| crate::lyric_sources::musixmatch(&client, &track, words),
            ),
            "spotify" => cache.get("spotify", &|| {
                crate::lyric_sources::spotify(&native, &track)
            }),
            "lrclib" => cache.get("lrclib", &|| crate::lyric_sources::lrclib(&client, &track)),
            "netease" => cache.get("netease", &|| {
                crate::lyric_sources::netease(&client, &track)
            }),
            _ => Err(anyhow::anyhow!("Unknown lyrics source")),
        }
    };
    crate::lyric_sources::fetch_best(&sources, prefer_apple, std::sync::Arc::new(fetch))
}

/// One song's per-source lyrics cache.
struct SourceCache {
    root: std::path::PathBuf,
    key: String,
    network: bool,
}

impl SourceCache {
    fn get(&self, namespace: &str, fetch: &dyn Fn() -> Result<Lyrics>) -> Result<Lyrics> {
        let cache = self.root.join("cache").join(namespace);
        let file = cache.join(format!("{}.json", self.key));
        let fresh = fs::metadata(&file)
            .and_then(|metadata| metadata.modified())
            .ok()
            .and_then(|modified| modified.elapsed().ok())
            .is_some_and(|age| age < std::time::Duration::from_secs(3 * 86_400));
        // Offline, any saved answer will do until the sources reply.
        if (fresh || !self.network)
            && let Ok(bytes) = fs::read(&file)
            && let Ok(lyrics) = serde_json::from_slice::<Lyrics>(&bytes)
        {
            return Ok(lyrics);
        }
        if !self.network {
            return Err(crate::lyric_sources::Unreachable("Offline and not saved".into()).into());
        }
        let lyrics = fetch()?;
        if fs::create_dir_all(&cache).is_ok() {
            let _ = fs::write(file, serde_json::to_vec(&lyrics)?);
        }
        Ok(lyrics)
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn ttml_songwriters_survive_cache_serialization() {
        let lyrics=parse_ttml(r#"<tt><head><songwriters><songwriter>Credit Writer</songwriter></songwriters></head><body><div><p begin="1s" end="2s">you</p></div></body></tt>"#,2000).unwrap();
        let restored: Lyrics =
            serde_json::from_slice(&serde_json::to_vec(&lyrics).unwrap()).unwrap();
        assert_eq!(restored.songwriters, vec!["Credit Writer"]);
        let legacy: Lyrics = serde_json::from_value(
            serde_json::json!({"lines":[],"source":"cache","instrumental":false,"synced":true}),
        )
        .unwrap();
        assert!(legacy.songwriters.is_empty());
    }

    #[test]
    fn overlapping_background_does_not_replace_active_lead() {
        let lyrics = Lyrics {
            synced: true,
            lines: vec![
                Line {
                    start_ms: 1000,
                    end_ms: 5000,
                    text: "Lead".into(),
                    ..Line::default()
                },
                Line {
                    start_ms: 2000,
                    end_ms: 3000,
                    text: "Background".into(),
                    background: true,
                    ..Line::default()
                },
            ],
            ..Lyrics::default()
        };
        assert_eq!(lyrics.active_line(2500), Some(0));
        assert_eq!(lyrics.active_line(4000), Some(0));
        assert_eq!(lyrics.active_line(5000), None);
    }

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
    fn ttml_splits_background_vocals_syllables_and_duets() {
        let text = r#"<tt xmlns="http://www.w3.org/ns/ttml" xmlns:ttm="http://www.w3.org/ns/ttml#metadata"><body><div><p begin="00:01.000" end="00:06.000" ttm:agent="v1"><span begin="00:01.000" end="00:01.500">Hel</span><span begin="00:01.500" end="00:02.000">lo</span> <span begin="00:02.000" end="00:03.000">there</span><span ttm:role="x-bg"><span begin="00:04.000" end="00:04.500">(oh</span> <span begin="00:04.500" end="00:05.000">yeah)</span></span></p><p begin="00:07.000" end="00:08.000" ttm:agent="v2"><span begin="00:07.000" end="00:08.000">Duet</span></p><p begin="00:09.000" end="00:10.000" ttm:agent="v2000"><span begin="00:09.000" end="00:10.000">Both</span></p></div></body></tt>"#;
        let lyrics = parse_ttml(text, 12_000).unwrap();
        let lead = &lyrics.lines[0];
        assert_eq!(lead.text, "Hello there");
        assert_eq!(lead.words.len(), 3);
        assert_eq!(lead.words[1].text, "lo");
        assert_eq!(lead.words[2].text, " there");
        assert!(!lead.background && !lead.opposite);
        let background = &lyrics.lines[1];
        assert!(background.background);
        assert_eq!(background.text, "oh yeah");
        assert_eq!(background.words[0].text, "oh");
        assert_eq!(background.words[1].text, " yeah");
        assert_eq!((background.start_ms, background.end_ms), (4000, 5000));
        assert!(lyrics.lines[2].opposite);
        assert!(!lyrics.lines[3].opposite);
    }

    #[test]
    fn ttml_reads_head_transliterations_by_key() {
        let text = r#"<tt xmlns="http://www.w3.org/ns/ttml" xmlns:ttm="http://www.w3.org/ns/ttml#metadata" xmlns:itunes="http://music.apple.com/lyric-ttml-internal"><head><metadata><ttm:agent type="person" xml:id="v1"/><iTunesMetadata xmlns="http://music.apple.com/lyric-ttml-internal"><transliterations><transliteration><text for="L1"><span begin="00:01.000" end="00:01.500">mi</span><span begin="00:01.500" end="00:02.000">kan</span> <span begin="00:02.000" end="00:02.500">sei</span></text></transliteration></transliterations></iTunesMetadata></metadata></head><body><div><p begin="00:01.000" end="00:02.500" ttm:agent="v1" itunes:key="L1"><span begin="00:01.000" end="00:02.000">未完</span><span begin="00:02.000" end="00:02.500">成</span></p></div></body></tt>"#;
        let lyrics = parse_ttml(text, 5_000).unwrap();
        assert_eq!(lyrics.lines.len(), 1);
        assert_eq!(lyrics.lines[0].text, "未完成");
        assert_eq!(lyrics.lines[0].romanization, "mikan sei");
    }

    /// Parses a local corpus of real AMLL/Apple-style TTML files when present
    /// (set SPOTIFLEX_TTML_DIR); skipped otherwise.
    #[test]
    fn ttml_corpus_parses() {
        let Ok(directory) = std::env::var("SPOTIFLEX_TTML_DIR") else {
            return;
        };
        let mut count = 0;
        for entry in fs::read_dir(directory).unwrap().flatten() {
            let path = entry.path();
            if path
                .extension()
                .is_some_and(|extension| extension == "ttml")
            {
                let source = fs::read_to_string(&path).unwrap();
                let lyrics = parse_ttml(&source, 0)
                    .unwrap_or_else(|error| panic!("{}: {error:#}", path.display()));
                assert!(
                    lyrics.lines.iter().any(|line| !line.words.is_empty()),
                    "{} has no timed words",
                    path.display()
                );
                for line in &lyrics.lines {
                    assert!(line.start_ms <= line.end_ms, "{}", path.display());
                    assert!(
                        !line.text.contains("  "),
                        "{}: {:?}",
                        path.display(),
                        line.text
                    );
                }
                count += 1;
            }
        }
        assert!(count > 0);
    }

    #[test]
    fn session_loads_last_until_reset_and_temporary_loads_are_not_kept() {
        let directory =
            std::env::temp_dir().join(format!("spotiflex-session-lyrics-{}", std::process::id()));
        fs::create_dir_all(&directory).unwrap();
        let track = Track {
            uri: "spotify:track:session".into(),
            duration_ms: 10_000,
            ..Track::default()
        };
        let session = |track: &Track| SESSION.lock().unwrap().get(&track_key(track)).cloned();
        import_with_mode(
            "song.lrc",
            "[00:01.00]Temporary",
            &track,
            ImportMode::Temporary,
        )
        .unwrap();
        assert!(session(&track).is_none());
        let lyrics =
            import_with_mode("song.lrc", "[00:01.00]Session", &track, ImportMode::Session).unwrap();
        assert_eq!(lyrics.lines[0].text, "Session");
        assert_eq!(session(&track).unwrap().lines[0].text, "Session");
        forget_local_in(&directory, &track);
        assert!(session(&track).is_none());
        assert!(import_with_mode("song.txt", "x", &track, ImportMode::Session).is_err());
        let _ = fs::remove_dir_all(directory);
    }
    #[test]
    fn forgetting_cached_lyrics_clears_every_source_for_that_song_only() {
        let directory =
            std::env::temp_dir().join(format!("spotiflex-lyric-cache-{}", std::process::id()));
        let song = Track {
            uri: "spotify:track:song".into(),
            ..Track::default()
        };
        let other = Track {
            uri: "spotify:track:other".into(),
            ..Track::default()
        };
        for namespace in ["provider", "lrclib"] {
            fs::create_dir_all(directory.join(namespace)).unwrap();
            for track in [&song, &other] {
                fs::write(
                    directory
                        .join(namespace)
                        .join(format!("{}.json", track_key(track))),
                    "{}",
                )
                .unwrap();
            }
        }
        forget_cached_in(&directory, &song);
        for namespace in ["provider", "lrclib"] {
            let path = |track: &Track| {
                directory
                    .join(namespace)
                    .join(format!("{}.json", track_key(track)))
            };
            assert!(!path(&song).exists());
            assert!(path(&other).exists());
        }
        let _ = fs::remove_dir_all(directory);
    }
    #[test]
    fn saved_imports_list_newest_first_with_song_details() {
        let directory =
            std::env::temp_dir().join(format!("spotiflex-saved-lyrics-{}", std::process::id()));
        fs::create_dir_all(&directory).unwrap();
        let (old, new) = ("a".repeat(64), "b".repeat(64));
        fs::write(directory.join(format!("{old}.lrc")), "[00:01.00]Old").unwrap();
        fs::write(directory.join(format!("{new}.ttml")), "<tt/>").unwrap();
        for (key, name, saved_at) in [(&old, "Old song", 1), (&new, "New song", 2)] {
            let meta = SavedLyrics {
                key: key.clone(),
                name: name.into(),
                saved_at,
                ..SavedLyrics::default()
            };
            fs::write(
                directory.join(format!("{key}.meta.json")),
                serde_json::to_vec(&meta).unwrap(),
            )
            .unwrap();
        }
        let saved = saved_in(&directory);
        let names: Vec<_> = saved.iter().map(|item| item.name.as_str()).collect();
        assert_eq!(names, ["New song", "Old song"]);
        // An older import without a name is matched and the name kept.
        let unnamed = "c".repeat(64);
        fs::write(directory.join(format!("{unnamed}.ttml")), "<tt/>").unwrap();
        let mut saved = saved_in(&directory);
        complete_unknown(&directory, &mut saved, |key| {
            (key == unnamed).then(|| Track {
                name: "Found song".into(),
                artists: vec![crate::model::Artist {
                    name: "Artist".into(),
                    ..Default::default()
                }],
                album: crate::model::Album {
                    images: vec![
                        crate::model::Artwork {
                            url: "https://i.scdn.co/image/large".into(),
                            width: Some(640),
                        },
                        crate::model::Artwork {
                            url: "https://i.scdn.co/image/small".into(),
                            width: Some(64),
                        },
                    ],
                    ..Default::default()
                },
                ..Track::default()
            })
        });
        let found = saved.iter().find(|item| item.name == "Found song").unwrap();
        assert_eq!(found.artists, "Artist");
        assert_eq!(found.image, "https://i.scdn.co/image/small");
        assert_eq!(download_name(found, "ttml"), "Artist - Found song.ttml");
        let tricky = SavedLyrics {
            name: "What? / Why: \"Now\"".into(),
            ..SavedLyrics::default()
        };
        assert_eq!(download_name(&tricky, "lrc"), "What_ _ Why_ _Now_.lrc");
        assert!(saved.iter().any(|item| item.name == "Found song"));
        assert!(
            saved_in(&directory)
                .iter()
                .any(|item| item.name == "Found song")
        );
        assert_eq!(saved[0].kind, "ttml");
        assert!(delete_saved("not-a-key").is_err());
        let _ = fs::remove_dir_all(directory);
    }
    #[test]
    fn local_lyrics_are_remembered_per_track_and_reparsed() {
        let directory =
            std::env::temp_dir().join(format!("spotiflex-local-lyrics-{}", std::process::id()));
        fs::create_dir_all(&directory).unwrap();
        let track = Track {
            uri: "spotify:track:abc".into(),
            ..Track::default()
        };
        let other = Track {
            uri: "spotify:track:def".into(),
            ..Track::default()
        };
        fs::write(
            directory.join(format!("{}.lrc", track_key(&track))),
            "[00:01.00]Hello",
        )
        .unwrap();
        assert_eq!(
            load_local_in(&directory, &track).unwrap().lines[0].text,
            "Hello"
        );
        assert!(load_local_in(&directory, &other).is_none());
        forget_local_in(&directory, &track);
        assert!(load_local_in(&directory, &track).is_none());
        let _ = fs::remove_dir_all(&directory);
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
