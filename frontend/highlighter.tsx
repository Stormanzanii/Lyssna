import {
  memo,
  useLayoutEffect,
  useMemo,
  useRef,
  type CSSProperties,
} from "react";
import type { Line } from "./types";

/* Highlighter: a lyrics player where a marker pen highlights each line as
 * it is sung, after a screen recording of a highlighter-style lyrics
 * view. Each row gets one band of ink behind the text, a slanted rounded
 * stroke, with a brighter rounded pen tip at its end. Ink is laid in place
 * and revealed as the pen passes, so what is drawn never moves or
 * stretches. Like a real pen, slow stretches leave stronger ink than
 * quick ones, and where the singing pauses mid-line the resting tip leaves
 * a stronger mark. The pen glides after the song instead of snapping, and
 * sung lines keep their ink. Timed syllables set the pace; a line without
 * them is shared out over its words by letter count. */

/** Marker colours to pick from. The ink is laid see-through over the
 *  background, so these are bright; on dark backgrounds they read as a
 *  deeper shade, like the olive of yellow ink on black. */
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

/** Ink strength (its opacity) for a stretch drawn `widthEm` wide in
 *  `durationMs`: a slow pen leaves more ink, a quick one less. */
export function inkAlpha(widthEm: number, durationMs: number) {
  const speed = widthEm / Math.max(0.05, durationMs / 1000);
  return Math.min(0.56, Math.max(0.3, 0.56 - 0.03 * speed));
}

/** How strong a mark the pen leaves resting between two stretches when the
 *  singing pauses, 0 to 1: it grows the longer the pen rests. */
export function restMark(before: Piece, after: Piece, time: number) {
  const rest = Math.min(time, after.start_ms) - before.end_ms;
  return after.start_ms - before.end_ms < 150 || rest <= 0
    ? 0
    : Math.min(1, rest / 700);
}

interface Box {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

/** One piece's place, in the line's own pixels, and its ink strength. */
interface Stretch extends Box {
  index: number;
  alpha: number;
}

/** A row's stroke: where it sits and where along the pen's path (all rows
 *  end to end) it begins. */
interface Lane extends Box {
  start: number;
  stretches: Stretch[];
}

interface Layout {
  lanes: Lane[];
  length: number;
  em: number;
  spans: HTMLElement[];
}

/** Converts screen positions to the line's own pixels, so strokes line up
 *  even while the line is scaled. */
function localFrame(root: HTMLElement) {
  const box = root.getBoundingClientRect();
  const scale = box.width / (root.offsetWidth || box.width || 1) || 1;
  return {
    x: (x: number) => (x - box.left) / scale,
    y: (y: number) => (y - box.top) / scale,
  };
}

/** Measures the rows and pieces. Strokes are revealed over this fixed
 *  layout, so ink already laid never moves or stretches. */
function measure(root: HTMLElement, pieces: Piece[]): Layout {
  const spans = [...root.querySelectorAll<HTMLElement>(".highlighter-piece")];
  const frame = localFrame(root);
  const em = parseFloat(getComputedStyle(root).fontSize) || 16;
  const stretches: Stretch[] = spans.map((span, index) => {
    const edges = span.getBoundingClientRect();
    const left = frame.x(edges.left),
      right = frame.x(edges.right);
    return {
      index,
      left,
      right,
      top: frame.y(edges.top),
      bottom: frame.y(edges.bottom),
      alpha: inkAlpha(
        (right - left) / em,
        pieces[index].end_ms - pieces[index].start_ms,
      ),
    };
  });
  const lanes: Lane[] = [];
  for (const stretch of stretches) {
    if (stretch.right - stretch.left < 0.5) continue;
    const lane = lanes.find(
      (lane) =>
        Math.abs(lane.top - stretch.top) < (stretch.bottom - stretch.top) / 2,
    );
    if (lane) {
      lane.left = Math.min(lane.left, stretch.left);
      lane.right = Math.max(lane.right, stretch.right);
      lane.bottom = Math.max(lane.bottom, stretch.bottom);
      lane.stretches.push(stretch);
    } else lanes.push({ ...stretch, start: 0, stretches: [stretch] });
  }
  lanes.sort((a, b) => a.top - b.top);
  let length = 0;
  for (const lane of lanes) {
    lane.start = length;
    length += lane.right - lane.left;
  }
  return { lanes, length, em, spans };
}

/** How far along the pen's path the tip is at `time`. */
function pathAt(
  root: HTMLElement,
  layout: Layout,
  pieces: Piece[],
  time: number,
) {
  if (time === -Infinity) return 0;
  const current = pieces.findIndex((piece) => time < piece.end_ms);
  if (current === -1) return layout.length;
  const span = layout.spans[current],
    text = span?.firstChild;
  if (!span || !text) return 0;
  const letters =
    inkAt(pieces[current], time) * (text.textContent?.length ?? 0);
  const frame = localFrame(root);
  // The tip glides through each letter rather than jumping letter by
  // letter: it sits between the ends of the letters on either side.
  const range = document.createRange();
  const after = (count: number) => {
    if (!count) {
      const start = span.getClientRects()[0];
      return start ? { x: frame.x(start.left), y: frame.y(start.top) } : null;
    }
    range.setStart(text, 0);
    range.setEnd(text, Math.min(count, text.textContent?.length ?? 0));
    const boxes = range.getClientRects(),
      end = boxes[boxes.length - 1];
    return end ? { x: frame.x(end.right), y: frame.y(end.top) } : null;
  };
  const whole = Math.floor(letters);
  let tip = after(whole);
  const next = letters > whole ? after(whole + 1) : null;
  if (tip && next && Math.abs(next.y - tip.y) < 2)
    tip = { x: tip.x + (next.x - tip.x) * (letters - whole), y: tip.y };
  if (!tip) return 0;
  const lane = layout.lanes.find(
    (lane) => Math.abs(lane.top - tip.y) < (lane.bottom - lane.top) / 2,
  );
  if (!lane) return 0;
  return (
    lane.start +
    Math.min(lane.right - lane.left, Math.max(0, tip.x - lane.left))
  );
}

/** The ink along one row, as a mask in that row's own pixels: each
 *  stretch's strength by its pen speed, stronger where the pen rested. */
function laneMask(
  lane: Lane,
  offset: number,
  pieces: Piece[],
  em: number,
  time: number,
) {
  const stops: [number, number][] = [];
  for (const stretch of lane.stretches) {
    stops.push([(stretch.left + stretch.right) / 2 - offset, stretch.alpha]);
    const next = pieces[stretch.index + 1];
    const rest = next ? restMark(pieces[stretch.index], next, time) : 0;
    if (rest) {
      const at = stretch.right - offset,
        peak = Math.min(0.75, stretch.alpha + 0.3 * rest);
      stops.push(
        [at - 0.3 * em, stretch.alpha],
        [at - 0.1 * em, peak],
        [at + 0.05 * em, peak],
      );
    }
  }
  stops.sort((a, b) => a[0] - b[0]);
  if (stops.length === 1) stops.push([stops[0][0] + 1, stops[0][1]]);
  return `linear-gradient(90deg, ${stops
    .map(([x, alpha]) => `rgb(0 0 0 / ${alpha.toFixed(3)}) ${x.toFixed(1)}px`)
    .join(", ")})`;
}

/** Shows the ink revealed up to `path` along the pen's path. Each row has
 *  one band laid over the whole row and clipped at the tip, plus the
 *  brighter pen tip: moving with the pen, or left where it lifted at the
 *  row's end. */
function paint(
  ink: HTMLElement,
  layout: Layout,
  pieces: Piece[],
  path: number,
  time: number,
) {
  const { em } = layout;
  const lead = 0.16 * em,
    tail = 0.1 * em,
    nib = 0.42 * em;
  const shown = layout.lanes.filter((lane) => path > lane.start + 0.5);
  while (ink.children.length > shown.length * 2) ink.lastChild!.remove();
  shown.forEach((lane, index) => {
    const band =
      (ink.children[index * 2] as HTMLElement | undefined) ??
      ink.appendChild(document.createElement("span"));
    const tip =
      (ink.children[index * 2 + 1] as HTMLElement | undefined) ??
      ink.appendChild(document.createElement("span"));
    band.className = "highlighter-stroke";
    tip.className = "highlighter-tip";
    const width = lane.right - lane.left,
      height = lane.bottom - lane.top;
    const reveal = Math.min(width, path - lane.start);
    const left = lane.left - lead,
      full = width + lead + tail,
      top = lane.top + height * 0.09,
      tall = height * 0.84;
    const end = lead + reveal + (reveal >= width - 0.5 ? tail : 0);
    band.style.transform = `translate(${left}px, ${top}px) skewX(-8deg)`;
    band.style.width = `${full}px`;
    band.style.height = `${tall}px`;
    band.style.clipPath = `inset(0 ${Math.max(0, full - end).toFixed(1)}px 0 0 round ${(0.14 * em).toFixed(1)}px)`;
    const mask = laneMask(lane, left, pieces, em, time);
    band.style.maskImage = mask;
    band.style.webkitMaskImage = mask;
    const nibWidth = Math.min(nib, end);
    tip.style.transform = `translate(${left + end - nibWidth}px, ${top}px) skewX(-8deg)`;
    tip.style.width = `${nibWidth}px`;
    tip.style.height = `${tall}px`;
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
    layout = useRef<Layout>(undefined),
    // The pen glides after the song's position instead of snapping to it.
    pen = useRef({ path: 0, at: 0, frame: 0 }),
    latest = useRef(time);
  latest.current = time;
  useLayoutEffect(() => {
    const element = root.current,
      sheet = ink.current;
    if (!element || !sheet) return;
    const state = pen.current;
    const step = (now: number) => {
      state.frame = 0;
      const current = (layout.current ??= measure(element, pieces));
      const target = pathAt(element, current, pieces, latest.current);
      const elapsed = Math.min(100, now - (state.at || now));
      state.at = now;
      // A seek back, or a line that is wholly sung or unsung, lands at
      // once; otherwise the pen eases toward the song's position.
      state.path =
        target < state.path - 1 || !Number.isFinite(latest.current)
          ? target
          : state.path + (target - state.path) * (1 - Math.exp(-elapsed / 45));
      paint(sheet, current, pieces, state.path, latest.current);
      if (Math.abs(target - state.path) > 0.3)
        state.frame = requestAnimationFrame(step);
      else state.at = 0;
    };
    cancelAnimationFrame(state.frame);
    step(performance.now());
    return () => cancelAnimationFrame(state.frame);
  }, [pieces, time]);
  // Rows move when the window or text size changes.
  useLayoutEffect(() => {
    const element = root.current;
    if (!element) return;
    const observer = new ResizeObserver(() => {
      if (!ink.current) return;
      layout.current = measure(element, pieces);
      paint(
        ink.current,
        layout.current,
        pieces,
        Math.min(pen.current.path, layout.current.length),
        latest.current,
      );
    });
    observer.observe(element);
    return () => {
      observer.disconnect();
      layout.current = undefined;
    };
  }, [pieces]);
  return (
    <span className="highlighter-words" ref={root}>
      <span className="highlighter-ink" aria-hidden="true" ref={ink} />
      {pieces.map((piece, index) => (
        <span
          key={index}
          className="highlighter-piece"
          style={{ "--ink": inkAt(piece, time) } as CSSProperties}
        >
          {piece.text}
        </span>
      ))}
    </span>
  );
});
