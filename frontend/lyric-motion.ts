import type { Word, Line } from "./types";
export function vocalEnd(line: Line) {
  return line.words?.length
    ? Math.max(...line.words.map((word) => word.end_ms))
    : line.end_ms;
}
export interface VocalGap {
  opposite?: boolean;
  start: number;
  end: number;
  after: number;
}
export function vocalGaps(lines: Line[]): VocalGap[] {
  const intervals = lines
    .map((line, index) => ({
      start: line.start_ms,
      end: vocalEnd(line),
      index,
    }))
    .sort((a, b) => a.start - b.start);
  const gaps: VocalGap[] = [];
  let end = 0,
    after = -1;
  for (const interval of intervals) {
    if (interval.start - end >= 2500)
      gaps.push({
        start: end,
        end: interval.start,
        after,
        opposite: lines[interval.index].opposite,
      });
    if (interval.start > end) {
      end = interval.end;
      after = interval.index;
    } else {
      end = Math.max(end, interval.end);
      after = Math.max(after, interval.index);
    }
  }
  return gaps;
}

export function vocalGap(lines: Line[], time: number) {
  let opposite: boolean | undefined;
  let start = 0,
    end = Infinity,
    after = -1;
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    const endMs = vocalEnd(line);
    if (time >= line.start_ms && time < endMs) return undefined;
    if (endMs <= time && endMs >= start) {
      start = endMs;
      after = index;
    }
    if (line.start_ms > time && line.start_ms < end) {
      end = line.start_ms;
      opposite = line.opposite;
    }
  }
  return Number.isFinite(end) && end - start >= 2500
    ? { start, end, after, opposite }
    : undefined;
}

/** After a restart or long seek, lyrics slide to the new line over this long
 * instead of springing through the whole song. */
export const GLIDE_MS = 700;
/** Scroll position `elapsed` ms into a glide, eased in and out. */
export function glideScroll(from: number, to: number, elapsed: number) {
  const t = Math.min(1, Math.max(0, elapsed / GLIDE_MS));
  const eased = t < 0.5 ? 4 * t ** 3 : 1 - (-2 * t + 2) ** 3 / 2;
  return from + (to - from) * eased;
}
export interface ScrollSpring {
  position: number;
  velocity: number;
  target: number;
}
/** Analytic critical damping preserves velocity when the active line changes,
 * so scrolling glides between lines instead of snapping. */
export function stepScroll(spring: ScrollSpring, seconds: number): number {
  const frequency = 7,
    offset = spring.position - spring.target;
  const combined = spring.velocity + frequency * offset;
  const decay = Math.exp(-frequency * seconds);
  spring.position = spring.target + (offset + combined * seconds) * decay;
  spring.velocity = (spring.velocity - frequency * combined * seconds) * decay;
  return spring.position;
}
/** Analytic damped spring ported from Fraktality/spr (MIT). Frequency is in
 * hertz. */
export class Spring {
  position: number;
  velocity = 0;
  goal: number;
  constructor(
    position: number,
    private frequency: number,
    private damping: number,
  ) {
    this.position = this.goal = position;
  }
  step(seconds: number): number {
    const d = this.damping,
      f = this.frequency * 2 * Math.PI,
      offset = this.position - this.goal,
      v = this.velocity;
    if (d === 1) {
      const q = Math.exp(-f * seconds),
        w = seconds * q;
      this.position = offset * (q + w * f) + v * w + this.goal;
      this.velocity = v * (q - w * f) - offset * (w * f * f);
    } else if (d < 1) {
      const q = Math.exp(-d * f * seconds),
        c = Math.sqrt(1 - d * d),
        i = Math.cos(seconds * f * c),
        j = Math.sin(seconds * f * c),
        z = j / c,
        y = j / (f * c);
      this.position = (offset * (i + z * d) + v * y) * q + this.goal;
      this.velocity = (v * (i - z * d) - offset * (z * f)) * q;
    } else {
      const c = Math.sqrt(d * d - 1),
        r1 = -f * (d + c),
        r2 = -f * (d - c),
        co2 = (v - offset * r1) / (2 * f * c),
        co1 = Math.exp(r1 * seconds) * (offset - co2);
      this.position = co1 + co2 * Math.exp(r2 * seconds) + this.goal;
      this.velocity = co1 * r1 + co2 * Math.exp(r2 * seconds) * r2;
    }
    return this.position;
  }
  get asleep() {
    const offset = this.position - this.goal;
    return this.velocity ** 2 <= 1e-4 && offset ** 2 <= (1 / 3840) ** 2;
  }
}
/** Natural cubic spline through `points`. */
export function naturalSpline(points: readonly (readonly [number, number])[]) {
  const xs = points.map((point) => point[0]),
    ys = points.map((point) => point[1]),
    n = xs.length - 1;
  const below = new Array<number>(n + 1).fill(0),
    diagonal = [...below],
    above = [...below],
    right = [...below];
  for (let i = 1; i < n; i++) {
    const l = 1 / (xs[i] - xs[i - 1]),
      r = 1 / (xs[i + 1] - xs[i]);
    below[i] = l;
    diagonal[i] = 2 * (l + r);
    above[i] = r;
    right[i] = 3 * ((ys[i] - ys[i - 1]) * l * l + (ys[i + 1] - ys[i]) * r * r);
  }
  const first = 1 / (xs[1] - xs[0]),
    last = 1 / (xs[n] - xs[n - 1]);
  diagonal[0] = 2 * first;
  above[0] = first;
  right[0] = 3 * (ys[1] - ys[0]) * first * first;
  below[n] = last;
  diagonal[n] = 2 * last;
  right[n] = 3 * (ys[n] - ys[n - 1]) * last * last;
  for (let i = 1; i <= n; i++) {
    const m = below[i] / diagonal[i - 1];
    diagonal[i] -= m * above[i - 1];
    right[i] -= m * right[i - 1];
  }
  const slopes = [...right];
  slopes[n] = right[n] / diagonal[n];
  for (let i = n - 1; i >= 0; i--)
    slopes[i] = (right[i] - above[i] * slopes[i + 1]) / diagonal[i];
  return (x: number) => {
    let i = 1;
    while (i < n && xs[i] < x) i++;
    const width = xs[i] - xs[i - 1],
      t = (x - xs[i - 1]) / width,
      rise = ys[i] - ys[i - 1],
      a = slopes[i - 1] * width - rise,
      b = -slopes[i] * width + rise;
    return (
      (1 - t) * ys[i - 1] + t * ys[i] + t * (1 - t) * (a * (1 - t) + b * t)
    );
  };
}
/** Animation curves over a syllable's progress, and the springs that chase
 * them. Lift is a share of the font size. */
export const MOTION = {
  scale: naturalSpline([
    [0, 0.95],
    [0.7, 1.0505],
    [1, 1],
  ]),
  letterScale: naturalSpline([
    [0, 0.95],
    [0.7, 1.175],
    [1, 1],
  ]),
  lift: naturalSpline([
    [0, 1 / 100],
    [0.9, -1 / 60],
    [1, 0],
  ]),
  letterLift: naturalSpline([
    [0, 1 / 100],
    [0.9, -1 / 56],
    [1, 0],
  ]),
  glow: naturalSpline([
    [0, 0],
    [0.15, 1],
    [0.6, 1],
    [1, 0],
  ]),
  /** Frequency in hertz and damping ratio. */
  springs: { scale: [0.88, 0.64], lift: [1.45, 0.4], glow: [1.18, 0.56] },
  /** Glow left on sung letters while their held word waits between letters. */
  sungLetterGlow: 0.2,
  /** Held words finish their letters this much before the word ends. */
  emphasisTailMs: 250,
  /** Syllable goals lead song time by this much. The scale spring takes about
   * a quarter second to rise, and the fill shows nothing until its soft edge
   * enters the syllable, so goals sampled on time land behind the voice. */
  leadMs: 90,
  blurPerLine: 1.25,
  maxBlur: 1.25 * 5.465,
} as const;
export type SungState = "unsung" | "active" | "sung";
export const sungState = (start: number, end: number, time: number) =>
  (time < start ? "unsung" : time >= end ? "sung" : "active") as SungState;
const progressOf = (start: number, end: number, time: number) =>
  time <= start ? 0 : time >= end ? 1 : (time - start) / (end - start);
export interface SyllableGoal {
  scale: number;
  /** Vertical offset in em; negative is up. */
  lift: number;
  /** Glow strength, 0 to 1. */
  glow: number;
  /** Leading edge of the sung gradient, in percent of the syllable width. */
  gradient: number;
}
export function wordGoal(
  start: number,
  end: number,
  time: number,
): SyllableGoal {
  const state = sungState(start, end, time),
    at =
      state === "unsung"
        ? 0
        : state === "sung"
          ? 1
          : progressOf(start, end, time);
  return {
    scale: MOTION.scale(at),
    lift: MOTION.lift(at),
    glow: MOTION.glow(at),
    gradient:
      state === "unsung" ? -20 : state === "sung" ? 100 : -20 + 120 * at,
  };
}
/** Letters of a held word share its time evenly. The sung letter pops and its
 * neighbours follow with a steep falloff; letters lift twice as far. */
export function letterGoals(
  start: number,
  end: number,
  time: number,
  count: number,
): SyllableGoal[] {
  const slot = (end - start) / Math.max(1, count),
    word = sungState(start, end, time);
  const rest = (at: number, gradient: number) => ({
    scale: MOTION.letterScale(at),
    lift: MOTION.letterLift(at) * 2,
    glow: MOTION.glow(at),
    gradient,
  });
  if (word !== "active")
    return Array.from({ length: count }, () =>
      word === "sung" ? rest(1, 100) : rest(0, -20),
    );
  let active = -1,
    at = 0;
  for (let index = 0; index < count && active < 0; index++) {
    const letterStart = start + index * slot;
    if (sungState(letterStart, letterStart + slot, time) === "active") {
      active = index;
      at = progressOf(letterStart, letterStart + slot, time);
    }
  }
  return Array.from({ length: count }, (_, index) => {
    const letterStart = start + index * slot,
      state = sungState(letterStart, letterStart + slot, time),
      goal = rest(0, -20);
    if (state === "unsung") return goal;
    if (active >= 0) {
      const distance = Math.abs(index - active),
        falloff = 1 / (1 + distance ** 2.8),
        glowFalloff = 1 / (1 + distance * 0.9);
      goal.scale += (MOTION.letterScale(at) - goal.scale) * falloff;
      goal.lift += (MOTION.letterLift(at) * 2 - goal.lift) * falloff;
      goal.glow += (MOTION.glow(at) - goal.glow) * glowFalloff;
    } else if (state === "sung") goal.glow = MOTION.glow(MOTION.sungLetterGlow);
    goal.gradient =
      state === "sung"
        ? 100
        : index === active
          ? -20 + 120 * Math.sin((at * Math.PI) / 2)
          : -20;
    return goal;
  });
}
/** Springs for one syllable or letter. They start at full size and level,
 * where text outside the active line rests, and ease into the active line's
 * resting shape. */
export class SyllableSprings {
  scale: Spring;
  lift: Spring;
  glow: Spring;
  constructor() {
    const { scale, lift, glow } = MOTION.springs;
    this.scale = new Spring(1, scale[0], scale[1]);
    this.lift = new Spring(0, lift[0], lift[1]);
    this.glow = new Spring(0, glow[0], glow[1]);
  }
  step(goal: SyllableGoal, seconds: number) {
    this.scale.goal = goal.scale;
    this.lift.goal = goal.lift;
    this.glow.goal = goal.glow;
    return {
      scale: this.scale.step(seconds),
      lift: this.lift.step(seconds),
      glow: this.glow.step(seconds),
    };
  }
  get asleep() {
    return this.scale.asleep && this.lift.asleep && this.glow.asleep;
  }
}
/** Text-shadow blur, in pixels, for a line `distance` lines from the active
 * one. */
export const lineBlur = (distance: number) =>
  Math.min(MOTION.blurPerLine * distance, MOTION.maxBlur);
/** Held syllables animate letter by letter. */
export function isEmphasis(word: Word, text: string) {
  return (
    word.end_ms - word.start_ms >= 1000 &&
    Array.from(text).length <= 32 &&
    !/[\s֐-ࣿ]/u.test(text)
  );
}
/** Preserve per-syllable timing while keeping split words in one layout box. */
export function wordGroups(words: Word[]): Word[][] {
  const groups: Word[][] = [];
  for (const word of words) {
    const previous = groups.at(-1);
    if (
      previous &&
      !/^\s/u.test(word.text) &&
      !/\s$/u.test(previous.at(-1)!.text)
    )
      previous.push(word);
    else groups.push([word]);
  }
  return groups;
}
