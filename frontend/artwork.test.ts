import { expect, it } from "vitest";
import { artworkFor, isLocalCover } from "./artwork";

const id = "b11c3ab5cb818192b7a61fdd";
const album = [{ url: `https://i.scdn.co/image/ab67616d0000b273${id}` }];
it("picks the smallest Spotify album size that fills the cover", () => {
  expect(artworkFor(album, 60)).toBe(`https://i.scdn.co/image/ab67616d00004851${id}`);
  expect(artworkFor(album, 76)).toBe(`https://i.scdn.co/image/ab67616d00001e02${id}`);
  expect(artworkFor(album)).toBe(`https://i.scdn.co/image/ab67616d00001e02${id}`);
  expect(artworkFor(album, 500)).toBe(album[0].url);
  expect(artworkFor(album, 2000)).toBe(album[0].url);
});
it("knows mosaic, artist and playlist sizes", () => {
  expect(artworkFor([{ url: "https://mosaic.scdn.co/640/abc" }], 50)).toBe(
    "https://mosaic.scdn.co/60/abc",
  );
  expect(
    artworkFor([{ url: `https://i.scdn.co/image/ab6761610000e5eb${id}` }], 150),
  ).toBe(`https://i.scdn.co/image/ab6761610000f178${id}`);
  expect(
    artworkFor([{ url: `https://i.scdn.co/image/ab67706c0000da84${id}` }], 400),
  ).toBe(`https://i.scdn.co/image/ab67706c0000bebb${id}`);
});
it("uses listed widths, else the first secure image", () => {
  const listed = [
    { url: "https://image.example/large", width: 640 },
    { url: "https://image.example/small", width: 64 },
  ];
  expect(artworkFor(listed, 40)).toBe("https://image.example/small");
  expect(artworkFor(listed, 200)).toBe("https://image.example/large");
  expect(artworkFor([{ url: "data:x" }, { url: "https://image.example/one" }])).toBe(
    "https://image.example/one",
  );
  expect(artworkFor([])).toBeUndefined();
});
it("accepts Local Files covers served by Lyssna only", () => {
  const cover = `http://localcover.localhost/${"a".repeat(64)}.jpg`;
  expect(isLocalCover(cover)).toBe(true);
  expect(artworkFor([{ url: cover }])).toBe(cover);
  expect(isLocalCover("http://localcover.localhost/../index.json")).toBe(false);
  expect(isLocalCover("http://example.com/cover.jpg")).toBe(false);
});
