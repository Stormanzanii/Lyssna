//! Keep ordered state uploads out of the local transport command loop.
use crate::core::Error;
use std::{future::Future, pin::Pin};

type Update = Pin<Box<dyn Future<Output = Result<(), Error>> + Send>>;

#[derive(Default)]
pub(crate) struct StateUpdates {
    active: Option<Update>,
    latest: Option<Update>,
}

impl StateUpdates {
    pub fn push(&mut self, update: impl Future<Output = Result<(), Error>> + Send + 'static) {
        let update = Box::pin(update);
        if self.active.is_none() {
            self.active = Some(update);
        } else {
            self.latest = Some(update);
        }
    }

    pub async fn next(&mut self) -> Result<(), Error> {
        let result = match self.active.as_mut() {
            Some(update) => update.await,
            None => std::future::pending().await,
        };
        self.active = self.latest.take();
        result
    }

    pub async fn flush(&mut self) -> Result<(), Error> {
        while self.active.is_some() {
            self.next().await?;
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use futures_util::FutureExt;
    use std::sync::{Arc, Mutex};
    use tokio::sync::{mpsc, oneshot};

    #[tokio::test]
    async fn blocked_upload_leaves_commands_ready_and_coalesces_later_states() {
        let mut updates = StateUpdates::default();
        let (finish, blocked) = oneshot::channel();
        let sent = Arc::new(Mutex::new(Vec::new()));
        let first = sent.clone();
        updates.push(async move {
            first.lock().unwrap().push(1);
            blocked.await.unwrap();
            Ok(())
        });
        for value in [2, 3] {
            let sent = sent.clone();
            updates.push(async move {
                sent.lock().unwrap().push(value);
                Ok(())
            });
        }
        assert!(updates.next().now_or_never().is_none());
        let (sender, mut commands) = mpsc::unbounded_channel();
        sender.send("next track").unwrap();
        tokio::select! {
            command = commands.recv() => assert_eq!(command, Some("next track")),
            _ = updates.next() => panic!("Upload must remain pending during local commands"),
        }
        assert_eq!(*sent.lock().unwrap(), vec![1]);
        finish.send(()).unwrap();
        updates.flush().await.unwrap();
        assert_eq!(*sent.lock().unwrap(), vec![1, 3]);
        assert!(updates.next().now_or_never().is_none());
    }

    #[tokio::test]
    async fn failed_upload_does_not_discard_the_latest_state() {
        let mut updates = StateUpdates::default();
        updates.push(async { Err(Error::unavailable("test upload failed")) });
        updates.push(async { Ok(()) });
        assert!(updates.next().await.is_err());
        updates.next().await.unwrap();
        assert!(updates.next().now_or_never().is_none());
    }
}
