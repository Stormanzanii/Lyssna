import { describe, it, expect } from "vitest";
import {
  reducer,
  emptyState,
  activeLines,
  progress,
  position,
  nextToggle,
  type ToggleIntent,
} from "./state";
import type { Track } from "./types";
const track: Track = {
  id: "song",
  uri: "spotify:track:song",
  name: "Song",
  artists: [],
  album: { name: "Album", images: [] },
  duration_ms: 10000,
  is_local: false,
};
describe("asynchronous playback and browsing", () => {
  it("alternates rapid play and pause before native acknowledgments arrive", () => {
    let previous: ToggleIntent | undefined;
    const choices = [];
    for (let n = 0; n < 6; n++) {
      previous = nextToggle(true, previous, n * 10);
      choices.push(previous.wanted);
    }
    expect(choices).toEqual([false, true, false, true, false, true]);
    expect(nextToggle(false, previous, 3000).wanted).toBe(true);
  });
  it("moves active focus to the next lead while the previous backing vocals continue", () => {
    const lines = [
      {
        start_ms: 1000,
        end_ms: 8000,
        words: [{ start_ms: 1000, end_ms: 2000, text: "Lead" }],
      },
      { start_ms: 1500, end_ms: 6000, words: [] },
      {
        start_ms: 3000,
        end_ms: 5000,
        words: [{ start_ms: 3000, end_ms: 5000, text: "Next" }],
      },
    ];
    expect(activeLines(lines, 3500)).toEqual([1, 2]);
  });
  it("preserves imported lyrics when an earlier provider request fails", () => {
    const lyrics = {
      lines: [],
      source: "Local TTML",
      synced: true,
      instrumental: false,
    };
    const state = {
      ...emptyState,
      playback: { ...emptyState.playback, item: track },
      lyrics,
    };
    expect(
      reducer(state, {
        type: "lyric_error",
        uri: track.uri,
        message: "Provider unavailable",
      }).lyrics,
    ).toBe(lyrics);
  });
  it("marks pagination busy before the response and rejects stale loading events", () => {
    const state = { ...emptyState, generation: 3, tracks: [track] };
    expect(
      reducer(state, { type: "page_loading", generation: 3 }).loading,
    ).toBe(true);
    expect(reducer(state, { type: "page_loading", generation: 2 })).toBe(state);
  });
  it("accepts native track changes after next while waiting on an earlier load", () => {
    const state = reducer(emptyState, { type: "play_requested", track });
    const next = { ...track, uri: "spotify:track:next" };
    const changed = reducer(state, {
      type: "playback",
      playback: { ...emptyState.playback, item: next },
      observed_at: Date.now(),
      changed: true,
      loading: true,
    });
    expect(changed.playback.item?.uri).toBe(next.uri);
    expect(changed.pending?.uri).toBe(next.uri);
  });
  it("discards search results from an older query", () => {
    const current = reducer(emptyState, {
      type: "navigate",
      key: "search:second",
      generation: 2,
    });
    expect(
      reducer(current, {
        type: "tracks",
        key: "search:first",
        generation: 1,
        offset: 0,
        tracks: [track],
        more: false,
      }),
    ).toBe(current);
  });
  it("updates pause immediately from the native event", () => {
    const current = {
      ...emptyState,
      playback: { ...emptyState.playback, item: track, is_playing: true },
    };
    const paused = reducer(current, {
      type: "native_position",
      uri: track.uri,
      position_ms: 1200,
      playing: false,
      observed_at: 100,
    });
    expect(paused.playback.is_playing).toBe(false);
    expect(position(paused.playback, 100, 1000)).toBe(1200);
  });
  it("ignores lyrics for a previous track", () => {
    const current = {
      ...emptyState,
      playback: { ...emptyState.playback, item: track },
    };
    expect(
      reducer(current, { type: "lyric_error", uri: "old", message: "missing" }),
    ).toBe(current);
  });
  it("does not replace a newly clicked song with stale Spotify state", () => {
    const current = reducer(emptyState, { type: "play_requested", track });
    expect(
      reducer(current, {
        type: "playback",
        playback: emptyState.playback,
        observed_at: Date.now(),
        changed: true,
      }),
    ).toBe(current);
  });
});
describe("lyric timing", () => {
  it("keeps overlapping lead and background lines active", () => {
    expect(
      activeLines(
        [
          { start_ms: 0, end_ms: 2000 },
          { start_ms: 500, end_ms: 1500 },
        ],
        1000,
      ),
    ).toEqual([0, 1]);
  });
  it("clamps word progress and handles malformed zero duration", () => {
    expect(progress(100, 200, 50)).toBe(0);
    expect(progress(100, 200, 300)).toBe(1);
    expect(progress(100, 100, 100)).toBe(0);
  });
});
