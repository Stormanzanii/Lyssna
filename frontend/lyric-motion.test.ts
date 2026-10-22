import { expect, it } from "vitest";
import {
  GLIDE_MS,
  countdownDots,
  countdownVisible,
  MOTION,
  glideScroll,
  Spring,
  letterGoals,
  lineBlur,
  naturalSpline,
  stepScroll,
  vocalGap,
  vocalGaps,
  wordGoal,
} from "./lyric-motion";
import type { Line } from "./types";
// Measured from the supplied recording. Each dot's turn lasts about 7.2 s;
// size and rise are normalized to its dormant 20 px diameter.
it.each([
  [1000, 0.54, 1.12, 5.8],
  [2000, 0.69, 1.26, 10.5],
  [3000, 0.85, 1.35, 14.5],
  [4000, 0.96, 1.42, 16.6],
  [5000, 0.97, 1.45, 14.9],
  [6000, 0.98, 1.43, 9.2],
])(
  "tracks the recorded countdown arc at %i ms",
  (time, opacity, scale, rise) => {
    const dot = countdownDots({ start: 0, end: 22150, after: 0 }, time)[0];
    expect(Math.abs(dot.opacity - opacity)).toBeLessThan(0.08);
    expect(Math.abs(dot.scale - scale)).toBeLessThan(0.08);
    expect(Math.abs(dot.lift * 20 - rise)).toBeLessThan(2);
  },
);
it("fills countdown dots in order and rewinds from song time", () => {
  const gap = { start: 1000, end: 7000, after: 0 };
  expect(countdownDots(gap, 0).map((dot) => dot.opacity)).toEqual([
    0.3, 0.3, 0.3,
  ]);
  const middle = countdownDots(gap, 3500);
  expect(middle[0].opacity).toBe(1);
  expect(middle[1].opacity).toBeGreaterThan(0.8);
  expect(middle[1].opacity).toBeLessThan(1);
  expect(middle[2].opacity).toBe(0.3);
  expect(countdownDots(gap, 8000).map((dot) => dot.opacity)).toEqual([1, 1, 1]);
  expect(countdownDots(gap, 1000).map((dot) => dot.opacity)).toEqual([
    0.3, 0.3, 0.3,
  ]);
});
it("swells continuously through an arc and settles below its peak size", () => {
  const gap = { start: 1000, end: 7000, after: 0 };
  const start = countdownDots(gap, 1000),
    rising = countdownDots(gap, 1400),
    middle = countdownDots(gap, 1800),
    peak = countdownDots(gap, 2400),
    settled = countdownDots(gap, 3000);
  expect(start[0]).toMatchObject({ scale: 1, lift: 0, glow: 0 });
  expect(rising[0].lift).toBeGreaterThan(0);
  expect(middle[0].lift).toBeGreaterThan(rising[0].lift);
  expect(middle[0].scale).toBeGreaterThan(rising[0].scale);
  expect(peak[0].scale).toBeGreaterThan(settled[0].scale);
  expect(settled[0]).toMatchObject({
    opacity: 1,
    scale: 4 / 3,
    lift: 0,
    glow: 1,
  });
  expect(settled[1].scale).toBeLessThan(1.1);
  expect(countdownDots(gap, 1800)).toEqual(middle);
  expect(countdownDots(gap, 1000)).toEqual(start);
});
it("finishes and contracts the countdown before the next vocal", () => {
  const gap = { start: 1000, end: 7000, after: 0 };
  expect(countdownVisible(gap, 900)).toBe(false);
  expect(countdownVisible(gap, 1000)).toBe(true);
  expect(countdownVisible(gap, 6499)).toBe(true);
  expect(countdownVisible(gap, 6500)).toBe(false);
  expect(countdownDots(gap, 6450).every((dot) => dot.lift === 0)).toBe(true);
});
it("keeps countdown progress with reduced motion while removing the lift", () => {
  const gap = { start: 1000, end: 7000, after: 0 };
  const moving = countdownDots(gap, 4000),
    still = countdownDots(gap, 4000, true);
  expect(still.map((dot) => dot.opacity)).toEqual(
    moving.map((dot) => dot.opacity),
  );
  expect(still.map((dot) => dot.scale)).toEqual(moving.map((dot) => dot.scale));
  expect(still.map((dot) => dot.glow)).toEqual(moving.map((dot) => dot.glow));
  expect(still.every((dot) => dot.lift === 0)).toBe(true);
  expect(moving[1].lift).toBeGreaterThan(0);
});
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
it("passes curves through their points without kinks", () => {
  const curve = naturalSpline([
    [0, 0.95],
    [0.7, 1.0505],
    [1, 1],
  ]);
  expect(curve(0)).toBeCloseTo(0.95);
  expect(curve(0.7)).toBeCloseTo(1.0505);
  expect(curve(1)).toBeCloseTo(1);
  for (let x = 0.001; x <= 1; x += 0.001)
    expect(Math.abs(curve(x) - curve(x - 0.001))).toBeLessThan(0.001);
});
it("settles springs at their goal regardless of frame rate", () => {
  const finals = [30, 60, 144].map((rate) => {
    const spring = new Spring(0.95, 0.88, 0.64);
    spring.goal = 1;
    for (let frame = 0; frame < rate / 2; frame++) spring.step(1 / rate);
    const quarter = spring.position;
    for (let frame = 0; frame < rate * 4; frame++) spring.step(1 / rate);
    expect(spring.asleep).toBe(true);
    expect(spring.position).toBeCloseTo(1);
    return quarter;
  });
  expect(Math.max(...finals) - Math.min(...finals)).toBeLessThan(1e-6);
});
it("rests unsung syllables low at full size, sweeps the fill, and settles sung ones", () => {
  expect(wordGoal(1000, 2000, 500)).toEqual({
    scale: 1,
    lift: 0.01,
    glow: 0,
    gradient: -20,
  });
  const singing = wordGoal(1000, 2000, 1700);
  expect(singing.scale).toBeCloseTo(1.0505);
  expect(singing.lift).toBeLessThan(0);
  expect(singing.gradient).toBeCloseTo(64);
  // The natural spline overshoots between its points; the glow peaks above
  // 1 early in the syllable.
  expect(wordGoal(1000, 2000, 1400).glow).toBeCloseTo(1.4012, 3);
  expect(wordGoal(1000, 2000, 1500).lift).toBeCloseTo(-0.0353, 4);
  expect(wordGoal(1000, 2000, 2000)).toEqual({
    scale: 1,
    lift: 0,
    glow: 0,
    gradient: 100,
  });
});
it("pops the sung letter of a held word and eases its neighbours", () => {
  const goals = letterGoals(1000, 2000, 1310, 4);
  expect(goals[1].scale).toBeGreaterThan(goals[0].scale);
  expect(goals[1].gradient).toBeGreaterThan(-20);
  expect(goals[0].gradient).toBe(100);
  // Unsung letters wait at rest with no fill.
  expect(goals[2]).toMatchObject({ scale: 1, gradient: -20 });
  expect(goals[3]).toMatchObject({ scale: 1, gradient: -20 });
  for (const goal of letterGoals(1000, 2000, 2000, 4))
    expect(goal).toMatchObject({ scale: 1, lift: 0, gradient: 100 });
});
it("blurs lines more the further they are from the active one, up to a cap", () => {
  expect(lineBlur(0)).toBe(0);
  expect(lineBlur(1)).toBeCloseTo(1.25);
  expect(lineBlur(2)).toBeGreaterThan(lineBlur(1));
  expect(lineBlur(20)).toBeCloseTo(MOTION.maxBlur);
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
it("slides to a restarted song's first line quickly, easing in and out", () => {
  expect(glideScroll(5000, 0, 0)).toBe(5000);
  expect(glideScroll(5000, 0, GLIDE_MS / 2)).toBeCloseTo(2500);
  expect(glideScroll(5000, 0, GLIDE_MS)).toBe(0);
  expect(glideScroll(5000, 0, GLIDE_MS * 2)).toBe(0);
  // Starts and ends gently.
  expect(5000 - glideScroll(5000, 0, GLIDE_MS / 10)).toBeLessThan(100);
  expect(glideScroll(5000, 0, GLIDE_MS * 0.9)).toBeLessThan(100);
});
