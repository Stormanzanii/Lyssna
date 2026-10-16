import { it, expect } from "vitest";
import { collectionTracks } from "./collection";
import type { Track } from "./types";
const tracks = [
  {
    uri: "a",
    name: "One",
    artists: [{ name: "Artist", genres: ["rock"] }],
    album: { name: "Album", images: [], release_date: "2020-01-01" },
    added_at: "2026-01-01",
  },
  {
    uri: "b",
    name: "Two",
    artists: [{ name: "Singer" }],
    album: { name: "Other", images: [], release_date: "2010-01-01" },
    added_at: "2025-01-01",
  },
  {
    uri: "c",
    name: "Three",
    artists: [],
    album: { name: "Other", images: [] },
  },
].map((track) => ({
  ...track,
  duration_ms: 180000,
  is_local: false,
})) satisfies Track[];
const filters = { query: "", genre: "", age: "", sort: "order" };
it("filters by song, artist, genre and release age without changing the playlist", () => {
  expect(collectionTracks(tracks, {}, { ...filters, query: "Singer" })).toEqual(
    [tracks[1]],
  );
  expect(collectionTracks(tracks, {}, { ...filters, genre: "rock" })).toEqual([
    tracks[0],
  ]);
  expect(
    collectionTracks(
      tracks,
      {},
      { ...filters, age: "older" },
      Date.parse("2026-10-17"),
    ),
  ).toEqual([tracks[1]]);
  expect(tracks.map((track) => track.uri)).toEqual(["a", "b", "c"]);
});
it("orders real plays before unknown values and sorts recent additions separately from release date", () => {
  expect(
    collectionTracks(
      tracks,
      {
        a: { plays: 5, genres: [], release_date: "" },
        b: { plays: 40, genres: [], release_date: "" },
      },
      { ...filters, sort: "popular" },
    ).map((track) => track.uri),
  ).toEqual(["b", "a", "c"]);
  expect(
    collectionTracks(tracks, {}, { ...filters, sort: "recent" })[0].uri,
  ).toBe("a");
  expect(
    collectionTracks(tracks, {}, { ...filters, sort: "oldest" })[0].uri,
  ).toBe("b");
});
