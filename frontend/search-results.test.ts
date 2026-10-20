import { expect, it } from "vitest";
import { searchEntries } from "./search-results";
import { emptyState } from "./state";

it("preserves Spotify's mixed ranking, skips unavailable hits and deduplicates entities", () => {
  const state = {
    ...emptyState,
    tracks: [
      {
        id: "song",
        uri: "spotify:track:song",
        name: "Song",
        album: { name: "Album", images: [] },
        artists: [],
        duration_ms: 1000,
        is_local: false,
      },
    ],
    search_artists: [
      { id: "artist", uri: "spotify:artist:artist", name: "Artist" },
    ],
    search_playlists: [
      {
        id: "playlist",
        name: "Playlist",
        owner: { id: "creator" },
        collaborative: false,
        images: [],
      },
    ],
    search_top_results: [
      "spotify:artist:artist",
      "spotify:track:unavailable",
      "spotify:playlist:playlist",
      "spotify:artist:artist",
    ],
  };
  const entries = searchEntries(state);
  expect(entries.map((entry) => entry.kind)).toEqual([
    "Artist",
    "Playlist",
    "Song",
  ]);
  expect(entries[1].subtitle).toBe("By creator");
  expect(entries[2].track).toBe(state.tracks[0]);
});
