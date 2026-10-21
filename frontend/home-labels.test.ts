import { expect, it } from "vitest";
import { kindLabel } from "./HomePage";

it("labels items the way Spotify does", () => {
  expect(kindLabel("artist")).toBe("Artist");
  expect(kindLabel("album")).toBe("Album");
  expect(kindLabel("playlist")).toBe("Playlist");
  expect(kindLabel("track")).toBe("Song");
});
