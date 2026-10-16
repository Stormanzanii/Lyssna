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
export function wordMotion(start: number, end: number, time: number) {
  if (time < 0) return { lift: -0, scale: 1, glow: 0 };
  // A longer rise and release keeps neighbouring syllables overlapping, so
  // motion flows across a line instead of pulsing word by word.
  const phase = Math.max(
    0,
    Math.min(1, (time - start + 180) / (Math.max(160, end - start) + 560)),
  );
  const envelope = Math.sin(phase * Math.PI) ** 2;
  return {
    lift: -0.045 * envelope,
    scale: 1 + 0.075 * envelope,
    glow: 0.42 * envelope,
  };
}
export function letterMotion(
  start: number,
  end: number,
  time: number,
  index: number,
  count: number,
) {
  if (time < 0) return { lift: 0, scale: 1, glow: 0, fill: 0 };
  const slot = Math.max(1, (end - start - 250) / Math.max(1, count));
  const letterStart = start + index * slot;
  const phase = Math.max(
    0,
    Math.min(1, (time - letterStart + 40) / (slot + 300)),
  );
  const envelope = Math.sin(phase * Math.PI) ** 2;
  return {
    lift: -0.035 * envelope,
    scale: 1 + 0.06 * envelope,
    glow: 0.34 * envelope,
    fill: Math.max(0, Math.min(1, (time - letterStart) / slot)),
  };
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
