import { describe, expect, it } from "vitest";
import {
  constrain,
  createBody,
  GRAVITY,
  gravityPieces,
  intersects,
  measure,
  speedMultiplier,
  step,
  visibleWordCount,
  wordWindow,
} from "./space-gravity";
import {
  gravityAnchor,
  gravityRole,
  prepareGravity,
  visibleGravity,
} from "./space-gravity-lyrics";
import type { Line, Lyrics } from "./types";

const bounds = { width: 800, height: 600 };
const body = (seed = 1) => {
  const result = createBody(seed, 1);
  measure(result, 80, 40);
  result.x = 400;
  result.y = 300;
  return result;
};

describe("Space Gravity physics", () => {
  it("is deterministic for a seed and drifts within the speed range", () => {
    const a = createBody(42, 1),
      b = createBody(42, 1);
    expect(a).toEqual(b);
    const speed = Math.hypot(a.vx, a.vy);
    expect(speed).toBeGreaterThanOrEqual(4.4);
    expect(speed).toBeLessThanOrEqual(10);
  });

  it("speeds up fast lines, capped at 1.75x", () => {
    expect(speedMultiplier([0, 2000])).toBe(1);
    expect(
      speedMultiplier(Array.from({ length: 20 }, (_, index) => index * 100)),
    ).toBe(GRAVITY.maxWpmMultiplier);
  });

  it("keeps bodies inside the stage and outside obstacles", () => {
    const word = body();
    word.x = -50;
    word.y = 900;
    constrain(word, bounds, []);
    expect(word.x).toBeGreaterThanOrEqual(GRAVITY.edgePadding + word.radius);
    expect(word.y).toBeLessThanOrEqual(
      bounds.height - GRAVITY.edgePadding - word.radius,
    );
    const art = { left: 0, top: 100, right: 380, bottom: 500 };
    const inside = body(2);
    inside.x = 300;
    inside.y = 300;
    constrain(inside, bounds, [art]);
    expect(intersects(inside, art)).toBe(false);
  });

  it("stays finite and in bounds over many steps", () => {
    const words = Array.from({ length: 20 }, (_, index) => body(index));
    for (let frame = 0; frame < 600; frame += 1)
      step(words, 1 / 60, bounds, [
        { left: 0, top: 0, right: 300, bottom: 600 },
      ]);
    for (const word of words) {
      expect(Number.isFinite(word.x) && Number.isFinite(word.y)).toBe(true);
      expect(word.x).toBeGreaterThan(0);
      expect(word.x).toBeLessThan(bounds.width);
    }
  });

  it("throws words opposite to the window's movement", () => {
    const word = body();
    word.vx = 0;
    word.vy = 0;
    step([word], 0.05, bounds, [], { vx: 500, vy: 0 });
    expect(word.vx).toBeLessThan(0);
  });

  it("sizes the word window from the free area", () => {
    expect(visibleWordCount({ width: 100, height: 100 })).toBe(
      GRAVITY.minVisibleWords,
    );
    expect(visibleWordCount({ width: 4000, height: 4000 })).toBe(
      GRAVITY.maxVisibleWords,
    );
    expect(wordWindow(0, 100, 12)).toEqual({ first: 0, last: 11 });
    expect(wordWindow(99, 100, 12)).toEqual({ first: 88, last: 99 });
    expect(wordWindow(50, 5, 12)).toEqual({ first: 0, last: 4 });
  });
});

const line = (
  text: string[],
  start: number,
  step: number,
  background = false,
): Line => ({
  start_ms: start,
  end_ms: start + text.length * step,
  text: text.join(" "),
  translation: "",
  romanization: "",
  words: text.map((word, index) => ({
    text: `${index ? " " : ""}${word}`,
    start_ms: start + index * step,
    end_ms: start + (index + 1) * step,
  })),
  background,
  opposite: false,
});

describe("Space Gravity word selection", () => {
  const lyrics: Lyrics = {
    source: "test",
    synced: true,
    instrumental: false,
    lines: [
      line(["one", "two", "three"], 0, 500),
      line(["echo"], 500, 500, true),
      line(["four", "five"], 2000, 500),
    ],
  };
  const prepared = prepareGravity(lyrics);

  it("indexes lead words and hangs backing vocals on their line", () => {
    expect(prepared.total).toBe(5);
    const echo = prepared.entities.find((entity) => entity.text === "echo")!;
    expect(echo.background).toBe(true);
    expect(echo.lead).toBe(0);
    expect(echo.index).toBe(-1);
  });

  it("anchors on the sung word, or the next one in a gap", () => {
    expect(gravityAnchor(prepared, 700)).toEqual({ line: 0, word: 1 });
    expect(gravityAnchor(prepared, 1700)).toEqual({ line: 1, word: 3 });
  });

  it("assigns roles by line timing", () => {
    const [first] = prepared.entities;
    expect(gravityRole(first, prepared.leads[0], 200, prepared.finalEnd)).toBe(
      "current",
    );
    const four = prepared.entities.find((entity) => entity.text === "four")!;
    expect(gravityRole(four, prepared.leads[1], 200, prepared.finalEnd)).toBe(
      "next",
    );
    expect(gravityRole(four, prepared.leads[1], 9000, prepared.finalEnd)).toBe(
      "previous",
    );
  });

  it("limits visible words but always keeps the sung line", () => {
    const shown = visibleGravity(prepared, 700, 2);
    expect(shown.map((entity) => entity.text)).toEqual(
      expect.arrayContaining(["one", "two", "three", "echo"]),
    );
    expect(shown.some((entity) => entity.text === "five")).toBe(false);
  });
});

describe("Space Gravity pieces", () => {
  const word = (text: string, start: number, end: number) => ({
    text,
    start_ms: start,
    end_ms: end,
  });
  const strip = (pieces: ReturnType<typeof gravityPieces>) =>
    pieces.map(({ text, start, end }) => ({ text, start, end }));
  it("splits hyphen-joined syllables into separate words", () => {
    expect(
      strip(
        gravityPieces([
          word(" eye-", 0, 100),
          word("eye-", 100, 200),
          word("eyes", 200, 400),
        ]),
      ),
    ).toEqual([
      { text: "eye-", start: 0, end: 100 },
      { text: "eye-", start: 100, end: 200 },
      { text: "eyes", start: 200, end: 400 },
    ]);
  });
  it("splits one hyphenated word and shares its time", () => {
    const pieces = gravityPieces([word("na-na-na", 0, 900)]);
    expect(pieces.map((piece) => piece.text)).toEqual(["na-", "na-", "na"]);
    expect(pieces[0].start).toBe(0);
    expect(pieces.at(-1)!.end).toBe(900);
  });
  it("keeps ordinary split syllables together", () => {
    const [piece] = gravityPieces([word(" Hel", 0, 100), word("lo", 100, 200)]);
    expect(piece.words.map((item) => item.text)).toEqual(["Hel", "lo"]);
    expect(strip([piece])).toEqual([{ text: "Hello", start: 0, end: 200 }]);
  });
  it("keeps held fragments on the original note with their original letter positions", () => {
    const original = Object.freeze(word(" na-na-na", 1000, 3400));
    const pieces = gravityPieces([original]);
    expect(pieces.map((piece) => [piece.start, piece.end])).toEqual([
      [1000, 1900],
      [1900, 2800],
      [2800, 3400],
    ]);
    expect(pieces.map((piece) => piece.words[0])).toEqual([
      {
        text: "na-",
        start_ms: 1000,
        end_ms: 3400,
        letterOffset: 0,
        letterCount: 8,
      },
      {
        text: "na-",
        start_ms: 1000,
        end_ms: 3400,
        letterOffset: 3,
        letterCount: 8,
      },
      {
        text: "na",
        start_ms: 1000,
        end_ms: 3400,
        letterOffset: 6,
        letterCount: 8,
      },
    ]);
  });
  it("keeps estimated pieces timed separately without inventing held letters", () => {
    const pieces = gravityPieces([
      { ...word("na-na-na", 1000, 3400), estimated: true },
    ]);
    for (const piece of pieces) {
      expect(piece.words[0]).toMatchObject({
        start_ms: piece.start,
        end_ms: piece.end,
        estimated: true,
      });
      expect(piece.words[0].letterCount).toBeUndefined();
    }
  });
});
