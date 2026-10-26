import {
  memo,
  useLayoutEffect,
  useMemo,
  useRef,
  type CSSProperties,
} from "react";
import type { Line } from "./types";

/* Highlighter: a lyrics player where a marker pen draws over each line as
 * it is sung. The ink lies on top of the text, see-through like a real
 * highlighter, one stroke per row with slanted chisel-tip ends, a slight
 * tilt and wobble, and streaks. Like a real pen, slow stretches leave
 * darker ink than quick ones, and where the singing pauses mid-line the
 * resting tip leaves a darker mark. Sung lines keep their strokes. Timed
 * syllables set the pace; a line without them is shared out over its
 * words by letter count. */

/** Marker colours to pick from. The ink is see-through, so these are
 *  bright; over dark backgrounds they read as a darker shade. */
export const MARKER_COLOURS = [
  ["#d4b80f", "Yellow"],
  ["#e07a1f", "Orange"],
  ["#e0479a", "Pink"],
  ["#a066e8", "Purple"],
  ["#3f8ee8", "Blue"],
  ["#3fbf5f", "Green"],
] as const;
export const DEFAULT_MARKER: string = MARKER_COLOURS[0][0];

/** The CSS colour for a saved marker choice. */
export const markerColour = (choice: string = DEFAULT_MARKER) =>
  choice === "cover"
    ? `var(--lyrics-cover-color, ${DEFAULT_MARKER})`
    : /^#[0-9a-f]{6}$/i.test(choice)
      ? choice
      : DEFAULT_MARKER;

export interface Piece {
  text: string;
  start_ms: number;
  end_ms: number;
}

/** The stretches of a line the marker covers one after another. */
export function highlighterPieces(line: Line): Piece[] {
  if (line.words.length)
    return line.words.map(({ text, start_ms, end_ms }) => ({
      text,
      start_ms,
      end_ms,
    }));
  const words = line.text.match(/\S+\s*/g) ?? [];
  const weights = words.map(
    (word) => word.replace(/[^\p{L}\p{N}]/gu, "").length || 1,
  );
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  const span = Math.max(0, line.end_ms - line.start_ms);
  let at = line.start_ms;
  return words.map((text, index) => {
    const start_ms = at;
    at += (span * weights[index]) / total;
    return { text, start_ms, end_ms: at };
  });
}

/** How much of a piece the marker covers at `time`, 0 to 1. */
export function inkAt(piece: Piece, time: number) {
  if (time <= piece.start_ms) return 0;
  if (time >= piece.end_ms) return 1;
  return (time - piece.start_ms) / Math.max(1, piece.end_ms - piece.start_ms);
}

interface Row {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

/** The rows the line's text sits on, from its pieces' boxes. */
function textRows(spans: HTMLElement[]): Row[] {
  const rows: Row[] = [];
  for (const span of spans)
    for (const box of span.getClientRects()) {
      if (!box.width) continue;
      const row = rows.find(
        (row) => Math.abs(row.top - box.top) < box.height / 2,
      );
      if (row) {
        row.left = Math.min(row.left, box.left);
        row.right = Math.max(row.right, box.right);
        row.bottom = Math.max(row.bottom, box.bottom);
      } else rows.push({ ...box.toJSON() });
    }
  return rows.sort((a, b) => a.top - b.top);
}

/** Where the marker's tip is at `time`: the end of the ink, or null before
 *  the line starts. `Infinity` means the whole line is inked. */
function tipAt(
  spans: HTMLElement[],
  pieces: Piece[],
  time: number,
): { x: number; top: number } | null {
  const current = pieces.findIndex((piece) => time < piece.end_ms);
  if (current === -1) return { x: Infinity, top: Infinity };
  const span = spans[current],
    text = span?.firstChild;
  if (!span || !text) return null;
  const letters = Math.round(
    inkAt(pieces[current], time) * (text.textContent?.length ?? 0),
  );
  if (!letters) {
    if (current === 0) return null;
    const start = span.getClientRects()[0];
    return start ? { x: start.left, top: start.top } : null;
  }
  const range = document.createRange();
  range.setStart(text, 0);
  range.setEnd(text, letters);
  const boxes = range.getClientRects(),
    end = boxes[boxes.length - 1];
  return end ? { x: end.right, top: end.top } : null;
}

/** How dark the ink lies over a stretch drawn `widthEm` wide in
 *  `durationMs`: a slow pen leaves more ink, a quick one less. */
export function inkAlpha(widthEm: number, durationMs: number) {
  const speed = widthEm / Math.max(0.05, durationMs / 1000);
  return Math.min(0.82, Math.max(0.36, 0.82 - 0.055 * speed));
}

/** How strong a mark the pen leaves resting between two stretches when the
 *  singing pauses, 0 to 1: it grows the longer the pen rests. */
export function restMark(before: Piece, after: Piece, time: number) {
  const rest = Math.min(time, after.start_ms) - before.end_ms;
  return after.start_ms - before.end_ms < 150 || rest <= 0
    ? 0
    : Math.min(1, rest / 700);
}

/** The see-through mask along one stroke: each stretch's ink by its pen
 *  speed, with darker marks where the pen rested. */
function inkMask(
  stroke: { left: number; right: number },
  stretches: { left: number; right: number; alpha: number; rest: number }[],
  em: number,
) {
  const stops: [number, number][] = [];
  for (const { left, right, alpha, rest } of stretches) {
    stops.push([(left + right) / 2 - stroke.left, alpha]);
    if (rest) {
      const at = right - stroke.left,
        peak = Math.min(0.95, alpha + 0.55 * rest);
      stops.push(
        [at - 0.3 * em, alpha],
        [at - 0.08 * em, peak],
        [at + 0.04 * em, peak],
      );
    }
  }
  stops.sort((a, b) => a[0] - b[0]);
  if (stops.length === 1) stops.push([stops[0][0] + 1, stops[0][1]]);
  return `linear-gradient(90deg, ${stops
    .map(([x, alpha]) => `rgb(0 0 0 / ${alpha.toFixed(3)}) ${x.toFixed(1)}px`)
    .join(", ")})`;
}

/** Small steady variations per row, so strokes look drawn by hand. */
function wobble(seed: number) {
  const value = Math.sin(seed * 12.9898 + 78.233) * 43758.5453;
  return value - Math.floor(value) - 0.5;
}

/** Draws the strokes for `time` into `ink`, reusing its stroke elements. */
function drawInk(
  root: HTMLElement,
  ink: HTMLElement,
  pieces: Piece[],
  time: number,
  seed: number,
) {
  const spans = [...root.querySelectorAll<HTMLElement>(".highlighter-piece")];
  const tip = time === -Infinity ? null : tipAt(spans, pieces, time);
  const strokes: (Row & { mask: string })[] = [];
  if (tip) {
    const box = root.getBoundingClientRect();
    const em = parseFloat(getComputedStyle(root).fontSize) || 16;
    const stretches = spans.map((span, index) => {
      const piece = pieces[index],
        edges = span.getBoundingClientRect();
      return {
        left: edges.left,
        right: edges.right,
        top: edges.top,
        alpha: inkAlpha(edges.width / em, piece.end_ms - piece.start_ms),
        rest:
          index < pieces.length - 1
            ? restMark(piece, pieces[index + 1], time)
            : 0,
      };
    });
    for (const row of textRows(spans)) {
      const done = row.top < tip.top - (row.bottom - row.top) / 2;
      const here =
        !done && Math.abs(row.top - tip.top) < (row.bottom - row.top) / 2;
      if (!done && !here) break;
      const right = here ? Math.min(tip.x, row.right) : row.right;
      if (right <= row.left) continue;
      const stroke = {
        left: row.left - 0.14 * em,
        right: right + (here && tip.x < row.right ? 0 : 0.14 * em),
      };
      strokes.push({
        left: stroke.left - box.left,
        right: stroke.right - box.left,
        top: row.top - box.top,
        bottom: row.bottom - box.top,
        mask: inkMask(
          stroke,
          stretches.filter(
            (stretch) =>
              Math.abs(stretch.top - row.top) < (row.bottom - row.top) / 2 &&
              stretch.left < right,
          ),
          em,
        ),
      });
    }
  }
  while (ink.children.length > strokes.length) ink.lastChild!.remove();
  strokes.forEach((stroke, index) => {
    const element =
      (ink.children[index] as HTMLElement | undefined) ??
      ink.appendChild(document.createElement("span"));
    element.className = "highlighter-stroke";
    const height = stroke.bottom - stroke.top;
    const shift = wobble(seed + index);
    element.style.left = `${stroke.left}px`;
    element.style.width = `${stroke.right - stroke.left}px`;
    element.style.top = `${stroke.top + height * (0.14 + shift * 0.04)}px`;
    element.style.height = `${height * (0.78 + wobble(seed - index) * 0.05)}px`;
    element.style.transform = `rotate(${shift * 0.9}deg)`;
    element.style.maskImage = stroke.mask;
    element.style.webkitMaskImage = stroke.mask;
  });
}

/** One line's words with the marker drawn up to `time`. Lines that are not
 *  being sung pass `-Infinity` (not yet sung) or `Infinity` (sung), so
 *  they skip redrawing each frame. */
export const HighlighterWords = memo(function HighlighterWords({
  line,
  time,
}: {
  line: Line;
  time: number;
}) {
  const pieces = useMemo(() => highlighterPieces(line), [line]);
  const root = useRef<HTMLSpanElement>(null),
    ink = useRef<HTMLSpanElement>(null),
    latest = useRef(time);
  latest.current = time;
  const seed = line.start_ms % 997;
  useLayoutEffect(() => {
    if (root.current && ink.current)
      drawInk(root.current, ink.current, pieces, time, seed);
  }, [pieces, time, seed]);
  // Rows move when the window or text size changes.
  useLayoutEffect(() => {
    const element = root.current;
    if (!element) return;
    const observer = new ResizeObserver(() => {
      if (ink.current)
        drawInk(element, ink.current, pieces, latest.current, seed);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [pieces, seed]);
  return (
    <span className="highlighter-words" ref={root}>
      {pieces.map((piece, index) => (
        <span
          key={index}
          className="highlighter-piece"
          style={{ "--ink": inkAt(piece, time) } as CSSProperties}
        >
          {piece.text}
        </span>
      ))}
      <span className="highlighter-ink" aria-hidden="true" ref={ink} />
    </span>
  );
});
