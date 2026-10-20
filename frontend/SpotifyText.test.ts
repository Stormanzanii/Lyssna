import { expect, it } from "vitest";
import { spotifyTextRoute } from "./SpotifyText";

it("routes supported Spotify pages while rejecting hostile and unsupported destinations", () => {
  const id = "0123456789abcdefghijkl";
  expect(spotifyTextRoute(`spotify:playlist:${id}`)).toBe(`playlist:${id}`);
  expect(
    spotifyTextRoute(`https://open.spotify.com/intl-en/album/${id}?si=share`),
  ).toBe(`album:${id}`);
  expect(spotifyTextRoute(`https://open.spotify.com/artist/${id}`)).toBe(
    `artist:${id}`,
  );
  for (const href of [
    "javascript:alert(1)",
    "data:text/html,test",
    `http://open.spotify.com/playlist/${id}`,
    `https://open.spotify.com.evil.test/playlist/${id}`,
    `https://attacker@open.spotify.com/playlist/${id}`,
    `https://open.spotify.com:444/playlist/${id}`,
    "spotify:playlist:../../bad",
    `spotify:track:${id}`,
  ]) {
    expect(spotifyTextRoute(href)).toBeUndefined();
  }
});
