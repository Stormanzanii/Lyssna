import { expect, it } from "vitest";
import { rememberSearch } from "./recent-searches";
import type { SearchEntry } from "./search-results";

const entry = (uri: string): SearchEntry => ({
  uri,
  route: uri.replace("spotify:", ""),
  name: uri,
  subtitle: "",
  kind: "Artist",
  images: [
    { url: "https://i.scdn.co/image/a" },
    { url: "https://i.scdn.co/image/b" },
  ],
});

it("keeps recent searches newest first without duplicates", () => {
  let list = rememberSearch([], entry("spotify:artist:a"));
  list = rememberSearch(list, entry("spotify:artist:b"));
  list = rememberSearch(list, entry("spotify:artist:a"));
  expect(list.map((item) => item.uri)).toEqual([
    "spotify:artist:a",
    "spotify:artist:b",
  ]);
  expect(list[0].images).toHaveLength(1);
});

it("caps recent searches at twenty", () => {
  let list = rememberSearch([], entry("spotify:artist:0"));
  for (let index = 1; index < 30; index++)
    list = rememberSearch(list, entry(`spotify:artist:${index}`));
  expect(list).toHaveLength(20);
  expect(list[0].uri).toBe("spotify:artist:29");
});
