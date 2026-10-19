//! Translate native list snapshots and auxiliary speech into playback metadata.
use anyhow::{Context, Result, ensure};
use base64::{Engine, prelude::BASE64_STANDARD};
use librespot_protocol::{
    context_page::ContextPage, context_track::ContextTrack, playlist4_external::SelectedListContent,
};
use protobuf::CodedInputStream;
use std::collections::{HashMap, HashSet};

pub(super) fn page(value: &SelectedListContent, seen: &mut HashSet<String>) -> Result<ContextPage> {
    let contents = value
        .contents
        .as_ref()
        .context("DJ response has no tracks")?;
    let mut tracks = Vec::new();
    for (index, item) in contents.items.iter().enumerate() {
        let uri = item.uri();
        ensure!(
            uri.starts_with("spotify:track:") && uri.len() == 36,
            "Unsupported DJ item"
        );
        let attributes = item
            .attributes
            .as_ref()
            .context("DJ item metadata missing")?;
        let uid = attributes
            .item_id
            .as_ref()
            .filter(|id| !id.is_empty())
            .map(|id| BASE64_STANDARD.encode(id))
            .unwrap_or_else(|| format!("{}:{uri}", i64::from(contents.pos()) + index as i64));
        if seen.contains(&uid) {
            continue;
        }
        let mut metadata: HashMap<_, _> = attributes
            .format_attributes
            .iter()
            .map(|a| (a.key().to_owned(), a.value().to_owned()))
            .collect();
        if let Some(aux) = metadata.remove("auxiliary_media") {
            // Speech is optional; malformed speech must not discard valid music.
            if let Ok(fields) = narration(&aux) {
                metadata.extend(fields);
            }
        }
        seen.insert(uid.clone());
        tracks.push(ContextTrack {
            uri: Some(uri.into()),
            uid: Some(uid),
            metadata,
            ..Default::default()
        });
    }
    ensure!(
        seen.len() <= 20_000,
        "DJ session limit reached; ask DJ again"
    );
    Ok(ContextPage {
        tracks,
        ..Default::default()
    })
}

fn fields(bytes: &[u8]) -> Result<Vec<(u32, Vec<u8>)>> {
    let mut input = CodedInputStream::from_bytes(bytes);
    let mut values = Vec::new();
    while let Some(tag) = input.read_raw_tag_or_eof()? {
        if tag & 7 == 2 {
            values.push((tag >> 3, input.read_bytes()?));
        } else {
            input.skip_field(
                protobuf::rt::WireType::new(tag & 7).context("Invalid DJ speech field")?,
            )?;
        }
    }
    Ok(values)
}
fn nested(bytes: &[u8], number: u32) -> Result<Vec<u8>> {
    fields(bytes)?
        .into_iter()
        .find(|(n, _)| *n == number)
        .map(|(_, v)| v)
        .context("DJ speech data missing")
}

fn narration(encoded: &str) -> Result<HashMap<String, String>> {
    ensure!(encoded.len() <= 200_000, "DJ speech too large");
    let bytes = BASE64_STANDARD.decode(encoded)?;
    let mut metadata = HashMap::new();
    // Auxiliary entries carry a media description and separate transition timing.
    // Current native DJ replies place the before-track line first.
    for (_, entry) in fields(&bytes)?.into_iter().filter(|(n, _)| *n == 1).take(1) {
        let media = nested(&entry, 1)?;
        let audio = nested(&media, 2)?;
        let tts = nested(&audio, 1)?;
        for (number, value) in fields(&tts)? {
            let name = match number {
                2 => "ssml",
                3 => "voice",
                4 => "tts_provider",
                _ => continue,
            };
            metadata.insert(format!("narration.intro.{name}"), String::from_utf8(value)?);
        }
        if let Ok(reporting) = nested(&media, 4) {
            for (number, value) in fields(&reporting)? {
                let name = match number {
                    2 => "title",
                    3 => "album_title",
                    4 => "artist",
                    5 => "commentary_type",
                    6 => "decision_id",
                    7 => "custom_reporting_attribution",
                    _ => continue,
                };
                metadata.insert(format!("narration.intro.{name}"), String::from_utf8(value)?);
            }
        }
    }
    ensure!(
        metadata.contains_key("narration.intro.ssml"),
        "DJ speech script missing"
    );
    Ok(metadata)
}

#[cfg(test)]
mod tests {
    use super::*;
    use librespot_protocol::playlist4_external::{
        FormatListAttribute, Item, ItemAttributes, ListItems,
    };
    fn snapshot(ids: &[u8]) -> SelectedListContent {
        SelectedListContent {
            contents: Some(ListItems {
                items: ids
                    .iter()
                    .map(|id| Item {
                        uri: Some("spotify:track:0123456789abcdefghijkl".into()),
                        attributes: Some(ItemAttributes {
                            item_id: Some(vec![*id]),
                            ..Default::default()
                        })
                        .into(),
                        ..Default::default()
                    })
                    .collect(),
                ..Default::default()
            })
            .into(),
            ..Default::default()
        }
    }
    #[test]
    fn cumulative_pages_keep_new_occurrences_without_replaying_old_ones() {
        let mut seen = HashSet::new();
        assert_eq!(page(&snapshot(&[1, 2]), &mut seen).unwrap().tracks.len(), 2);
        let next = page(&snapshot(&[1, 2, 3]), &mut seen).unwrap();
        assert_eq!(next.tracks.len(), 1);
        assert_eq!(next.tracks[0].uid.as_deref(), Some("Aw=="));
        assert!(
            page(&snapshot(&[1, 2, 3]), &mut seen)
                .unwrap()
                .tracks
                .is_empty()
        );
    }
    fn message(values: &[(u32, &[u8])]) -> Vec<u8> {
        let mut bytes = Vec::new();
        let mut out = protobuf::CodedOutputStream::vec(&mut bytes);
        for (number, value) in values {
            out.write_bytes(*number, value).unwrap();
        }
        out.flush().unwrap();
        drop(out);
        bytes
    }
    #[test]
    fn native_speech_is_translated_without_carrying_signed_urls() {
        let tts = message(&[
            (2, b"<speak>Jazz time.</speak>"),
            (3, b"VOICE33"),
            (4, b"SONANTIC_FAST"),
        ]);
        let audio = message(&[(1, &tts)]);
        let reporting = message(&[(2, b"Up next"), (8, b"https://example.test/signed-secret")]);
        let media = message(&[(2, &audio), (4, &reporting)]);
        let entry = message(&[(1, &media)]);
        let encoded = BASE64_STANDARD.encode(message(&[(1, &entry)]));
        let metadata = narration(&encoded).unwrap();
        assert_eq!(
            metadata["narration.intro.ssml"],
            "<speak>Jazz time.</speak>"
        );
        assert!(!metadata.values().any(|s| s.contains("signed-secret")));
        let mut value = snapshot(&[1]);
        value.contents.as_mut().unwrap().items[0]
            .attributes
            .as_mut()
            .unwrap()
            .format_attributes
            .push(FormatListAttribute {
                key: Some("auxiliary_media".into()),
                value: Some(encoded),
                ..Default::default()
            });
        assert!(
            page(&value, &mut HashSet::new()).unwrap().tracks[0]
                .metadata
                .contains_key("narration.intro.voice")
        );
        assert!(narration("malformed!").is_err());
    }
}
