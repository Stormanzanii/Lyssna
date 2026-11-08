import { describe, expect, it } from "vitest";
import { simpleGoal } from "./lyric-animator";

describe("Simple lyrics mode", () => {
  it("fills from -50% to 100% without scale or glow", () => {
    expect(simpleGoal(1000, 2000, 500)).toEqual({
      scale: 1,
      lift: 0.01,
      glow: 0,
      gradient: -50,
    });
    const middle = simpleGoal(1000, 2000, 1500);
    expect(middle.gradient).toBeCloseTo(10);
    expect(middle.lift).toBeCloseTo(-0.0115);
    const sung = simpleGoal(1000, 2000, 2500);
    expect(sung.gradient).toBe(100);
    expect(sung.lift).toBeCloseTo(-0.033);
  });
});
