use anyhow::Result;
use sha2::{Digest, Sha256};
use std::{
    sync::{
        Arc,
        atomic::{AtomicU64, Ordering},
    },
    time::{SystemTime, UNIX_EPOCH},
};
#[derive(Clone)]
pub struct Backoff {
    until: Arc<AtomicU64>,
    path: Option<std::path::PathBuf>,
}
fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}
#[derive(Debug)]
pub struct CoolingDown(pub u64);
impl std::fmt::Display for CoolingDown {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        if self.0 >= 3600 {
            write!(
                f,
                "Spotify catalogue limit reached. Retry in about {} hours. Native playback remains available.",
                self.0.div_ceil(3600)
            )
        } else {
            write!(
                f,
                "Spotify catalogue limit reached. Retry in {} seconds. Native playback remains available.",
                self.0
            )
        }
    }
}
impl std::error::Error for CoolingDown {}
impl Backoff {
    pub fn new(client_id: &str) -> Self {
        let key = Sha256::digest(client_id)
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>();
        let path = crate::config::data_dir()
            .ok()
            .map(|root| root.join("spotify-cooldown").join(format!("{key}.json")));
        let until = path
            .as_ref()
            .and_then(|path| std::fs::read(path).ok())
            .and_then(|bytes| serde_json::from_slice::<u64>(&bytes).ok())
            .unwrap_or_default();
        Self {
            until: Arc::new(AtomicU64::new(until)),
            path,
        }
    }
    pub fn remaining(&self) -> u64 {
        self.until.load(Ordering::Acquire).saturating_sub(now())
    }
    pub fn check(&self) -> Result<()> {
        let remaining = self.remaining();
        if remaining > 0 {
            return Err(CoolingDown(remaining).into());
        }
        Ok(())
    }
    pub fn pause(&self, seconds: u64) {
        self.until
            .fetch_max(now().saturating_add(seconds.max(1)), Ordering::AcqRel);
        if let Some(path) = &self.path
            && let Some(parent) = path.parent()
        {
            let _ = std::fs::create_dir_all(parent);
            let _ = std::fs::write(path, self.until.load(Ordering::Acquire).to_string());
        }
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn cloned_clients_share_cooldowns_and_longer_waits_win() {
        let backoff = Backoff {
            until: Arc::new(AtomicU64::new(0)),
            path: None,
        };
        let other = backoff.clone();
        backoff.pause(120);
        other.pause(10);
        assert!(other.remaining() > 100);
        assert!(backoff.check().is_err());
    }
}
