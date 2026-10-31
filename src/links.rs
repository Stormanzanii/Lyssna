//! `lyssna://` links: a song to play, or an album, playlist or artist to
//! open, as `spotify:` links open Spotify. A link comes from a browser or
//! another app, so only well-formed IDs are taken from it.
use serde::Serialize;
use std::sync::Mutex;

pub const SCHEME: &str = "lyssna";

/// What a link asks for.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", content = "value", rename_all = "lowercase")]
pub enum Link {
    /// Play a song by its `spotify:track:` URI.
    Play(String),
    /// Open a page by its route, as `album:<id>`.
    Open(String),
    /// Only bring Lyssna to the front.
    Show,
}

/// A `lyssna://` link, also written `lyssna:track:<id>` like Spotify's
/// own links.
pub fn parse(text: &str) -> Option<Link> {
    let rest = text.strip_prefix(SCHEME)?.strip_prefix(':')?;
    let rest = rest.trim_start_matches('/');
    // Anything after the item, as `?si=` from a shared link, is ignored.
    let rest = rest.split(['?', '#']).next().unwrap_or_default();
    let rest = rest.trim_end_matches('/');
    if rest.is_empty() {
        return Some(Link::Show);
    }
    let (kind, id) = rest.split_once(['/', ':'])?;
    let spotify_id = id.len() == 22 && id.bytes().all(|byte| byte.is_ascii_alphanumeric());
    match kind {
        "track" if spotify_id => Some(Link::Play(format!("spotify:track:{id}"))),
        "album" | "playlist" | "artist" if spotify_id => Some(Link::Open(format!("{kind}:{id}"))),
        // Usernames are older than Spotify IDs and may hold `.`, `_` and `-`.
        "user"
            if id.len() <= 64
                && id.bytes().any(|byte| byte.is_ascii_alphanumeric())
                && id
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || b"._-".contains(&byte)) =>
        {
            Some(Link::Open(format!("user:{id}")))
        }
        // Podcasts don't play in Lyssna; the link still brings it up.
        "episode" | "show" if spotify_id => Some(Link::Show),
        _ => None,
    }
}

/// The first link among command-line arguments, as Windows passes one.
pub fn from_args<I: IntoIterator<Item = S>, S: AsRef<str>>(args: I) -> Option<Link> {
    args.into_iter().find_map(|argument| {
        let argument = argument.as_ref();
        argument
            .get(..SCHEME.len() + 1)
            .is_some_and(|start| start.eq_ignore_ascii_case("lyssna:"))
            .then(|| parse(&format!("{SCHEME}{}", &argument[SCHEME.len()..])))
            .flatten()
    })
}

/// The latest link not yet acted on: the interface takes it once signed in
/// and ready to play.
static PENDING: Mutex<Option<Link>> = Mutex::new(None);

pub fn keep(link: Link) {
    if let Ok(mut pending) = PENDING.lock() {
        *pending = Some(link);
    }
}

pub fn take() -> Option<Link> {
    PENDING.lock().ok()?.take()
}

/// Make Windows open `lyssna://` links with this copy. The per-user key
/// needs no administrator rights and follows the copy wherever it moves.
#[cfg(windows)]
pub fn register() -> anyhow::Result<()> {
    use anyhow::bail;
    use windows::Win32::Foundation::ERROR_SUCCESS;
    use windows::Win32::System::Registry::{HKEY_CURRENT_USER, REG_SZ, RegSetKeyValueW};
    use windows::core::{HSTRING, PCWSTR};

    let exe = std::env::current_exe()?;
    let exe = exe.to_string_lossy();
    let root = format!(r"Software\Classes\{SCHEME}");
    let values = [
        (root.clone(), "", "URL:Lyssna".to_owned()),
        (root.clone(), "URL Protocol", String::new()),
        (format!(r"{root}\DefaultIcon"), "", format!("\"{exe}\",0")),
        (
            format!(r"{root}\shell\open\command"),
            "",
            format!("\"{exe}\" \"%1\""),
        ),
    ];
    for (key, name, value) in values {
        let (key, name) = (HSTRING::from(key), HSTRING::from(name));
        let mut data: Vec<u16> = value.encode_utf16().collect();
        data.push(0);
        let status = unsafe {
            RegSetKeyValueW(
                HKEY_CURRENT_USER,
                PCWSTR(key.as_ptr()),
                PCWSTR(name.as_ptr()),
                REG_SZ.0,
                Some(data.as_ptr().cast()),
                (data.len() * 2) as u32,
            )
        };
        if status != ERROR_SUCCESS {
            bail!("Cannot register lyssna:// links");
        }
    }
    // Lyssna was SpotiFlex, whose `spotiflex://` links it no longer opens.
    let former = HSTRING::from(r"Software\Classes\spotiflex");
    let _ = unsafe {
        windows::Win32::System::Registry::RegDeleteTreeW(HKEY_CURRENT_USER, PCWSTR(former.as_ptr()))
    };
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    const ID: &str = "4uLU6hMCjMI75M1A2tKUQC";

    #[test]
    fn links_play_songs_and_open_pages() {
        let play = Some(Link::Play(format!("spotify:track:{ID}")));
        assert_eq!(parse(&format!("lyssna://track/{ID}")), play);
        assert_eq!(parse(&format!("lyssna:track:{ID}")), play);
        assert_eq!(parse(&format!("lyssna://track/{ID}/?si=abc")), play);
        for kind in ["album", "playlist", "artist"] {
            assert_eq!(
                parse(&format!("lyssna://{kind}/{ID}")),
                Some(Link::Open(format!("{kind}:{ID}")))
            );
        }
        assert_eq!(
            parse("lyssna://user/some.user_name-1"),
            Some(Link::Open("user:some.user_name-1".into()))
        );
        assert_eq!(parse(&format!("lyssna://episode/{ID}")), Some(Link::Show));
        assert_eq!(parse("lyssna://"), Some(Link::Show));
        assert_eq!(parse("lyssna:"), Some(Link::Show));
    }

    #[test]
    fn malformed_links_are_refused() {
        assert_eq!(parse(&format!("spotify://track/{ID}")), None);
        assert_eq!(parse("lyssna://track/short"), None);
        assert_eq!(parse(&format!("lyssna://track/{ID}x")), None);
        assert_eq!(parse("lyssna://track/4uLU6hMCjMI75M1A2tKU%2F"), None);
        assert_eq!(parse("lyssna://user/a%20b"), None);
        assert_eq!(parse("lyssna://user/.."), None);
        assert_eq!(parse("lyssna://settings"), None);
    }

    #[test]
    fn links_are_found_among_arguments() {
        let args = [
            "lyssna.exe",
            "--minimized",
            "Lyssna://album/4uLU6hMCjMI75M1A2tKUQC",
        ];
        assert_eq!(from_args(args), Some(Link::Open(format!("album:{ID}"))));
        assert_eq!(from_args(["lyssna.exe", "--quit"]), None);
    }
}
