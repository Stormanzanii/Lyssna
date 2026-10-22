//! Spotify user profile pages, read through the native session like the
//! desktop client: the profile view service plus the viewer's top artists.
use crate::home::{HomeItem, HomeSection};
use crate::model::Artwork;
use anyhow::{Context, Result, ensure};
use librespot_core::Session;
use serde::Serialize;
use serde_json::{Value, json};
use std::time::Duration;

/// Spotify's persisted query for the viewer's top artists and tracks.
const TOP_CONTENT_HASH: &str = "49ee15704de4a7fdeac65a02db20604aa11e46f02e809c55d9a89f6db9754356";
/// Response bodies are small JSON; refuse anything far larger.
const MAX_BYTES: usize = 2_000_000;

#[derive(Clone, Default, Serialize)]
pub struct UserProfilePage {
    pub id: String,
    pub name: String,
    pub images: Vec<Artwork>,
    pub public_playlists: u64,
    pub followers: u64,
    pub following: u64,
    pub is_current_user: bool,
    /// Top artists, public playlists, recently played artists, followers
    /// and following, in Spotify's order. Empty lists are left out.
    pub sections: Vec<HomeSection>,
}

/// A user ID as Spotify's profile paths accept it.
pub fn valid_user(id: &str) -> bool {
    !id.is_empty() && id.len() <= 128 && !id.chars().any(char::is_control)
}

pub async fn fetch(session: &Session, user: &str) -> Result<UserProfilePage> {
    ensure!(valid_user(user), "Invalid Spotify profile");
    let encoded: String = url::form_urlencoded::byte_serialize(user.as_bytes()).collect();
    let view = |path: String| async move {
        let bytes = tokio::time::timeout(
            Duration::from_secs(10),
            session
                .spclient()
                .request_as_json(&reqwest::Method::GET, &path, None, None),
        )
        .await
        .context("Spotify profile request timed out")??;
        ensure!(
            bytes.len() <= MAX_BYTES,
            "Spotify profile response too large"
        );
        Ok::<Value, anyhow::Error>(serde_json::from_slice(&bytes)?)
    };
    let own = user == session.username();
    let top = async {
        if !own {
            return None;
        }
        crate::catalogue::query(
            session,
            "userTopContent",
            TOP_CONTENT_HASH,
            json!({
                "includeTopArtists": true,
                "topArtistsInput": {"offset": 0, "limit": 20, "sortBy": "AFFINITY", "timeRange": "SHORT_TERM"},
                "includeTopTracks": false,
                "topTracksInput": {"offset": 0, "limit": 0, "sortBy": "AFFINITY", "timeRange": "SHORT_TERM"},
            }),
        )
        .await
        .ok()
    };
    let (profile, followers, following, top) = tokio::join!(
        view(format!(
            "/user-profile-view/v3/profile/{encoded}?playlist_limit=50&artist_limit=50&episode_limit=0&market=from_token"
        )),
        view(format!(
            "/user-profile-view/v3/profile/{encoded}/followers?market=from_token"
        )),
        view(format!(
            "/user-profile-view/v3/profile/{encoded}/following?market=from_token"
        )),
        top,
    );
    page(
        user,
        &profile?,
        top.as_ref(),
        followers.ok().as_ref(),
        following.ok().as_ref(),
    )
}

/// Assemble the page; optional lists that failed to load are left out.
fn page(
    user: &str,
    profile: &Value,
    top: Option<&Value>,
    followers: Option<&Value>,
    following: Option<&Value>,
) -> Result<UserProfilePage> {
    let uri = format!("spotify:user:{user}");
    ensure!(
        profile["uri"].as_str() == Some(uri.as_str()),
        "Spotify profile belongs to a different account"
    );
    let name = profile["name"]
        .as_str()
        .map(str::trim)
        .filter(|name| !name.is_empty())
        .unwrap_or(user)
        .to_owned();
    let count = |key: &str| profile[key].as_u64().unwrap_or_default();
    let list = |value: Option<&Value>, key: &str| -> Vec<HomeItem> {
        value
            .and_then(|value| value[key].as_array())
            .map(|items| items.iter().filter_map(entity).collect())
            .unwrap_or_default()
    };
    let top_artists: Vec<HomeItem> = top
        .and_then(|value| value["data"]["me"]["profile"]["topArtists"]["items"].as_array())
        .map(|items| items.iter().filter_map(top_artist).collect())
        .unwrap_or_default();
    let playlists: Vec<HomeItem> = profile["public_playlists"]
        .as_array()
        .map(|items| items.iter().filter_map(playlist).collect())
        .unwrap_or_default();
    let section = |key: &str, title: &str, subtitle: &str, items: Vec<HomeItem>| HomeSection {
        uri: format!("{uri}:{key}"),
        title: title.into(),
        subtitle: subtitle.into(),
        items,
        ..HomeSection::default()
    };
    let sections = [
        section(
            "top-artists",
            "Top artists this month",
            "Only visible to you",
            top_artists,
        ),
        section("playlists", "Public Playlists", "", playlists),
        section(
            "recent-artists",
            "Recently played artists",
            "",
            list(Some(profile), "recently_played_artists"),
        ),
        section("followers", "Followers", "", list(followers, "profiles")),
        section("following", "Following", "", list(following, "profiles")),
    ]
    .into_iter()
    .filter(|section| !section.items.is_empty())
    .collect();
    Ok(UserProfilePage {
        id: user.into(),
        name,
        images: image(profile["image_url"].as_str()),
        public_playlists: count("total_public_playlists_count"),
        followers: count("followers_count"),
        following: count("following_count"),
        is_current_user: profile["is_current_user"].as_bool().unwrap_or_default(),
        sections,
    })
}

/// An artist or user from the profile view service.
fn entity(value: &Value) -> Option<HomeItem> {
    let uri = value["uri"].as_str()?;
    let name = value["name"].as_str()?.trim();
    if name.is_empty() {
        return None;
    }
    let (kind, route, subtitle) = if let Some(id) = uri.strip_prefix("spotify:artist:") {
        catalogue_id(id)?;
        ("artist", format!("artist:{id}"), "Artist")
    } else {
        let id = uri
            .strip_prefix("spotify:user:")
            .filter(|id| valid_user(id))?;
        ("user", format!("user:{id}"), "Profile")
    };
    Some(HomeItem {
        uri: uri.into(),
        route,
        name: name.into(),
        subtitle: subtitle.into(),
        images: image(value["image_url"].as_str()),
        kind: kind.into(),
        playable: kind == "artist",
        format: String::new(),
    })
}

fn top_artist(item: &Value) -> Option<HomeItem> {
    let artist = &item["data"];
    let uri = artist["uri"].as_str()?;
    let id = uri.strip_prefix("spotify:artist:")?;
    catalogue_id(id)?;
    let name = artist["profile"]["name"].as_str()?.trim();
    if name.is_empty() {
        return None;
    }
    let mut images: Vec<Artwork> = artist["visuals"]["avatarImage"]["sources"]
        .as_array()
        .map(|sources| {
            sources
                .iter()
                .filter_map(|source| {
                    let url = safe_url(source["url"].as_str()?)?;
                    Some(Artwork {
                        url,
                        width: source["width"].as_u64().and_then(|w| u32::try_from(w).ok()),
                    })
                })
                .collect()
        })
        .unwrap_or_default();
    images.sort_by_key(|image| std::cmp::Reverse(image.width));
    Some(HomeItem {
        uri: uri.into(),
        route: format!("artist:{id}"),
        name: name.into(),
        subtitle: "Artist".into(),
        images,
        kind: "artist".into(),
        playable: true,
        format: String::new(),
    })
}

fn playlist(value: &Value) -> Option<HomeItem> {
    let uri = value["uri"].as_str()?;
    let id = uri.strip_prefix("spotify:playlist:")?;
    catalogue_id(id)?;
    let name = value["name"].as_str()?.trim();
    if name.is_empty() {
        return None;
    }
    // Spotify shows a follower count when there is one, else the owner.
    let subtitle = match value["followers_count"].as_u64() {
        Some(1) => "1 Follower".to_owned(),
        Some(count) if count > 1 => format!("{count} Followers"),
        _ => value["owner_name"]
            .as_str()
            .map(str::trim)
            .filter(|owner| !owner.is_empty())
            .map_or_else(|| "Playlist".into(), |owner| format!("By {owner}")),
    };
    Some(HomeItem {
        uri: uri.into(),
        route: format!("playlist:{id}"),
        name: name.into(),
        subtitle,
        images: image(value["image_url"].as_str()),
        kind: "playlist".into(),
        playable: true,
        format: String::new(),
    })
}

fn catalogue_id(id: &str) -> Option<()> {
    (id.len() == 22 && id.bytes().all(|byte| byte.is_ascii_alphanumeric())).then_some(())
}

/// Profile images arrive as HTTPS URLs or Spotify image URIs, including
/// four-cover playlist mosaics.
fn image(value: Option<&str>) -> Vec<Artwork> {
    let hex = |part: &str| {
        !part.is_empty() && part.len() <= 64 && part.bytes().all(|b| b.is_ascii_hexdigit())
    };
    let url = match value.map(str::trim) {
        Some(uri) if uri.starts_with("spotify:mosaic:") => {
            let parts: Vec<_> = uri["spotify:mosaic:".len()..].split(':').collect();
            (parts.len() == 4 && parts.iter().all(|part| hex(part)))
                .then(|| format!("https://mosaic.scdn.co/640/{}", parts.concat()))
        }
        Some(uri) if uri.starts_with("spotify:image:") => {
            let id = &uri["spotify:image:".len()..];
            hex(id).then(|| format!("https://i.scdn.co/image/{id}"))
        }
        Some(url) => safe_url(url),
        None => None,
    };
    url.map(|url| vec![Artwork { url, width: None }])
        .unwrap_or_default()
}

fn safe_url(value: &str) -> Option<String> {
    let url = url::Url::parse(value).ok()?;
    (url.scheme() == "https"
        && url.username().is_empty()
        && url.password().is_none()
        && url.host_str().is_some())
    .then(|| url.into())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn profile() -> Value {
        json!({
            "uri": "spotify:user:listener",
            "name": " Listener ",
            "image_url": "https://i.scdn.co/image/ab6775700000ee85",
            "followers_count": 9,
            "following_count": 38,
            "total_public_playlists_count": 3,
            "is_current_user": true,
            "public_playlists": [
                {"uri": "spotify:playlist:0123456789abcdefghijkl", "name": "Mix",
                 "image_url": "spotify:mosaic:ab67616d00001e02aa:ab67616d00001e02bb:ab67616d00001e02cc:ab67616d00001e02dd",
                 "owner_name": "Listener"},
                {"uri": "spotify:playlist:0123456789abcdefghijkm", "name": "Vibes",
                 "image_url": "https://image-cdn-ak.spotifycdn.com/image/ab67706c", "followers_count": 1},
                {"uri": "spotify:playlist:../../escape", "name": "Bad"}
            ],
            "recently_played_artists": [
                {"uri": "spotify:artist:0123456789abcdefghijkl", "name": "Artist",
                 "image_url": "http://insecure.example/image"}
            ]
        })
    }

    #[test]
    fn profile_page_follows_spotify_sections_and_rejects_unsafe_items() {
        let top = json!({"data": {"me": {"profile": {"topArtists": {"items": [
            {"data": {"__typename": "Artist", "uri": "spotify:artist:0123456789abcdefghijkm",
                      "profile": {"name": "Top"},
                      "visuals": {"avatarImage": {"sources": [
                          {"url": "https://i.scdn.co/image/small", "width": 160},
                          {"url": "https://i.scdn.co/image/large", "width": 640}]}}}}
        ]}}}}});
        let followers = json!({"profiles": [
            {"uri": "spotify:user:friend", "name": "Friend"},
            {"uri": "spotify:user:", "name": "Empty"}
        ]});
        let following = json!({"profiles": [
            {"uri": "spotify:artist:0123456789abcdefghijkn", "name": "Band"},
            {"uri": "spotify:user:pal", "name": "Pal", "image_url": "https://i.scdn.co/image/pal"}
        ]});
        let page = page(
            "listener",
            &profile(),
            Some(&top),
            Some(&followers),
            Some(&following),
        )
        .unwrap();
        assert_eq!(page.name, "Listener");
        assert_eq!(
            (page.public_playlists, page.followers, page.following),
            (3, 9, 38)
        );
        assert!(page.is_current_user);
        let titles: Vec<_> = page.sections.iter().map(|s| s.title.as_str()).collect();
        assert_eq!(
            titles,
            [
                "Top artists this month",
                "Public Playlists",
                "Recently played artists",
                "Followers",
                "Following"
            ]
        );
        assert_eq!(page.sections[0].subtitle, "Only visible to you");
        assert_eq!(
            page.sections[0].items[0].images[0].url,
            "https://i.scdn.co/image/large"
        );
        let playlists = &page.sections[1].items;
        assert_eq!(playlists.len(), 2, "invalid playlist IDs are dropped");
        assert_eq!(
            playlists[0].images[0].url,
            "https://mosaic.scdn.co/640/ab67616d00001e02aaab67616d00001e02bbab67616d00001e02ccab67616d00001e02dd"
        );
        assert_eq!(playlists[0].subtitle, "By Listener");
        assert_eq!(playlists[1].subtitle, "1 Follower");
        assert!(
            page.sections[2].items[0].images.is_empty(),
            "http images are dropped"
        );
        let friends = &page.sections[3].items;
        assert_eq!(friends.len(), 1);
        assert_eq!(
            (friends[0].route.as_str(), friends[0].subtitle.as_str()),
            ("user:friend", "Profile")
        );
        assert!(!friends[0].playable);
        let follows = &page.sections[4].items;
        assert_eq!(follows[0].route, "artist:0123456789abcdefghijkn");
        assert_eq!(follows[1].route, "user:pal");
    }

    #[test]
    fn other_profiles_skip_missing_lists_and_reject_mismatched_accounts() {
        let mut other = profile();
        other["uri"] = json!("spotify:user:other");
        assert!(page("listener", &other, None, None, None).is_err());
        let mut sparse = profile();
        sparse["public_playlists"] = json!([]);
        let page = page("listener", &sparse, None, None, None).unwrap();
        let titles: Vec<_> = page.sections.iter().map(|s| s.title.as_str()).collect();
        assert_eq!(titles, ["Recently played artists"]);
        assert!(!valid_user(""));
        assert!(!valid_user("a\nb"));
    }

    #[test]
    #[ignore = "Reads the saved account's own profile page; never writes"]
    fn live_own_profile_page() {
        let client = crate::auth::http_client().unwrap();
        let login = crate::native_login::authenticate(
            &client,
            true,
            &std::sync::atomic::AtomicBool::new(false),
        )
        .unwrap()
        .expect("Saved native sign-in required");
        let session = login.connection.0.clone();
        let page = login
            .runtime
            .block_on(fetch(&session, &session.username()))
            .unwrap();
        assert!(page.is_current_user);
        assert!(!page.name.is_empty());
        for section in &page.sections {
            println!("{}: {} items", section.title, section.items.len());
            assert!(section.items.iter().all(|item| !item.name.is_empty()));
        }
        println!(
            "{} public playlists, {} followers, {} following",
            page.public_playlists, page.followers, page.following
        );
    }
}
