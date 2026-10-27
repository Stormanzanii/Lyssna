import { expect, it } from "vitest";
import {
  albumMatches,
  albumTypeLabel,
  discographyReleases,
} from "./album-type";
import type { Album } from "./types";

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

it("lists Spotify's discography shelves, latest release first", () => {
  const album = (name: string, album_type = "album") =>
    ({ uri: `spotify:album:${name}`, name, album_type }) as Album;
  const discography = {
    latest: album("new", "single"),
    popular: [album("hit"), album("new", "single")],
    albums: [album("lp")],
    singles: [album("ep", "ep")],
    compilations: [],
  };
  const names = (filter: string) =>
    discographyReleases(
      [album("api"), album("api-single", "single")],
      discography,
      filter,
    ).map((item) => item.name);
  expect(names("all")).toEqual(["new", "hit"]);
  expect(names("album")).toEqual(["lp"]);
  expect(names("single")).toEqual(["ep"]);
  // No shelf: the Web API's releases, filtered by type.
  expect(names("compilation")).toEqual([]);
  expect(
    discographyReleases(
      [album("api"), album("api-single", "single")],
      undefined,
      "single",
    ).map((item) => item.name),
  ).toEqual(["api-single"]);
});
