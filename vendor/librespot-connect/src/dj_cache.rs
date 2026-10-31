use crate::{context_resolver::LEXICON_CONTEXT_URL, core::Session, protocol::context::Context};
use log::warn;
use std::{
    collections::HashSet,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};
use tokio::sync::OnceCell;

pub(crate) const DJ_URI: &str = "spotify:playlist:37i9dQZF1EYkqdzj48dyYq";
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
    /// Sets started since Lyssna opened, so starting DJ again moves on.
    heard: Mutex<HashSet<String>>,
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
            heard: Mutex::new(HashSet::new()),
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
            .is_some_and(|key| self.heard.lock().is_ok_and(|heard| heard.contains(&key)));
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
        if let (Some(key), Ok(mut heard)) = (set_key(&context), self.heard.lock()) {
            if heard.len() > 500 {
                heard.clear();
            }
            heard.insert(key);
        }
        context
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
