//! Lyssna: DJ speaks each of its lines once. Going back to a song DJ
//! introduced plays the song without the introduction again.

use std::collections::{BTreeMap, HashMap, HashSet};

type Narration = HashMap<String, String>;

#[derive(Default)]
pub(crate) struct Narrated(HashSet<String>);

/// Names a track's narration: the track and exactly what DJ says, so the
/// same song introduced anew in a later set still speaks.
fn key(uri: &str, narration: &Narration) -> String {
    let lines: BTreeMap<_, _> = narration.iter().collect();
    format!("{uri}\n{lines:?}")
}

impl Narrated {
    /// The narration, unless DJ already spoke it.
    pub fn unheard(&self, uri: &str, narration: Option<Narration>) -> Option<Narration> {
        narration.filter(|narration| !self.0.contains(&key(uri, narration)))
    }

    /// Marks narration as spoken now that its track plays.
    pub fn spoken(&mut self, uri: &str, narration: Option<&Narration>) {
        let Some(narration) = narration else { return };
        if self.0.len() > 500 {
            self.0.clear();
        }
        self.0.insert(key(uri, narration));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn going_back_to_an_introduced_song_skips_the_introduction() {
        let mut narrated = Narrated::default();
        let intro: Narration = [("intro".to_owned(), "Up next".to_owned())].into();
        let first = narrated.unheard("spotify:track:a", Some(intro.clone()));
        assert!(first.is_some());
        narrated.spoken("spotify:track:a", first.as_ref());
        assert_eq!(
            narrated.unheard("spotify:track:a", Some(intro.clone())),
            None
        );
        // A new introduction for the same song still speaks.
        let later: Narration = [("intro".to_owned(), "Back to".to_owned())].into();
        assert!(narrated.unheard("spotify:track:a", Some(later)).is_some());
        assert!(narrated.unheard("spotify:track:b", Some(intro)).is_some());
    }
}
