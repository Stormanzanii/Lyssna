use anyhow::{Result, ensure};
use protobuf::CodedInputStream;

pub fn video_url(bytes: &[u8], uri: &str) -> Result<Option<String>> {
    ensure!(bytes.len() <= 1_000_000, "Canvas response too large");
    let mut stream = CodedInputStream::from_bytes(bytes);
    while let Some(tag) = stream.read_raw_tag_or_eof()? {
        if tag != 10 {
            protobuf::rt::skip_field_for_tag(tag, &mut stream)?;
            continue;
        }
        let bytes = stream.read_bytes()?;
        let mut record = CodedInputStream::from_bytes(&bytes);
        let (mut source, mut entity, mut kind) = (String::new(), String::new(), 0);
        while let Some(tag) = record.read_raw_tag_or_eof()? {
            match tag {
                18 => source = record.read_string()?,
                32 => kind = record.read_uint32()?,
                42 => entity = record.read_string()?,
                _ => protobuf::rt::skip_field_for_tag(tag, &mut record)?,
            }
        }
        if entity != uri || !matches!(kind, 1..=3) {
            continue;
        }
        let url = url::Url::parse(&source)?;
        if url.scheme() == "https"
            && matches!(url.host_str(), Some("canvaz.scdn.co" | "video-fa.scdn.co"))
            && url.username().is_empty()
            && url.password().is_none()
            && url.port_or_known_default() == Some(443)
        {
            return Ok(Some(url.into()));
        }
    }
    Ok(None)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn canvas_matches_track_and_only_trusted_silent_video_sources() {
        let uri = "spotify:track:0123456789abcdefghijkl";
        let mut url = "https://canvaz.scdn.co/test.mp4";
        let pack = |url: &str| {
            let mut encoded = Vec::new();
            let mut record = protobuf::CodedOutputStream::vec(&mut encoded);
            record.write_string(2, url).unwrap();
            record.write_uint32(4, 2).unwrap();
            record.write_string(5, uri).unwrap();
            record.flush().unwrap();
            drop(record);
            let mut outer = Vec::new();
            let mut stream = protobuf::CodedOutputStream::vec(&mut outer);
            stream.write_bytes(1, &encoded).unwrap();
            stream.flush().unwrap();
            drop(stream);
            outer
        };
        assert_eq!(
            video_url(&pack(url), uri).unwrap().as_deref(),
            Some("https://canvaz.scdn.co/test.mp4")
        );
        assert!(
            video_url(&pack(url), "spotify:track:other")
                .unwrap()
                .is_none()
        );
        url = "https://canvaz.scdn.co.attacker.test/a.mp4";
        assert!(video_url(&pack(url), uri).unwrap().is_none());
        assert!(video_url(&[16, 144, 28], uri).unwrap().is_none());
    }
}
