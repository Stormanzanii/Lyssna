import { describe, expect, it } from "vitest";
import { highlighterPieces, inkAt, markerColour } from "./highlighter";
import type { Line } from "./types";

const line = (words: Line["words"], text = ""): Line => ({
  text,
  start_ms: 0,
  end_ms: 1000,
  translation: "",
  romanization: "",
  background: false,
  opposite: false,
  words,
});

describe("highlighter", () => {
  it("follows timed syllables", () => {
    const pieces = highlighterPieces(
      line([
        { text: "Hel", start_ms: 0, end_ms: 200 },
        { text: "lo ", start_ms: 200, end_ms: 400 },
      ]),
    );
    expect(pieces.map((piece) => piece.text)).toEqual(["Hel", "lo "]);
    expect(inkAt(pieces[0], 100)).toBeCloseTo(0.5);
    expect(inkAt(pieces[1], 100)).toBe(0);
    expect(inkAt(pieces[1], 900)).toBe(1);
  });

  it("shares an untimed line over its words by letters", () => {
    const pieces = highlighterPieces(line([], "a bbb"));
    expect(pieces.map((piece) => piece.text)).toEqual(["a ", "bbb"]);
    expect(pieces[0].end_ms).toBeCloseTo(250);
    expect(pieces[1].end_ms).toBeCloseTo(1000);
  });

  it("turns a saved colour into CSS", () => {
    expect(markerColour("#1f7a3a")).toBe("#1f7a3a");
    expect(markerColour("cover")).toContain("--lyrics-cover-color");
    expect(markerColour("red")).toBe("#7d6f08");
  });
});
