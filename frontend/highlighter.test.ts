import { describe, expect, it } from "vitest";
import {
  highlighterPieces,
  inkAlpha,
  inkAt,
  markerColour,
  restMark,
} from "./highlighter";
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

  it("moves a space before a word onto the word before it", () => {
    const pieces = highlighterPieces(
      line([
        { text: "can't", start_ms: 0, end_ms: 200 },
        { text: " it's", start_ms: 200, end_ms: 400 },
      ]),
    );
    expect(pieces.map((piece) => piece.text)).toEqual(["can't ", "it's"]);
    // A line never starts with a space either.
    expect(
      highlighterPieces(line([{ text: " Hi", start_ms: 0, end_ms: 1 }]))[0]
        .text,
    ).toBe("Hi");
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
    expect(markerColour("red")).toBe("#d4b80f");
  });

  it("lays darker ink where the pen moves slowly", () => {
    expect(inkAlpha(2, 2000)).toBeGreaterThan(inkAlpha(2, 300));
    expect(inkAlpha(2, 20)).toBe(0.5);
    expect(inkAlpha(1, 10_000)).toBeCloseTo(0.78, 1);
  });

  it("leaves a mark that grows while the pen rests in a pause", () => {
    const before = { text: "a ", start_ms: 0, end_ms: 500 },
      after = { text: "b", start_ms: 1500, end_ms: 2000 };
    expect(restMark(before, after, 400)).toBe(0);
    expect(restMark(before, after, 850)).toBeCloseTo(0.5);
    expect(restMark(before, after, Infinity)).toBe(1);
    // Words sung back to back leave no mark.
    expect(restMark(before, { ...after, start_ms: 520 }, Infinity)).toBe(0);
  });
});
