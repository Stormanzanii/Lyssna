use librespot_core::Session;
use std::{
    collections::HashMap,
    sync::{Arc, Mutex, OnceLock},
    time::{Duration, Instant},
};
use tokio::sync::OnceCell;

type Audio = Arc<Vec<u8>>;
type Slot = Arc<OnceCell<Downloaded>>;
struct Downloaded {
    completed: Instant,
    data: Option<Audio>,
}
#[derive(Clone, Hash, PartialEq, Eq)]
struct Key {
    account: String,
    device: String,
    script: String,
    voice: String,
    provider: String,
}
struct Entry {
    created: Instant,
    value: Slot,
}
static CACHE: OnceLock<Mutex<HashMap<Key, Entry>>> = OnceLock::new();
fn slot(cache: &mut HashMap<Key, Entry>, key: Key, now: Instant) -> Slot {
    cache.retain(|_, entry| {
        let (completed, ttl) = entry
            .value
            .get()
            .map(|download| {
                (
                    download.completed,
                    if download.data.is_none() {
                        Duration::from_secs(2)
                    } else {
                        Duration::from_secs(1800)
                    },
                )
            })
            .unwrap_or((entry.created, Duration::from_secs(1800)));
        now.saturating_duration_since(completed) < ttl
    });
    if let Some(entry) = cache.get(&key) {
        return entry.value.clone();
    }
    if cache.len() >= 32
        && let Some(oldest) = cache
            .iter()
            .min_by_key(|(_, entry)| entry.created)
            .map(|(key, _)| key.clone())
    {
        cache.remove(&oldest);
    }
    let value = Arc::new(OnceCell::new());
    cache.insert(
        key,
        Entry {
            created: now,
            value: value.clone(),
        },
    );
    value
}
pub(crate) async fn line(
    session: &Session,
    metadata: &HashMap<String, String>,
    kind: &str,
) -> Option<Audio> {
    let field = |name: &str| {
        metadata
            .get(&format!("narration.{kind}.{name}"))
            .cloned()
            .unwrap_or_default()
    };
    let script = field("ssml");
    if script.is_empty() {
        return None;
    }
    let key = Key {
        account: session.username().to_owned(),
        device: session.device_id().to_owned(),
        script,
        voice: field("voice"),
        provider: field("tts_provider"),
    };
    let value = {
        let mut cache = CACHE.get_or_init(Default::default).lock().ok()?;
        slot(&mut cache, key.clone(), Instant::now())
    };
    value
        .get_or_init(|| async {
            let data = async {
                let client = session.spclient();
                let fetch = client.get_narration(&key.script, &key.voice, &key.provider);
                let mp3 = tokio::time::timeout(Duration::from_secs(8), fetch)
                    .await
                    .ok()?
                    .ok()?;
                (mp3.len() <= 2_000_000).then(|| Arc::new(mp3.to_vec()))
            }
            .await;
            Downloaded {
                completed: Instant::now(),
                data,
            }
        })
        .await
        .data
        .clone()
}
#[cfg(test)]
mod tests {
    use super::*;
    fn key(account: &str, script: &str) -> Key {
        Key {
            account: account.into(),
            device: "device".into(),
            script: script.into(),
            voice: "voice".into(),
            provider: "provider".into(),
        }
    }
    #[test]
    fn identical_lines_share_pending_work_only_within_the_account() {
        let mut cache = HashMap::new();
        let now = Instant::now();
        let first = slot(&mut cache, key("one", "intro"), now);
        assert!(Arc::ptr_eq(
            &first,
            &slot(&mut cache, key("one", "intro"), now)
        ));
        assert!(!Arc::ptr_eq(
            &first,
            &slot(&mut cache, key("two", "intro"), now)
        ));
    }
    #[test]
    fn transient_failure_expires_without_discarding_ready_audio() {
        let mut cache = HashMap::new();
        let now = Instant::now();
        let failed = slot(&mut cache, key("one", "failed"), now);
        assert!(
            failed
                .set(Downloaded {
                    completed: now,
                    data: None
                })
                .is_ok()
        );
        let ready = slot(&mut cache, key("one", "ready"), now);
        assert!(
            ready
                .set(Downloaded {
                    completed: now,
                    data: Some(Arc::new(vec![1, 2]))
                })
                .is_ok()
        );
        let later = now + Duration::from_secs(3);
        assert!(!Arc::ptr_eq(
            &failed,
            &slot(&mut cache, key("one", "failed"), later)
        ));
        assert!(Arc::ptr_eq(
            &ready,
            &slot(&mut cache, key("one", "ready"), later)
        ));
    }
    #[test]
    fn old_lines_are_evicted_before_memory_grows_unbounded() {
        let mut cache = HashMap::new();
        let now = Instant::now();
        for index in 0..33 {
            slot(
                &mut cache,
                key("one", &index.to_string()),
                now + Duration::from_millis(index),
            );
        }
        assert_eq!(cache.len(), 32);
        assert!(!cache.contains_key(&key("one", "0")));
        assert!(cache.contains_key(&key("one", "32")));
    }
    #[test]
    fn a_slow_failed_fetch_does_not_trigger_an_immediate_second_timeout() {
        let mut cache = HashMap::new();
        let now = Instant::now();
        let failed = slot(
            &mut cache,
            key("one", "failed"),
            now - Duration::from_secs(8),
        );
        assert!(
            failed
                .set(Downloaded {
                    completed: now,
                    data: None
                })
                .is_ok()
        );
        assert!(Arc::ptr_eq(
            &failed,
            &slot(
                &mut cache,
                key("one", "failed"),
                now + Duration::from_secs(1)
            )
        ));
        assert!(!Arc::ptr_eq(
            &failed,
            &slot(
                &mut cache,
                key("one", "failed"),
                now + Duration::from_secs(3)
            )
        ));
    }
}
