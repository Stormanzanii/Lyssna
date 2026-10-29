import { describe, expect, it } from "vitest";
import { DJ_ID } from "./library-order";
import { contextName, playingRoute } from "./playing-context";
import type { Playlist, Track } from "./types";

describe("playingRoute", () => {
  it("maps playlists, including legacy user playlist URIs", () => {
    expect(playingRoute("spotify:playlist:37i9dQZF1DXcBWIGoYBM5M")).toBe(
      "playlist:37i9dQZF1DXcBWIGoYBM5M",
    );
    expect(playingRoute("spotify:user:someone:playlist:abc123")).toBe(
      "playlist:abc123",
    );
  });
  it("maps Liked Songs and the DJ", () => {
    expect(playingRoute("spotify:user:someone:collection")).toBe("liked");
    expect(playingRoute("spotify:playlist:abc", true)).toBe(
      `playlist:${DJ_ID}`,
    );
  });
  it("ignores albums, artists and missing contexts", () => {
    expect(playingRoute("spotify:album:abc")).toBeUndefined();
    expect(playingRoute("spotify:artist:abc")).toBeUndefined();
    expect(playingRoute(null)).toBeUndefined();
    expect(playingRoute("spotify:user:a:collection:artist:b")).toBeUndefined();
  });
});

describe("contextName", () => {
  const track = {
    album: { id: "al1", name: "Puppet" },
    artists: [{ id: "ar1", name: "John Michael Howell" }],
  } as unknown as Track;
  it("names Liked Songs, playlists, the DJ, albums and artists", () => {
    expect(contextName("spotify:user:me:collection")).toBe("Liked Songs");
    expect(
      contextName("spotify:playlist:abc", {
        playlists: [{ id: "abc", name: "Gaming" } as Playlist],
      }),
    ).toBe("Gaming");
    expect(contextName("spotify:playlist:abc", { dj: true })).toBe("DJ");
    expect(contextName("spotify:album:al1", { track })).toBe("Puppet");
    expect(contextName("spotify:artist:ar1", { track })).toBe(
      "John Michael Howell",
    );
  });
  it("is unknown for other albums and missing contexts", () => {
    expect(contextName("spotify:album:other", { track })).toBeUndefined();
    expect(contextName(null)).toBeUndefined();
  });
});
