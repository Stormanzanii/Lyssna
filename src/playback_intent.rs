use std::time::{Duration, Instant};

/// Keep the latest user choice while one native transition is outstanding.
#[derive(Default)]
pub(crate) struct PlaybackIntent {
    target: Option<String>,
    desired: Option<bool>,
    waiting: Option<(bool, Instant)>,
}
impl PlaybackIntent {
    pub fn request(&mut self, playing: bool) {
        self.desired = Some(playing);
    }
    pub fn loading(&mut self, now: Instant) {
        self.target = None;
        self.desired = Some(true);
        self.waiting = Some((true, now));
    }
    pub fn loading_track(&mut self, uri: Option<String>, now: Instant) {
        self.loading(now);
        self.target = uri;
    }
    pub fn acknowledge_track(&mut self, uri: &str, playing: bool) {
        if self.target.as_deref().is_none_or(|target| target == uri) {
            self.acknowledge(playing);
        }
    }
    pub fn acknowledge(&mut self, playing: bool) {
        if self.waiting.is_some_and(|(wanted, _)| wanted == playing) {
            self.waiting = None;
            if self.desired == Some(playing) {
                self.desired = None;
                self.target = None;
            }
        }
    }
    pub fn next(&mut self, playing: bool, now: Instant) -> Option<bool> {
        let retry = self.waiting.is_some();
        if self
            .waiting
            .is_some_and(|(_, sent)| now.saturating_duration_since(sent) < Duration::from_secs(1))
        {
            return None;
        }
        self.waiting = None;
        let wanted = self.desired?;
        if !retry && wanted == playing {
            self.desired = None;
            return None;
        }
        self.waiting = Some((wanted, now));
        Some(wanted)
    }
    pub fn reset(&mut self) {
        *self = Self::default();
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn previous_song_cannot_acknowledge_a_new_load() {
        let now = Instant::now();
        let mut intent = PlaybackIntent::default();
        intent.loading_track(Some("new".into()), now);
        intent.acknowledge_track("old", true);
        assert_eq!(intent.next(true, now + Duration::from_secs(1)), Some(true));
        intent.acknowledge_track("new", true);
        assert_eq!(intent.next(true, now + Duration::from_secs(2)), None);
    }
    #[test]
    fn burst_keeps_only_the_latest_choice_after_the_current_ack() {
        let now = Instant::now();
        let mut intent = PlaybackIntent::default();
        intent.request(false);
        assert_eq!(intent.next(true, now), Some(false));
        for index in 0..100 {
            intent.request(index % 2 == 1);
            assert_eq!(intent.next(true, now), None);
        }
        intent.acknowledge(false);
        assert_eq!(intent.next(false, now), Some(true));
        intent.acknowledge(true);
        assert_eq!(intent.next(true, now), None);
    }
    #[test]
    fn pause_during_track_loading_waits_for_the_track_then_pauses() {
        let now = Instant::now();
        let mut intent = PlaybackIntent::default();
        intent.loading(now);
        intent.request(false);
        assert_eq!(intent.next(false, now), None);
        intent.acknowledge(true);
        assert_eq!(intent.next(true, now), Some(false));
    }
    #[test]
    fn late_command_is_followed_by_latest_intent_even_if_state_already_matches() {
        let now = Instant::now();
        let mut intent = PlaybackIntent::default();
        intent.request(false);
        assert_eq!(intent.next(true, now), Some(false));
        intent.request(true);
        assert_eq!(intent.next(true, now + Duration::from_secs(2)), Some(true));
    }
}
