use anyhow::{Result, ensure};
use std::{
    collections::VecDeque,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
};

#[derive(Clone, Default)]
pub struct Requests(Arc<Mutex<State>>);
#[derive(Default)]
struct State {
    active: Option<Active>,
    retired: VecDeque<String>,
}
struct Active {
    id: String,
    cancelled: Arc<AtomicBool>,
    busy: bool,
}
pub struct Ticket {
    owner: Requests,
    pub cancelled: Arc<AtomicBool>,
}

pub fn authorize(current: Option<&str>, native_ready: bool, account: &str) -> Result<()> {
    ensure!(
        !account.is_empty() && current == Some(account),
        "Sign in before asking DJ"
    );
    ensure!(native_ready, "Native audio is connecting");
    Ok(())
}
impl Requests {
    pub fn reserve(&self, id: &str) -> Result<Ticket> {
        ensure!(
            !id.is_empty()
                && id.len() <= 128
                && id
                    .bytes()
                    .all(|c| c.is_ascii_alphanumeric() || matches!(c, b'-' | b'_')),
            "Invalid DJ request ID"
        );
        let mut state = self
            .0
            .lock()
            .map_err(|_| anyhow::anyhow!("DJ unavailable"))?;
        ensure!(
            !state.retired.iter().any(|v| v == id),
            "DJ request cancelled"
        );
        ensure!(
            !state.active.as_ref().is_some_and(|v| v.busy),
            "DJ request already in progress"
        );
        if let Some(old) = state.active.take() {
            old.cancelled.store(true, Ordering::Release);
        }
        let cancelled = Arc::new(AtomicBool::new(false));
        state.active = Some(Active {
            id: id.into(),
            cancelled: cancelled.clone(),
            busy: true,
        });
        Ok(Ticket {
            owner: self.clone(),
            cancelled,
        })
    }
    pub fn cancel(&self, id: &str) {
        if let Ok(mut state) = self.0.lock() {
            if let Some(active) = state.active.as_ref().filter(|v| v.id == id) {
                active.cancelled.store(true, Ordering::Release);
            }
            state.retire(id);
        }
    }
    pub fn cancel_all(&self) {
        if let Ok(state) = self.0.lock()
            && let Some(active) = &state.active
        {
            active.cancelled.store(true, Ordering::Release);
        }
    }
}
impl State {
    fn retire(&mut self, id: &str) {
        if id.len() <= 128 {
            self.retired.push_back(id.into());
            while self.retired.len() > 32 {
                self.retired.pop_front();
            }
        }
    }
}
impl Drop for Ticket {
    fn drop(&mut self) {
        if let Ok(mut state) = self.owner.0.lock()
            && let Some(active) = state
                .active
                .as_mut()
                .filter(|a| Arc::ptr_eq(&a.cancelled, &self.cancelled))
        {
            active.busy = false;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn recording_and_submission_require_the_current_authenticated_account() {
        assert!(authorize(None, true, "alice").is_err());
        assert!(authorize(Some("alice"), false, "alice").is_err());
        assert!(authorize(Some("bob"), true, "alice").is_err());
        assert!(authorize(Some("alice"), true, "alice").is_ok());
    }
    #[test]
    fn cancelled_and_replaced_jobs_cannot_apply_late_results() {
        let jobs = Requests::default();
        jobs.cancel("early");
        assert!(jobs.reserve("early").is_err());
        let old = jobs.reserve("first").unwrap();
        assert!(jobs.reserve("second").is_err());
        jobs.cancel_all();
        assert!(old.cancelled.load(Ordering::Acquire));
        drop(old);
        let fresh = jobs.reserve("second").unwrap();
        jobs.cancel("first");
        assert!(!fresh.cancelled.load(Ordering::Acquire));
        let flag = fresh.cancelled.clone();
        drop(fresh);
        let _next = jobs.reserve("third").unwrap();
        assert!(flag.load(Ordering::Acquire));
    }
}
