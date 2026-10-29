import { describe, expect, it } from "vitest";
import { isJamLink } from "./jam-link";

describe("isJamLink", () => {
  it("accepts Jam links from Spotify and SpotiFlex", () => {
    for (const link of [
      "https://spotify.link/IdREaHOTC7b",
      " spotify.link/IdREaHOTC7b ",
      "https://open.spotify.com/socialsession/0AMT6YW2zwhkPgQz7iBlJ2",
      "https://open.spotify.com/socialsession/0AMT6YW2zwhkPgQz7iBlJ2?si=abc",
      "https://open.spotify.com/intl-de/socialsession/0AMT6YW2zwhkPgQz7iBlJ2",
      "spotify:socialsession:0AMT6YW2zwhkPgQz7iBlJ2",
    ])
      expect(isJamLink(link), link).toBe(true);
  });
  it("leaves other links and text to paste normally", () => {
    for (const text of [
      "https://open.spotify.com/track/0AMT6YW2zwhkPgQz7iBlJ2",
      "https://evil.example/socialsession/abc",
      "join my jam spotify.link/IdREaHOTC7b",
      "hello",
    ])
      expect(isJamLink(text), text).toBe(false);
  });
});
