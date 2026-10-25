//! Spotify's What's New feed: new releases from followed artists, behind the
//! bell beside the profile button. Read only; items are never marked seen.
use crate::model::{Artist, Artwork};
use anyhow::Result;
use librespot_core::Session;
use serde::Serialize;
use serde_json::{Value, json};

#[derive(Clone, Default, Serialize)]
pub struct Release {
    pub id: String,
    pub uri: String,
    pub name: String,
    /// Spotify's album type, such as SINGLE, ALBUM or EP.
    pub album_type: String,
    pub artists: Vec<Artist>,
    pub images: Vec<Artwork>,
    /// When the release went out, as Spotify reports it (ISO 8601).
    pub released: String,
    /// Not yet seen in a Spotify client.
    pub new: bool,
}

pub async fn fetch(session: &Session) -> Result<Vec<Release>> {
    // Persisted query identifier from Spotify's desktop What's New panel.
    let data = crate::catalogue::query(
        session,
        "queryWhatsNewFeed",
        "d889c8c936ab192af8ced595427f5ba2acdf63478fdc0a181c8d477f8322630e",
        json!({"offset":0,"limit":50,"onlyUnPlayedItems":false,"includedContentTypes":[],"includeEpisodeContentRatingsV2":false}),
    )
    .await?;
    Ok(parse(&data))
}

/// Music releases only; podcast episodes in the feed are skipped.
fn parse(data: &Value) -> Vec<Release> {
    data["data"]["whatsNewFeedItems"]["items"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|item| {
            let album = &item["content"]["data"];
            if item["content"]["__typename"] != "AlbumResponseWrapper"
                || album["__typename"] != "Album"
            {
                return None;
            }
            let uri = album["uri"].as_str()?.to_owned();
            let mut images: Vec<Artwork> = album["coverArt"]["sources"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(|source| {
                    let url = source["url"].as_str()?;
                    url.starts_with("https://").then(|| Artwork {
                        url: url.to_owned(),
                        width: source["width"].as_u64().and_then(|w| u32::try_from(w).ok()),
                    })
                })
                .collect();
            images.sort_by_key(|image| std::cmp::Reverse(image.width));
            Some(Release {
                id: item["id"].as_str().unwrap_or_default().to_owned(),
                name: album["name"].as_str().unwrap_or_default().to_owned(),
                album_type: album["albumType"].as_str().unwrap_or_default().to_owned(),
                artists: album["artists"]["items"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .map(|artist| {
                        let uri = artist["uri"].as_str().unwrap_or_default();
                        Artist {
                            id: uri.strip_prefix("spotify:artist:").map(str::to_owned),
                            uri: uri.to_owned(),
                            name: artist["profile"]["name"]
                                .as_str()
                                .unwrap_or_default()
                                .to_owned(),
                            ..Artist::default()
                        }
                    })
                    .collect(),
                images,
                released: album["date"]["isoString"]
                    .as_str()
                    .or_else(|| item["timestamp"]["isoString"].as_str())
                    .unwrap_or_default()
                    .to_owned(),
                new: item["state"]["state"] == "NEW",
                uri,
            })
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn feed_keeps_releases_and_skips_episodes() {
        let data = json!({"data":{"whatsNewFeedItems":{"items":[
            {"id":"music_release:a","state":{"state":"NEW"},"content":{"__typename":"AlbumResponseWrapper","data":{
                "__typename":"Album","albumType":"SINGLE","name":"Song","uri":"spotify:album:5jGFlFGPRbQYzKUM5ux9v3",
                "artists":{"items":[{"uri":"spotify:artist:0pWR7TsFhvSCnbmHDjWgrE","profile":{"name":"Creepy Nuts"}}]},
                "coverArt":{"sources":[{"url":"https://i.scdn.co/image/small","width":64},{"url":"https://i.scdn.co/image/large","width":640},{"url":"http://insecure","width":300}]},
                "date":{"isoString":"2026-10-21T00:00:00Z"}}}},
            {"id":"episode:b","state":{"state":"SEEN"},"content":{"__typename":"EpisodeOrChapterResponseWrapper","data":{"__typename":"Episode"}}}
        ]}}});
        let releases = parse(&data);
        assert_eq!(releases.len(), 1);
        let release = &releases[0];
        assert!(release.new);
        assert_eq!(release.album_type, "SINGLE");
        assert_eq!(release.artists[0].name, "Creepy Nuts");
        assert_eq!(
            release.artists[0].id.as_deref(),
            Some("0pWR7TsFhvSCnbmHDjWgrE")
        );
        assert_eq!(release.images.len(), 2);
        assert_eq!(release.images[0].width, Some(640));
        assert_eq!(release.released, "2026-10-21T00:00:00Z");
    }
}
