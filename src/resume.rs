//! Per-account listening position, without credentials or automatic playback.
use crate::model::{Playback, Track};
use anyhow::Result;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    sync::{LazyLock, Mutex},
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

#[derive(Clone, Deserialize, Serialize)]
pub struct LastPlayed {
    pub track: Track,
    pub position_ms: u64,
    pub played_at: u64,
}
type SaveHistory = HashMap<String, (String, bool, Instant)>;
static SAVES: LazyLock<Mutex<SaveHistory>> = LazyLock::new(|| Mutex::new(HashMap::new()));
fn path(account: &str) -> Result<std::path::PathBuf> {
    let digest = Sha256::digest(account.as_bytes());
    let key = digest
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    Ok(crate::config::data_dir()?
        .join("resume")
        .join(format!("{key}.json")))
}
pub fn load(account: &str) -> Option<LastPlayed> {
    let path = path(account).ok()?;
    if std::fs::metadata(&path).ok()?.len() > 2_000_000 {
        return None;
    }
    let value: LastPlayed = serde_json::from_slice(&std::fs::read(path).ok()?).ok()?;
    value
        .track
        .uri
        .starts_with("spotify:track:")
        .then_some(value)
}
pub fn newer(local: Option<LastPlayed>, spotify: Option<LastPlayed>) -> Option<LastPlayed> {
    match (local, spotify) {
        (Some(local), Some(spotify)) => Some(if spotify.played_at > local.played_at {
            spotify
        } else {
            local
        }),
        (local, spotify) => local.or(spotify),
    }
}
pub fn save(account: &str, playback: &Playback, observed_at: u64, force: bool) -> Result<()> {
    let Some(track) = playback.item.as_ref().filter(|track| !track.is_local) else {
        return Ok(());
    };
    let mut saves = SAVES
        .lock()
        .map_err(|_| anyhow::anyhow!("Resume storage unavailable"))?;
    if !force
        && saves.get(account).is_some_and(|(uri, playing, saved)| {
            uri == &track.uri
                && *playing == playback.is_playing
                && saved.elapsed() < Duration::from_secs(5)
        })
    {
        return Ok(());
    }
    let now = SystemTime::now().duration_since(UNIX_EPOCH)?.as_millis() as u64;
    let position_ms = (playback.progress_ms.unwrap_or_default()
        + if playback.is_playing {
            now.saturating_sub(observed_at)
        } else {
            0
        })
    .min(track.duration_ms);
    let value = LastPlayed {
        track: track.clone(),
        position_ms,
        played_at: now,
    };
    let path = path(account)?;
    std::fs::create_dir_all(path.parent().unwrap())?;
    let temporary = path.with_extension("tmp");
    std::fs::write(&temporary, serde_json::to_vec(&value)?)?;
    std::fs::rename(temporary, path)?;
    saves.insert(
        account.into(),
        (track.uri.clone(), playback.is_playing, Instant::now()),
    );
    Ok(())
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn most_recent_listening_source_wins() {
        let value = |played_at| LastPlayed {
            track: Track::default(),
            position_ms: 50,
            played_at,
        };
        assert_eq!(
            newer(Some(value(20)), Some(value(10))).unwrap().played_at,
            20
        );
        assert_eq!(
            newer(Some(value(20)), Some(value(30))).unwrap().played_at,
            30
        );
        assert!(newer(None, None).is_none());
    }
}
