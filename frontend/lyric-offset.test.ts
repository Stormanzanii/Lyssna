import { expect, it } from "vitest";
import { lyricOffset } from "./lyric-offset";

it("adds a song's own offset to the one for all songs", () => {
  const settings = {
    lyric_offset_ms: 100,
    lyric_song_offsets: { "spotify:track:a": -250 },
  };
  expect(lyricOffset(settings, "spotify:track:a")).toBe(-150);
  expect(lyricOffset(settings, "spotify:track:b")).toBe(100);
  expect(lyricOffset(settings)).toBe(100);
  expect(lyricOffset({ lyric_offset_ms: 0 }, "spotify:track:a")).toBe(0);
});
