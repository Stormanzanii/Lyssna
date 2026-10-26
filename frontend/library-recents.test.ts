import { describe, expect, it } from "vitest";
import { byRecents, entryRecency, playlistRecency } from "./library-recents";
import type { Playlist } from "./types";

const playlist = (id: string, added_at = 0): Playlist => ({
  id,
  name: id,
  images: [],
  owner: { id: "me" },
  collaborative: false,
  added_at,
});

describe("Recents order", () => {
  it("uses the later of last played and added", () => {
    const recency = { "spotify:playlist:a": 500 };
    expect(playlistRecency(playlist("a", 100), recency)).toBe(500);
    expect(playlistRecency(playlist("b", 100), recency)).toBe(100);
  });

  it("dates a folder by its most recent playlist", () => {
    const folder = {
      kind: "folder" as const,
      folder: { id: "f", name: "Folder" },
      count: 2,
      entries: [
        { kind: "playlist" as const, playlist: playlist("a", 10) },
        { kind: "playlist" as const, playlist: playlist("b", 40) },
      ],
    };
    expect(entryRecency(folder, {})).toBe(40);
  });

  it("mixes kinds newest first, keeping pins on top and ties in place", () => {
    const rows = [
      { name: "pinned", time: 1, pin: true },
      { name: "old playlist", time: 10, pin: false },
      { name: "artist", time: 30, pin: false },
      { name: "album", time: 20, pin: false },
      { name: "unknown a", time: 0, pin: false },
      { name: "unknown b", time: 0, pin: false },
    ];
    expect(
      byRecents(
        rows,
        (row) => row.time,
        (row) => row.pin,
      ).map((row) => row.name),
    ).toEqual([
      "pinned",
      "artist",
      "album",
      "old playlist",
      "unknown a",
      "unknown b",
    ]);
  });
});
