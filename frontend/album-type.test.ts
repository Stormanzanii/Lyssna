import { expect, it } from "vitest";
import { albumMatches, albumTypeLabel } from "./album-type";

it("shows release types like Spotify whatever their case", () => {
  expect(albumTypeLabel("SINGLE")).toBe("Single");
  expect(albumTypeLabel("album")).toBe("Album");
  expect(albumTypeLabel("EP")).toBe("EP");
  expect(albumTypeLabel("COMPILATION")).toBe("Compilation");
  expect(albumTypeLabel(undefined)).toBe("Album");
});
it("filters discography whatever the case", () => {
  expect(albumMatches("SINGLE", "single")).toBe(true);
  expect(albumMatches("EP", "single")).toBe(true);
  expect(albumMatches("ALBUM", "single")).toBe(false);
  expect(albumMatches("Compilation", "compilation")).toBe(true);
  expect(albumMatches("ALBUM", "all")).toBe(true);
});
