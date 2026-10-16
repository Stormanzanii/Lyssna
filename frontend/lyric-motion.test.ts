import { expect, it } from "vitest";
import { stepScroll, wordMotion, vocalGap, letterMotion } from "./lyric-motion";
import type { Line } from "./types";

it("keeps scrolling stable through retargets and different display refresh rates", () => {
  const results = [30, 60, 144].map((rate) => {
    const spring = { position: 0, velocity: 0, target: 1000 };
    for (let frame = 0; frame < rate; frame++) stepScroll(spring, 1 / rate);
    spring.target = 1100;
    const before = spring.position;
    stepScroll(spring, 1 / rate);
    expect(spring.position).toBeGreaterThan(before);
    expect(spring.position).toBeLessThan(1100);
    return before;
  });
  expect(Math.max(...results) - Math.min(...results)).toBeLessThan(0.001);
});
it("eases word lift continuously into and out of held syllables", () => {
  expect(wordMotion(1000, 2000, 899)).toEqual({ lift: -0, scale: 1, glow: 0 });
  expect(wordMotion(1000, 2000, 1600).scale).toBeCloseTo(1.065);
  expect(wordMotion(1000, 2000, 2401).lift).toBeCloseTo(0);
});
it("shows waiting dots only in long gaps with no main or background vocals", () => {
  const line = (start_ms: number, end_ms: number, background = false) =>
    ({ start_ms, end_ms, background }) as Line;
  const lines = [line(1000, 3000), line(2000, 6000, true), line(10000, 12000)];
  expect(vocalGap(lines, 500)).toBeUndefined();
  expect(vocalGap(lines, 4000)).toBeUndefined();
  expect(vocalGap(lines, 6500)).toEqual({ start: 6000, end: 10000, after: 1 });
  expect(vocalGap(lines, 10000)).toBeUndefined();
});
it("staggers held-word letter bounce and settles every letter at its original size", () => {
  const first = letterMotion(1000, 4000, 1400, 0, 4);
  const last = letterMotion(1000, 4000, 1400, 3, 4);
  expect(first.lift).toBeLessThan(last.lift);
  expect(first.fill).toBeGreaterThan(last.fill);
  for (let index = 0; index < 4; index++)
    expect(letterMotion(1000, 4000, 5000, index, 4).scale).toBeCloseTo(1);
});
