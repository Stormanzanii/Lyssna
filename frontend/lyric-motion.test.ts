import { expect, it } from "vitest";
import {
  stepScroll,
  syllableMotion,
  POP,
  vocalGap,
  vocalGaps,
  letterMotion,
} from "./lyric-motion";
import type { Line } from "./types";
it("puts interlude dots on the side of the upcoming singer", () => {
  const lines = [
    { start_ms: 0, end_ms: 1000, words: [] },
    { start_ms: 6000, end_ms: 7000, words: [], opposite: true },
    { start_ms: 12000, end_ms: 13000, words: [], opposite: false },
  ].map((line) => ({
    opposite: false,
    text: "Line",
    translation: "",
    romanization: "",
    background: false,
    ...line,
  })) satisfies Line[];
  expect(vocalGap(lines, 3000)?.opposite).toBe(true);
  expect(vocalGaps(lines)[0].opposite).toBe(true);
  expect(vocalGap(lines, 9000)?.opposite).toBe(false);
});
it("keeps countdown layout after every overlapping vocal in the preceding section", () => {
  const lines = [
    { start_ms: 5000, end_ms: 6000 },
    { start_ms: 5500, end_ms: 8000, background: true },
    { start_ms: 7000, end_ms: 7500 },
    { start_ms: 12000, end_ms: 13000 },
  ] as Line[];
  expect(vocalGaps(lines)).toEqual([
    { start: 0, end: 5000, after: -1 },
    { start: 8000, end: 12000, after: 2 },
  ]);
});

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
it("rests unsung syllables small and low, pops the sung one, then settles", () => {
  const unsung = syllableMotion(1000, 2000, -Infinity);
  expect(unsung).toMatchObject({ scale: POP.restScale, glow: 0, fill: 0 });
  expect(unsung.lift).toBeGreaterThan(0);
  const singing = syllableMotion(1000, 2000, 1700);
  expect(singing.scale).toBeGreaterThan(1.04);
  expect(singing.lift).toBeLessThan(-0.03);
  expect(singing.glow).toBeGreaterThan(0.5);
  const sung = syllableMotion(1000, 2000, Infinity);
  expect(sung).toMatchObject({ scale: 1, lift: 0, glow: 0, fill: 1 });
  expect(syllableMotion(1000, 2000, 2000 + POP.settleMs).scale).toBeCloseTo(1);
});
it("moves syllables continuously so lines flow without jumps", () => {
  let previous = syllableMotion(1000, 1300, 700);
  for (let time = 701; time <= 2000; time++) {
    const next = syllableMotion(1000, 1300, time);
    expect(Math.abs(next.scale - previous.scale)).toBeLessThan(0.004);
    expect(Math.abs(next.lift - previous.lift)).toBeLessThan(0.003);
    expect(Math.abs(next.glow - previous.glow)).toBeLessThan(0.03);
    previous = next;
  }
  // The next syllable starts rising before this one finishes settling.
  expect(syllableMotion(1000, 1300, 1350).scale).toBeGreaterThan(1);
  expect(syllableMotion(1300, 1600, 1350).scale).toBeGreaterThan(POP.restScale);
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
it("staggers held-word letter pops and settles every letter at full size", () => {
  const first = letterMotion(1000, 4000, 1400, 0, 4);
  const last = letterMotion(1000, 4000, 1400, 3, 4);
  expect(first.lift).toBeLessThan(last.lift);
  expect(first.scale).toBeGreaterThan(last.scale);
  expect(first.fill).toBeGreaterThan(last.fill);
  for (let index = 0; index < 4; index++)
    expect(letterMotion(1000, 4000, 5000, index, 4).scale).toBeCloseTo(1);
});
