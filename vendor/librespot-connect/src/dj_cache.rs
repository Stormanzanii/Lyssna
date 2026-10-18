use crate::{context_resolver::LEXICON_CONTEXT_URL, core::Session, protocol::context::Context};
use std::{
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};
use tokio::sync::OnceCell;

pub(crate) const DJ_URI: &str = "spotify:playlist:37i9dQZF1EYkqdzj48dyYq";
struct Prepared {
    source: String,
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
fn matches_request(prepared: &Prepared, uri: &str, fresh: bool) -> bool {
    (uri == DJ_URI && fresh) || uri == prepared.source
}
impl DjCache {
    pub fn new(session: Session) -> Self {
        Self {
            session,
            current: Mutex::new(None),
        }
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
                .map(|prepared| prepared.source.as_str())
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
        let context = prepared.context.clone();
        self.prepare(Some(context.clone()));
        Some(context)
    }
}
async fn fetch(session: &Session, seed: Option<Context>) -> Option<Prepared> {
    tokio::time::timeout(Duration::from_secs(8), async {
        let mut context = match seed {
            Some(context)
                if context
                    .pages
                    .last()
                    .and_then(|page| page.next_page_url.as_ref())
                    .is_some() =>
            {
                context
            }
            _ => {
                let shell = session.spclient().get_context(DJ_URI).await.ok()?;
                let url = shell.metadata.get(LEXICON_CONTEXT_URL)?;
                let mut context = session.spclient().get_context_url(url).await.ok()?;
                for (key, value) in shell.metadata {
                    context.metadata.entry(key).or_insert(value);
                }
                context
            }
        };
        let source = context.pages.last()?.next_page_url.clone()?;
        let page = session.spclient().get_context_page(&source).await.ok()?;
        if page.tracks.is_empty() {
            return None;
        }
        context.pages = vec![page];
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
    fn restored_sessions_never_consume_an_unheard_fresh_set() {
        let ready = Prepared {
            source: "hm://next-set".into(),
            context: Context::default(),
        };
        assert!(!matches_request(&ready, DJ_URI, false));
        assert!(matches_request(&ready, DJ_URI, true));
        assert!(matches_request(&ready, "hm://next-set", false));
        assert!(!matches_request(&ready, "hm://other-session", false));
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
