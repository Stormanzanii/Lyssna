import { describe, it, expect } from "vitest";
import { addedLabel, collectionTracks, nextHeaderSort } from "./collection";
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

describe("date added", () => {
  const now = Date.parse("2026-10-21T00:00:00Z");
  it("reads like Spotify: relative under four weeks, then the date", () => {
    expect(addedLabel("2026-10-20T23:59:30Z", now)).toBe("30 seconds ago");
    expect(addedLabel("2026-10-20T23:00:00Z", now)).toBe("1 hour ago");
    expect(addedLabel("2026-10-18T00:00:00Z", now)).toBe("3 days ago");
    expect(addedLabel("2026-10-07T00:00:00Z", now)).toBe("2 weeks ago");
    expect(addedLabel("2024-03-13T00:00:00Z", now)).toMatch(/2024/);
    expect(addedLabel(undefined, now)).toBe("");
  });
  it("sorts by date added both ways", () => {
    const order = (sort: string) =>
      collectionTracks(tracks, {}, { ...filters, sort }).map(
        (track) => track.uri,
      );
    expect(order("recent")).toEqual(["a", "b", "c"]);
    expect(order("added_oldest")).toEqual(["b", "a", "c"]);
  });
  it("sorts by title and album both ways, ignoring case", () => {
    const order = (sort: string) =>
      collectionTracks(tracks, {}, { ...filters, sort }).map(
        (track) => track.uri,
      );
    expect(order("title_asc")).toEqual(["a", "c", "b"]);
    expect(order("title_desc")).toEqual(["b", "c", "a"]);
    // Ties keep playlist order.
    expect(order("album_asc")).toEqual(["a", "b", "c"]);
    expect(order("album_desc")).toEqual(["b", "c", "a"]);
  });
  it("cycles header sorts like Spotify: ascending, descending, then off", () => {
    expect(nextHeaderSort("title", "order")).toBe("title_asc");
    expect(nextHeaderSort("title", "title_asc")).toBe("title_desc");
    expect(nextHeaderSort("title", "title_desc")).toBe("order");
    expect(nextHeaderSort("album", "title_desc")).toBe("album_asc");
    expect(nextHeaderSort("added", "order")).toBe("added_oldest");
    expect(nextHeaderSort("added", "added_oldest")).toBe("recent");
    expect(nextHeaderSort("added", "recent")).toBe("order");
  });
});
