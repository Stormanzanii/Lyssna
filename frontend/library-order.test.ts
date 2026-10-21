import { it, expect } from "vitest";
import { emptyState, reducer } from "./state";
import {
  DJ_ID,
  emptyOrder,
  forgetPlaylist,
  libraryItems,
  recordManualPlay,
  togglePlaylistPin,
  playlistForManualPlay,
} from "./library-order";
const playlists = Array.from({ length: 5 }, (_, index) => ({
  id: String(index).padStart(22, "0"),
  name: `Playlist ${index}`,
  images: [],
  owner: { id: "user" },
  collaborative: false,
}));
it("keeps pinned order stable while explicit plays move only unpinned recents", () => {
  let order = emptyOrder();
  order = togglePlaylistPin(order, playlists[0]);
  order = togglePlaylistPin(order, playlists[1]);
  order = recordManualPlay(order, playlists[3]);
  order = recordManualPlay(order, playlists[0]);
  const state = {
    ...emptyState,
    profile: { id: "user" },
    playlists,
    settings: { ...emptyState.settings, library_order: { user: order } },
  };
  expect(
    libraryItems(state)
      .map((item) => item.id)
      .slice(0, 4),
  ).toEqual([playlists[0].id, playlists[1].id, playlists[3].id, DJ_ID]);
  const next = reducer(state, {
    type: "native_position",
    uri: "spotify:track:next",
    position_ms: 0,
    observed_at: Date.now(),
    playing: true,
  });
  expect(next.settings.library_order).toEqual(state.settings.library_order);
  expect(playlistForManualPlay(state, { command: "next" })).toBeUndefined();
  expect(playlistForManualPlay(state, { command: "play" })).toBeUndefined();
});
it("allows three playlist pins plus permanent Liked Songs and supports unpinning", () => {
  let order = emptyOrder();
  for (const item of playlists.slice(0, 3))
    order = togglePlaylistPin(order, item);
  expect(() => togglePlaylistPin(order, playlists[3])).toThrow(/Four pins/);
  order = togglePlaylistPin(order, playlists[1]);
  expect(togglePlaylistPin(order, playlists[3]).pinned).toHaveLength(3);
});
it("restores account-specific order and always includes DJ", () => {
  const order = recordManualPlay(emptyOrder(), playlists[2]);
  const settings = {
    ...emptyState.settings,
    library_order: { user: JSON.parse(JSON.stringify(order)) },
  };
  expect(
    libraryItems({
      ...emptyState,
      profile: { id: "user" },
      playlists,
      settings,
    })[0].id,
  ).toBe(playlists[2].id);
  expect(
    libraryItems({
      ...emptyState,
      profile: { id: "other" },
      playlists,
      settings,
    })[0].id,
  ).toBe(DJ_ID);
});

it("forgets a removed playlist everywhere in the sidebar order", () => {
  let order = recordManualPlay(emptyOrder(), playlists[0]);
  order = togglePlaylistPin(order, playlists[1]);
  order = recordManualPlay(order, playlists[1]);
  order = forgetPlaylist(order, playlists[1].id);
  expect(order.pinned).toEqual([]);
  expect(order.recent).toEqual([playlists[0].id]);
  expect(order.items.map((item) => item.id)).toEqual([playlists[0].id]);
});

it("never adds a played playlist that is not saved to Your Library", () => {
  const unsaved = {
    id: "9".repeat(22),
    name: "Someone else's mix",
    images: [],
    owner: { id: "31pcawp2njnx2z4fvij52gexample" },
    collaborative: false,
  };
  const order = recordManualPlay(
    recordManualPlay(emptyOrder(), playlists[1]),
    unsaved,
  );
  const state = {
    ...emptyState,
    profile: { id: "user" },
    playlists,
    settings: { ...emptyState.settings, library_order: { user: order } },
  };
  const ids = libraryItems(state).map((item) => item.id);
  expect(ids).not.toContain(unsaved.id);
  expect(ids[0]).toBe(playlists[1].id);
  // Saving it later lets the remembered play order it again.
  expect(
    libraryItems({ ...state, playlists: [...playlists, unsaved] })[0].id,
  ).toBe(unsaved.id);
});
