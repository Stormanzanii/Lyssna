//! Play order for downloaded songs while Spotify cannot be reached, kept
//! the way Spotify's own offline mode does: the list, songs queued by hand,
//! shuffle and repeat.

use std::collections::VecDeque;

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum Repeat {
    #[default]
    Off,
    List,
    Song,
}

impl Repeat {
    pub fn parse(value: &str) -> Self {
        match value {
            "context" => Self::List,
            "track" => Self::Song,
            _ => Self::Off,
        }
    }

    pub fn name(self) -> &'static str {
        match self {
            Self::Off => "off",
            Self::List => "context",
            Self::Song => "track",
        }
    }
}

#[derive(Default)]
pub struct OfflineQueue {
    list: Vec<String>,
    order: Vec<usize>,
    at: usize,
    queued: VecDeque<String>,
    current: Option<String>,
    pub shuffle: bool,
    pub repeat: Repeat,
    seed: u64,
}

impl OfflineQueue {
    pub fn new(shuffle: bool, repeat: Repeat, seed: u64) -> Self {
        Self {
            shuffle,
            repeat,
            seed: seed | 1,
            ..Self::default()
        }
    }

    pub fn current(&self) -> Option<&str> {
        self.current.as_deref()
    }

    /// Starts `list` at `start`; returns the song to play.
    pub fn start(&mut self, list: Vec<String>, start: usize) -> Option<String> {
        let start = start.min(list.len().checked_sub(1)?);
        self.list = list;
        self.order = (0..self.list.len()).collect();
        self.at = start;
        if self.shuffle {
            self.mix();
        }
        self.current = self.list.get(self.order[self.at]).cloned();
        self.current.clone()
    }

    fn random(&mut self) -> u64 {
        self.seed ^= self.seed << 13;
        self.seed ^= self.seed >> 7;
        self.seed ^= self.seed << 17;
        self.seed
    }

    /// Shuffles what comes after the current song, keeping it where it is.
    fn mix(&mut self) {
        let first = self.order[self.at];
        self.order.retain(|index| *index != first);
        for index in (1..self.order.len()).rev() {
            let other = (self.random() % (index as u64 + 1)) as usize;
            self.order.swap(index, other);
        }
        self.order.insert(0, first);
        self.at = 0;
    }

    pub fn set_shuffle(&mut self, shuffle: bool) {
        self.shuffle = shuffle;
        if self.list.is_empty() {
            return;
        }
        if shuffle {
            self.mix();
        } else {
            self.at = self.order[self.at];
            self.order = (0..self.list.len()).collect();
        }
    }

    pub fn enqueue(&mut self, uri: String) {
        self.queued.push_back(uri);
    }

    pub fn remove_queued(&mut self, uri: &str) {
        self.queued.retain(|queued| queued != uri);
    }

    pub fn clear_queued(&mut self) {
        self.queued.clear();
    }

    /// The song after this one; `pressed` is a Next press, which leaves a
    /// repeated song as Spotify does.
    pub fn next(&mut self, pressed: bool) -> Option<String> {
        if self.repeat == Repeat::Song && !pressed && self.current.is_some() {
            return self.current.clone();
        }
        if let Some(queued) = self.queued.pop_front() {
            self.current = Some(queued);
            return self.current.clone();
        }
        if self.list.is_empty() {
            return None;
        }
        if self.at + 1 < self.order.len() {
            self.at += 1;
        } else if self.repeat != Repeat::Off {
            self.at = 0;
        } else {
            return None;
        }
        self.current = self.list.get(self.order[self.at]).cloned();
        self.current.clone()
    }

    pub fn previous(&mut self) -> Option<String> {
        if self.list.is_empty() {
            return self.current.clone();
        }
        if self.at > 0 {
            self.at -= 1;
        } else if self.repeat != Repeat::Off {
            self.at = self.order.len() - 1;
        }
        self.current = self.list.get(self.order[self.at]).cloned();
        self.current.clone()
    }

    pub fn skip_to(&mut self, uri: &str) -> Option<String> {
        if let Some(index) = self.queued.iter().position(|queued| queued == uri) {
            self.queued.drain(..=index);
            self.current = Some(uri.to_owned());
            return self.current.clone();
        }
        let ahead = self.order[self.at.min(self.order.len().saturating_sub(1))..]
            .iter()
            .position(|index| self.list[*index] == uri)?;
        self.at += ahead;
        self.current = Some(uri.to_owned());
        self.current.clone()
    }

    /// Songs still to come, queued ones first.
    pub fn upcoming(&self) -> Vec<String> {
        self.queued
            .iter()
            .cloned()
            .chain(
                self.order
                    .iter()
                    .skip(self.at + 1)
                    .map(|index| self.list[*index].clone()),
            )
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn songs(count: usize) -> Vec<String> {
        (0..count).map(|index| format!("s{index}")).collect()
    }

    #[test]
    fn plays_through_the_list_and_stops_at_its_end() {
        let mut queue = OfflineQueue::new(false, Repeat::Off, 7);
        assert_eq!(queue.start(songs(3), 1).as_deref(), Some("s1"));
        assert_eq!(queue.next(false).as_deref(), Some("s2"));
        assert_eq!(queue.next(false), None);
        assert_eq!(queue.previous().as_deref(), Some("s1"));
    }

    #[test]
    fn repeat_list_wraps_and_repeat_song_holds_until_next_is_pressed() {
        let mut queue = OfflineQueue::new(false, Repeat::List, 7);
        queue.start(songs(2), 1);
        assert_eq!(queue.next(false).as_deref(), Some("s0"));
        queue.repeat = Repeat::Song;
        assert_eq!(queue.next(false).as_deref(), Some("s0"));
        assert_eq!(queue.next(true).as_deref(), Some("s1"));
    }

    #[test]
    fn queued_songs_come_first_then_the_list_carries_on() {
        let mut queue = OfflineQueue::new(false, Repeat::Off, 7);
        queue.start(songs(3), 0);
        queue.enqueue("q".into());
        assert_eq!(queue.upcoming(), ["q", "s1", "s2"]);
        assert_eq!(queue.next(true).as_deref(), Some("q"));
        assert_eq!(queue.next(true).as_deref(), Some("s1"));
    }

    #[test]
    fn shuffle_keeps_the_chosen_song_and_plays_every_other_once() {
        let mut queue = OfflineQueue::new(true, Repeat::Off, 99);
        assert_eq!(queue.start(songs(6), 4).as_deref(), Some("s4"));
        let mut heard = vec!["s4".to_owned()];
        while let Some(song) = queue.next(false) {
            heard.push(song);
        }
        heard.sort();
        assert_eq!(heard, songs(6));
    }

    #[test]
    fn turning_shuffle_off_returns_to_list_order_from_the_current_song() {
        let mut queue = OfflineQueue::new(true, Repeat::Off, 3);
        queue.start(songs(5), 2);
        queue.set_shuffle(false);
        assert_eq!(queue.next(false).as_deref(), Some("s3"));
    }

    #[test]
    fn skipping_ahead_drops_the_songs_in_between() {
        let mut queue = OfflineQueue::new(false, Repeat::Off, 3);
        queue.start(songs(5), 0);
        assert_eq!(queue.skip_to("s3").as_deref(), Some("s3"));
        assert_eq!(queue.next(false).as_deref(), Some("s4"));
    }
}
