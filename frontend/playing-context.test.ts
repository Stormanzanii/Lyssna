import { describe, expect, it } from "vitest";
import { DJ_ID } from "./library-order";
import { playingRoute } from "./playing-context";

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
