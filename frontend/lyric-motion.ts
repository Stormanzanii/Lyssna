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

export interface ScrollSpring {
  position: number;
  velocity: number;
  target: number;
}
/** Analytic critical damping preserves velocity when the active line changes.
 * A softer frequency (Spicy Lyrics uses 1 Hz, about 6.3 rad/s) glides between
 * lines instead of snapping. */
export function stepScroll(spring: ScrollSpring, seconds: number): number {
  const frequency = 7,
    offset = spring.position - spring.target;
  const combined = spring.velocity + frequency * offset;
  const decay = Math.exp(-frequency * seconds);
  spring.position = spring.target + (offset + combined * seconds) * decay;
  spring.velocity = (spring.velocity - frequency * combined * seconds) * decay;
  return spring.position;
}
export interface SyllableMotion {
  /** Vertical offset in em; negative is up. */
  lift: number;
  scale: number;
  /** Glow strength, 0 to 1. */
  glow: number;
  /** Share of the syllable already sung, 0 to 1. */
  fill: number;
}
const clamp01 = (value: number) => Math.max(0, Math.min(1, value));
const ease = (value: number) => {
  const x = clamp01(value);
  return x * x * (3 - 2 * x);
};
/** Shape of a syllable's pop: unsung text rests a little smaller and lower,
 * the sung syllable rises past full size, and it settles at full size once
 * sung, so the boundary between sung and unsung stays visible. Modelled on
 * Spicy Lyrics' resting scale of 0.95 and its rise-peak-settle curves. */
export const POP = {
  restScale: 0.96,
  restLift: 0.01,
  peakScale: 1.045,
  peakLift: -0.03,
  letterPeakScale: 1.1,
  letterPeakLift: -0.05,
  /** The rise leads the syllable slightly and peaks soon after it starts,
   * matching the sung attack instead of trailing it. */
  leadMs: 50,
  riseMs: 220,
  settleMs: 300,
};
/** Motion for a syllable at `time`. Pass -Infinity for unsung lines and
 * Infinity for sung ones. The rise starts slightly early and the settle runs
 * past the end, so neighbouring syllables overlap and the line flows. */
export function syllableMotion(
  start: number,
  end: number,
  time: number,
  peakScale = POP.peakScale,
  peakLift = POP.peakLift,
): SyllableMotion {
  const duration = Math.max(1, end - start);
  const rise = ease(
    (time - start + POP.leadMs) /
      (Math.min(POP.riseMs, Math.max(90, duration * 0.6)) + POP.leadMs),
  );
  const settle = ease((time - end) / POP.settleMs);
  const peak = (rest: number, top: number, sung: number) =>
    rest + (top - rest) * rise + (sung - (rest + (top - rest) * rise)) * settle;
  const glowIn = ease((time - start + POP.leadMs) / (POP.leadMs + 90));
  const glowOut = ease((time - end + 60) / (POP.settleMs + 60));
  return {
    lift: peak(POP.restLift, peakLift, 0),
    scale: peak(POP.restScale, peakScale, 1),
    glow: glowIn * (1 - glowOut),
    fill: clamp01((time - start) / duration),
  };
}
/** Letters of a held syllable rise one after another across its duration. */
export function letterMotion(
  start: number,
  end: number,
  time: number,
  index: number,
  count: number,
): SyllableMotion {
  const slot = Math.max(1, (end - start) / Math.max(1, count));
  const letterStart = start + index * slot;
  const motion = syllableMotion(
    letterStart,
    letterStart + Math.max(slot, 220),
    time,
    POP.letterPeakScale,
    POP.letterPeakLift,
  );
  return { ...motion, fill: clamp01((time - letterStart) / slot) };
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
