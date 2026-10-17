import { describe, it, expect } from "vitest";
import {
  reducer,
  emptyState,
  activeLines,
  progress,
  position,
  nextToggle,
  sessionScreen,
  type ToggleIntent,
} from "./state";
import type { Track } from "./types";
import { PlaybackClock } from "./playback-clock";
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
  it("keeps first-run setup hidden until saved sign-in restoration finishes", () => {
    expect(sessionScreen(emptyState)).toBe("restoring");
    const restoring = reducer(emptyState, {
      type: "bootstrap",
      snapshot: { ...emptyState, login_pending: true },
    });
    expect(sessionScreen(restoring)).toBe("restoring");
    const failed = reducer(restoring, { type: "login_finished" });
    expect(sessionScreen(failed)).toBe("setup");
    expect(sessionScreen(reducer(failed, { type: "login_pending" }))).toBe(
      "setup",
    );
    const restored = reducer(restoring, {
      type: "session",
      profile: {
        id: "listener",
        display_name: "Listener",
        images: [],
      },
      can_follow: false,
    });
    expect(sessionScreen(restored)).toBe("client");
    expect(sessionScreen(reducer(restored, { type: "signed_out" }))).toBe(
      "setup",
    );
  });
  it("rebases a batched same-song native takeover to actual audio position", () => {
    const song = { ...track, duration_ms: 180000 };
    const before = {
      ...emptyState,
      playback: {
        ...emptyState.playback,
        item: song,
        progress_ms: 77000,
        is_playing: true,
      },
    };
    const clock = new PlaybackClock();
    clock.observe(before.playback, 0, before.clock_revision, 0, 0);
    let state = reducer(before, {
      type: "playback",
      playback: { ...before.playback, is_playing: false },
      observed_at: 100,
      loading: true,
    } as any);
    state = reducer(state, {
      type: "native_position",
      uri: song.uri,
      position_ms: 1200,
      playing: true,
      seeked: false,
      observed_at: 100,
    });
    clock.observe(state.playback, 100, state.clock_revision, 100, 100);
    expect(clock.read(100)).toBe(1200);
  });
  it("opens a warmed Canvas immediately when its track is clicked", () => {
    const warm = reducer(emptyState, {
      type: "canvas_prefetch",
      uri: track.uri,
      url: "https://canvaz.scdn.co/test.mp4",
    });
    expect(reducer(warm, { type: "play_requested", track }).canvas_url).toBe(
      "https://canvaz.scdn.co/test.mp4",
    );
  });
  it("retains a warm banner during basic refresh and clears prefetch after sign-out", () => {
    const info = {
      key: "artist:test",
      title: "Artist",
      subtitle: "",
      images: [],
      albums: [],
      overview: { header_image: "https://i.scdn.co/banner" },
    } as any;
    let state = reducer(
      { ...emptyState, profile: { id: "account" } },
      { type: "info_prefetch", info },
    );
    state = reducer(state, { type: "navigate", key: info.key, generation: 1 });
    state = reducer(state, {
      type: "browse_info",
      generation: 1,
      info: { ...info, overview: undefined },
    });
    expect(state.browse_info?.overview?.header_image).toBe(
      "https://i.scdn.co/banner",
    );
    state = reducer(state, { type: "signed_out" });
    expect(
      reducer(state, {
        type: "page_prefetch",
        key: "liked",
        tracks: [track],
        more: false,
      }).pages,
    ).toEqual({});
  });
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
describe("personalized Home ownership", () => {
  it("keeps generated playlist metadata through navigation and incomplete responses", () => {
    const item = {
      uri: "spotify:playlist:1123456789abcdefghijkl",
      route: "playlist:1123456789abcdefghijkl",
      name: "Daily Mix 1",
      subtitle: "Your favorite artists",
      images: [{ url: "https://artwork.example.test/mix" }],
      kind: "playlist",
      playable: true,
      format: "daily-mix",
    };
    let state = reducer(
      { ...emptyState, profile: { id: "account-a" } },
      {
        type: "home",
        page: {
          account: "account-a",
          greeting: "Hello",
          sections: [
            { uri: "mixes", title: "Mixes", subtitle: "", items: [item] },
          ],
        },
      },
    );
    state = reducer(state, {
      type: "navigate",
      key: item.route,
      generation: 1,
    });
    expect(state.browse_info?.title).toBe(item.name);
    state = reducer(state, {
      type: "browse_info",
      generation: 1,
      info: {
        key: item.route,
        title: "",
        subtitle: "",
        images: [],
        albums: [],
      },
    });
    expect(state.browse_info?.title).toBe(item.name);
    expect(state.browse_info?.images).toEqual(item.images);
    const native = {
      ...state.browse_info!,
      playlist: { owner: "spotify", total_tracks: 50, format: "daily-mix" },
    };
    state = reducer(state, {
      type: "browse_info",
      generation: 1,
      info: native,
    });
    state = reducer(state, { type: "navigate", key: "home", generation: 2 });
    state = reducer(state, {
      type: "navigate",
      key: item.route,
      generation: 3,
    });
    expect(state.browse_info?.playlist?.total_tracks).toBe(50);
  });
  it("rejects another account's feed and clears shelves when account changes", () => {
    const current = { ...emptyState, profile: { id: "account-a" } };
    const page = { account: "account-a", greeting: "Hello", sections: [] };
    const loaded = reducer(current, { type: "home", page });
    expect(loaded.home).toBe(page);
    expect(
      reducer(current, {
        type: "home",
        page: { ...page, account: "account-b" },
      }),
    ).toBe(current);
    const changed = reducer(loaded, {
      type: "session",
      profile: { id: "account-b" },
      can_follow: false,
    });
    expect(changed.home).toBeUndefined();
    expect(reducer(changed, { type: "home", page })).toBe(changed);
    expect(
      reducer(changed, {
        type: "home_error",
        account: "account-a",
        message: "old",
      }),
    ).toBe(changed);
  });
  it("drops mismatched shelves during session restore", () => {
    const restored = reducer(emptyState, {
      type: "bootstrap",
      snapshot: {
        ...emptyState,
        profile: { id: "account-b" },
        home: { account: "account-a", greeting: "Hello", sections: [] },
      },
    });
    expect(restored.home).toBeUndefined();
  });
});
