import { describe, expect, it } from "vitest";
import { headerColor } from "./artwork-color";

const pixels = (...colors: [number, number, number, number][]) =>
  new Uint8ClampedArray(
    colors.flatMap(([color, r, g, b]) =>
      Array.from({ length: color }, () => [r, g, b, 255]).flat(),
    ),
  );

describe("headerColor", () => {
  it("prefers the dominant vivid hue over neutral pixels", () => {
    const [r, g, b] = headerColor(
      pixels([60, 240, 240, 240], [40, 120, 60, 220], [10, 10, 10, 10]),
    );
    expect(b).toBeGreaterThan(r);
    expect(b).toBeGreaterThan(g);
  });

  it("darkens bright artwork so white text stays readable", () => {
    const rgb = headerColor(pixels([100, 255, 220, 40]));
    expect(Math.max(...rgb)).toBeLessThan(200);
  });

  it("falls back to grey without opaque pixels", () => {
    expect(headerColor(new Uint8ClampedArray([0, 0, 0, 0]))).toEqual([
      83, 83, 83,
    ]);
  });
});
