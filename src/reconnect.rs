use std::time::Duration;

#[derive(Default)]
pub(crate) struct ReconnectBackoff {
    attempts: u32,
}
impl ReconnectBackoff {
    pub fn next(&mut self, previous_lifetime: Duration) -> Duration {
        if previous_lifetime >= Duration::from_secs(90) {
            self.attempts = 0;
        }
        let delay = Duration::from_secs((1u64 << self.attempts.min(5)).min(30));
        self.attempts = self.attempts.saturating_add(1);
        delay
    }
}

pub(crate) async fn wait(
    delay: Duration,
    stopped: &mut tokio::sync::oneshot::Receiver<()>,
) -> bool {
    tokio::select! {
        _ = stopped => false,
        _ = tokio::time::sleep(delay) => true,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn repeated_failures_back_off_and_a_stable_session_resets_them() {
        let mut retry = ReconnectBackoff::default();
        let delays: Vec<_> = (0..9)
            .map(|_| retry.next(Duration::ZERO).as_secs())
            .collect();
        assert_eq!(delays, [1, 2, 4, 8, 16, 30, 30, 30, 30]);
        assert_eq!(retry.next(Duration::from_secs(90)), Duration::from_secs(1));
    }
    #[tokio::test]
    async fn shutdown_cancels_reconnect_without_waiting_for_the_backoff() {
        let (stop, mut stopped) = tokio::sync::oneshot::channel();
        stop.send(()).unwrap();
        assert!(
            !tokio::time::timeout(
                Duration::from_millis(100),
                wait(Duration::from_secs(30), &mut stopped)
            )
            .await
            .unwrap()
        );
    }
}
