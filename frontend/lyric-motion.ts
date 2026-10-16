import type { Word, Line } from "./types";
export function vocalEnd(line: Line) {
  return line.words?.length
    ? Math.max(...line.words.map((word) => word.end_ms))
    : line.end_ms;
}

export function vocalGap(lines: Line[], time: number) {
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
    if (line.start_ms > time) end = Math.min(end, line.start_ms);
  }
  return Number.isFinite(end) && end - start >= 2500
    ? { start, end, after }
    : undefined;
}

export interface ScrollSpring {
  position: number;
  velocity: number;
  target: number;
}
/** Analytic critical damping preserves velocity when the active line changes. */
export function stepScroll(spring: ScrollSpring, seconds: number): number {
  const frequency = 12,
    offset = spring.position - spring.target;
  const combined = spring.velocity + frequency * offset;
  const decay = Math.exp(-frequency * seconds);
  spring.position = spring.target + (offset + combined * seconds) * decay;
  spring.velocity = (spring.velocity - frequency * combined * seconds) * decay;
  return spring.position;
}
export function wordMotion(start: number, end: number, time: number) {
  const phase = Math.max(
    0,
    Math.min(1, (time - start + 100) / (Math.max(120, end - start) + 400)),
  );
  const envelope = Math.sin(phase * Math.PI) ** 2;
  return {
    lift: -0.035 * envelope,
    scale: 1 + 0.065 * envelope,
    glow: 0.45 * envelope,
  };
}
export function letterMotion(
  start: number,
  end: number,
  time: number,
  index: number,
  count: number,
) {
  const slot = Math.max(1, (end - start - 250) / Math.max(1, count));
  const letterStart = start + index * slot;
  const phase = Math.max(
    0,
    Math.min(1, (time - letterStart + 40) / (slot + 300)),
  );
  const envelope = Math.sin(phase * Math.PI) ** 2;
  return {
    lift: -0.03 * envelope,
    scale: 1 + 0.06 * envelope,
    glow: 0.32 * envelope,
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
