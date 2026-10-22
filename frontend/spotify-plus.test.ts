import { expect, it } from "vitest";
import {
  embedCode,
  inChosenFolders,
  songAndArtist,
  trackIds,
} from "./spotify-plus";
import type { Playlist, Track } from "./types";

const track = (id: string, name: string, artists: string[]): Track => ({
  id,
  uri: `spotify:track:${id}`,
  name,
  artists: artists.map((artist) => ({ name: artist })),
  album: { name: "Album", images: [] },
  duration_ms: 1000,
  is_local: false,
});

it("copies song and artist names and track IDs like Spotify+", () => {
  expect(songAndArtist(track("a", "Song", ["One", "Two"]))).toBe(
    "Song - One, Two",
  );
  expect(trackIds([track("a", "A", []), track("b", "B", [])])).toBe("a, b");
});

it("builds Spotify embed markup per kind", () => {
  expect(embedCode("track", "abc")).toContain(
    'src="https://open.spotify.com/embed/track/abc?utm_source=generator"',
  );
  expect(embedCode("track", "abc")).toContain('height="152"');
  expect(embedCode("album", "abc")).toContain('height="352"');
});

it("limits Add to playlist to playlists directly inside chosen folders", () => {
  const playlist = (id: string, folders: string[]): Playlist => ({
    id,
    name: id,
    images: [],
    owner: { id: "me" },
    collaborative: false,
    folders: folders.map((folder) => ({ id: folder, name: folder })),
  });
  const all = [
    playlist("root", []),
    playlist("mixes", ["music"]),
    playlist("nested", ["music", "old"]),
  ];
  expect(inChosenFolders(all, [])).toHaveLength(3);
  expect(inChosenFolders(all, ["music"]).map((item) => item.id)).toEqual([
    "mixes",
  ]);
  expect(
    inChosenFolders(all, ["music", "old"]).map((item) => item.id),
  ).toEqual(["mixes", "nested"]);
});
