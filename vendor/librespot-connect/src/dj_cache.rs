use crate::{context_resolver::LEXICON_CONTEXT_URL, core::Session, protocol::context::Context};
use log::warn;
use std::{
    path::PathBuf,
    sync::{Arc, Mutex, OnceLock},
    time::{Duration, Instant},
};
use tokio::sync::OnceCell;

pub(crate) const DJ_URI: &str = "spotify:playlist:37i9dQZF1EYkqdzj48dyYq";
const HEARD_LIMIT: usize = 200;
static HEARD_PATH: OnceLock<fn(&str) -> Option<PathBuf>> = OnceLock::new();

/// Where each account's started DJ sets are kept, so starting DJ after a
/// restart moves on instead of replaying the set heard before it.
pub fn keep_dj_sets_at(path: fn(&str) -> Option<PathBuf>) {
    let _ = HEARD_PATH.set(path);
}
fn read_heard(path: &PathBuf) -> Vec<String> {
    std::fs::read_to_string(path)
        .ok()
        .filter(|text| text.len() < 2_000_000)
        .map(|text| {
            text.lines()
                .filter(|key| !key.is_empty() && key.len() < 4096)
                .map(str::to_owned)
                .collect::<Vec<_>>()
        })
        .map(|mut keys| {
            let extra = keys.len().saturating_sub(HEARD_LIMIT);
            keys.drain(..extra);
            keys
        })
        .unwrap_or_default()
}
fn write_heard(path: &PathBuf, keys: &[String]) {
    let Some(parent) = path.parent() else {
        return;
    };
    let temporary = path.with_extension("tmp");
    let written = std::fs::create_dir_all(parent)
        .and_then(|()| std::fs::write(&temporary, keys.join("\n")))
        .and_then(|()| std::fs::rename(&temporary, path));
    if let Err(error) = written {
        warn!("could not save heard DJ sets: {error}");
    }
}
struct Prepared {
    /// The `next_page_url` a following set was fetched from, or `None` for
    /// the set DJ's session is on now.
    source: Option<String>,
    context: Context,
}
struct Pending {
    created: Instant,
    seed: Option<Context>,
    ready: OnceCell<Option<Prepared>>,
}
impl Pending {
    fn new(seed: Option<Context>) -> Self {
        Self {
            created: Instant::now(),
            seed,
            ready: OnceCell::new(),
        }
    }
}
pub(crate) struct DjCache {
    session: Session,
    current: Mutex<Option<Arc<Pending>>>,
    /// Sets started here, oldest first, loaded from disk on first use.
    heard: Mutex<Option<Vec<String>>>,
}
/// Names a set: its page URL, else its first track.
fn set_key(context: &Context) -> Option<String> {
    let page = context.pages.last()?;
    page.page_url
        .clone()
        .filter(|url| !url.is_empty())
        .or_else(|| {
            let track = page.tracks.first()?;
            track
                .uid
                .clone()
                .filter(|uid| !uid.is_empty())
                .or_else(|| track.uri.clone())
        })
}
fn claim(current: &Mutex<Option<Arc<Pending>>>, expected: &Arc<Pending>) -> bool {
    let Ok(mut current) = current.lock() else {
        return false;
    };
    if current
        .as_ref()
        .is_some_and(|current| Arc::ptr_eq(current, expected))
    {
        current.take();
        true
    } else {
        false
    }
}
/// Starting DJ takes only the session's current set; a following set
/// serves only the page it was fetched for.
fn matches_request(prepared: &Prepared, uri: &str, fresh: bool) -> bool {
    if uri == DJ_URI {
        fresh && prepared.source.is_none()
    } else {
        prepared.source.as_deref() == Some(uri)
    }
}
impl DjCache {
    pub fn clear(&self) {
        if let Ok(mut current) = self.current.lock() {
            current.take();
        }
    }
    pub fn new(session: Session) -> Self {
        Self {
            session,
            current: Mutex::new(None),
            heard: Mutex::new(None),
        }
    }
    /// What starting DJ plays. Like Spotify, DJ carries on with the set its
    /// session is on, which opens with the listener's familiar artists; only
    /// a set already started here moves on to a new one, as "Let DJ pick"
    /// does. Asking for a new set on every start skipped past those.
    pub async fn fresh_set(&self, mut context: Context) -> Context {
        if let Some(latest) = context.pages.pop() {
            context.pages = vec![latest];
        }
        let heard = set_key(&context)
            .and_then(|key| self.with_heard(|heard| heard.contains(&key)))
            .unwrap_or(false);
        let next = context
            .pages
            .last()
            .and_then(|page| page.next_page_url.clone())
            .filter(|_| heard);
        if let Some(next) = next {
            match tokio::time::timeout(
                Duration::from_secs(8),
                self.session.spclient().get_context_page(&next),
            )
            .await
            {
                Ok(Ok(page)) if !page.tracks.is_empty() => context.pages = vec![page],
                _ => warn!("no new DJ set, carrying on with the current one"),
            }
        }
        if let Some(key) = set_key(&context) {
            let path = self.heard_path();
            self.with_heard(|heard| {
                if heard.contains(&key) {
                    return;
                }
                heard.push(key);
                let extra = heard.len().saturating_sub(HEARD_LIMIT);
                heard.drain(..extra);
                if let Some(path) = &path {
                    write_heard(path, heard);
                }
            });
        }
        context
    }
    fn heard_path(&self) -> Option<PathBuf> {
        let account = self.session.username();
        (!account.is_empty()).then(|| HEARD_PATH.get()?(&account))?
    }
    fn with_heard<T>(&self, use_heard: impl FnOnce(&mut Vec<String>) -> T) -> Option<T> {
        let path = self.heard_path();
        let mut heard = self.heard.lock().ok()?;
        let heard = heard.get_or_insert_with(|| path.as_ref().map(read_heard).unwrap_or_default());
        Some(use_heard(heard))
    }
    pub fn prepare(&self, seed: Option<Context>) {
        let pending = {
            let Ok(mut current) = self.current.lock() else {
                return;
            };
            if current
                .as_ref()
                .is_some_and(|pending| pending.created.elapsed() < Duration::from_secs(900))
            {
                return;
            }
            let pending = Arc::new(Pending::new(seed));
            *current = Some(pending.clone());
            pending
        };
        let session = self.session.clone();
        tokio::spawn(async move {
            let prepared = pending
                .ready
                .get_or_init(|| fetch(&session, pending.seed.clone()))
                .await;
            if let Some(prepared) = prepared
                && let Some(track) = prepared
                    .context
                    .pages
                    .iter()
                    .flat_map(|page| &page.tracks)
                    .next()
            {
                let narration = track
                    .metadata
                    .iter()
                    .filter(|(key, _)| key.starts_with("narration."))
                    .map(|(key, value)| (key.clone(), value.clone()))
                    .collect();
                crate::playback::narration::prefetch(&session, &narration, 0).await;
            }
        });
    }
    pub async fn take(&self, uri: &str, fresh: bool) -> Option<Context> {
        if uri == DJ_URI && !fresh {
            return None;
        }
        if uri == DJ_URI {
            self.prepare(None);
        }
        let pending = self.current.lock().ok()?.clone()?;
        if uri != DJ_URI {
            let source = pending
                .ready
                .get()
                .and_then(Option::as_ref)
                .and_then(|prepared| prepared.source.as_deref())
                .or_else(|| {
                    pending
                        .seed
                        .as_ref()?
                        .pages
                        .last()?
                        .next_page_url
                        .as_deref()
                });
            if source != Some(uri) {
                return None;
            }
        }
        let Some(prepared) = pending
            .ready
            .get_or_init(|| fetch(&self.session, pending.seed.clone()))
            .await
        else {
            claim(&self.current, &pending);
            return None;
        };
        if !matches_request(prepared, uri, fresh) || !claim(&self.current, &pending) {
            return None;
        }
        Some(prepared.context.clone())
    }
}
/// With a playing set, the set after it; without, the set DJ's session is
/// on now. Nothing here moves the session past a set nobody heard.
async fn fetch(session: &Session, seed: Option<Context>) -> Option<Prepared> {
    tokio::time::timeout(Duration::from_secs(8), async {
        let (source, mut context) = match seed {
            Some(mut context) => {
                let source = context.pages.last()?.next_page_url.clone()?;
                let page = session.spclient().get_context_page(&source).await.ok()?;
                context.pages = vec![page];
                (Some(source), context)
            }
            None => {
                let shell = session.spclient().get_context(DJ_URI).await.ok()?;
                let url = shell.metadata.get(LEXICON_CONTEXT_URL)?;
                let mut context = session.spclient().get_context_url(url).await.ok()?;
                for (key, value) in shell.metadata {
                    context.metadata.entry(key).or_insert(value);
                }
                let latest = context.pages.pop()?;
                context.pages = vec![latest];
                (None, context)
            }
        };
        if context.pages.iter().all(|page| page.tracks.is_empty()) {
            return None;
        }
        context.uri = Some(DJ_URI.into());
        context.url = Some(format!("context://{DJ_URI}"));
        Some(Prepared { source, context })
    })
    .await
    .ok()
    .flatten()
}
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn heard_sets_survive_a_restart_and_keep_the_newest() {
        let dir = std::env::temp_dir().join(format!("lyssna-dj-heard-{}", std::process::id()));
        let path = dir.join("account.dj-sets.txt");
        let keys: Vec<String> = (0..HEARD_LIMIT + 5)
            .map(|n| format!("hm://set/{n}"))
            .collect();
        write_heard(&path, &keys);
        let read = read_heard(&path);
        assert_eq!(read.len(), HEARD_LIMIT);
        assert_eq!(read.first().map(String::as_str), Some("hm://set/5"));
        assert_eq!(read.last(), keys.last());
        assert!(read_heard(&dir.join("missing.txt")).is_empty());
        let _ = std::fs::remove_dir_all(dir);
    }
    #[test]
    fn starting_dj_takes_the_current_set_never_one_prepared_ahead() {
        let current = Prepared {
            source: None,
            context: Context::default(),
        };
        assert!(matches_request(&current, DJ_URI, true));
        assert!(!matches_request(&current, DJ_URI, false));
        assert!(!matches_request(&current, "hm://next-set", false));
        let following = Prepared {
            source: Some("hm://next-set".into()),
            context: Context::default(),
        };
        assert!(!matches_request(&following, DJ_URI, true));
        assert!(!matches_request(&following, DJ_URI, false));
        assert!(matches_request(&following, "hm://next-set", false));
        assert!(!matches_request(&following, "hm://other-session", false));
    }
    #[test]
    fn prepared_sets_are_consumed_once_and_old_requests_cannot_steal_replacements() {
        let first = Arc::new(Pending::new(None));
        let current = Mutex::new(Some(first.clone()));
        assert!(claim(&current, &first));
        assert!(!claim(&current, &first));
        let replacement = Arc::new(Pending::new(None));
        *current.lock().unwrap() = Some(replacement.clone());
        assert!(!claim(&current, &first));
        assert!(claim(&current, &replacement));
    }
}
