import { afterEach, describe, expect, it } from "vitest";
import { cappedFps, frameDue, setFrameCap } from "./frame-cap";

afterEach(() => setFrameCap(0));

describe("frame rate cap", () => {
  it("lets every frame through when off", () => {
    expect(frameDue(0, 1)).toBe(true);
    expect(cappedFps(30)).toBe(30);
  });

  it("skips frames that come sooner than the cap allows", () => {
    setFrameCap(30);
    expect(frameDue(0, 16.7)).toBe(false);
    expect(frameDue(0, 33)).toBe(true);
    expect(cappedFps(60)).toBe(30);
    expect(cappedFps(12)).toBe(12);
  });

  it("keeps a 60 fps cap at 60 on a 60 Hz display", () => {
    setFrameCap(60);
    expect(frameDue(0, 16.2)).toBe(true);
  });

  it("holds the cap between 15 and 240", () => {
    setFrameCap(5);
    expect(cappedFps(60)).toBe(15);
    setFrameCap(1000);
    expect(cappedFps(500)).toBe(240);
  });
});
