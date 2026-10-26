import { memo, useMemo, type CSSProperties } from "react";
import type { Line } from "./types";

/* Highlighter: a lyrics player where a marker pen sweeps behind each line
 * as it is sung, row by row. Each word's stroke is skewed and overlaps
 * its neighbours, so a row reads as one stroke with slanted ends. Timed syllables set the pace; a line without them is shared out
 * over its words by letter count. */

/** Marker colours to pick from; dark enough for white lyrics on top. */
export const MARKER_COLOURS = [
  ["#7d6f08", "Yellow"],
  ["#8a4a10", "Orange"],
  ["#8a2a5c", "Pink"],
  ["#5b3290", "Purple"],
  ["#24508f", "Blue"],
  ["#1f7a3a", "Green"],
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

/** One line's words with the marker drawn up to `time`. Lines that are not
 *  being sung pass a fixed time, so they skip re-rendering each frame. */
export const HighlighterWords = memo(function HighlighterWords({
  line,
  time,
}: {
  line: Line;
  time: number;
}) {
  const pieces = useMemo(() => highlighterPieces(line), [line]);
  return (
    <span className="highlighter-words">
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
