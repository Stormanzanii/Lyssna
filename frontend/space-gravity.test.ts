import { describe, expect, it } from "vitest";
import {
  constrain,
  createBody,
  GRAVITY,
  gravityPieces,
  intersects,
  lineLayout,
  measure,
  spawn,
  spawnOverlap,
  speedMultiplier,
  staticLayout,
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
const field = { bounds };
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
    constrain(word, field);
    expect(word.x).toBeGreaterThanOrEqual(GRAVITY.edgePadding + word.radius);
    expect(word.y).toBeLessThanOrEqual(
      bounds.height - GRAVITY.edgePadding - word.radius,
    );
    const art = { left: 0, top: 100, right: 380, bottom: 500 };
    const inside = body(2);
    inside.x = 300;
    inside.y = 300;
    constrain(inside, { bounds, cover: art });
    expect(intersects(inside, art)).toBe(false);
    // The credits footer is a floor: words leave it upward or sideways.
    const footer = { left: 0, top: 520, right: 800, bottom: 600 };
    const low = body(3);
    low.y = 560;
    constrain(low, { bounds, footer });
    expect(low.y).toBeCloseTo(520 - low.radius);
    // A play area keeps words inside it.
    const area = { left: 400, top: 0, right: 800, bottom: 600 };
    const left = body(4);
    left.x = 100;
    constrain(left, { bounds, area });
    expect(left.x).toBeGreaterThanOrEqual(400 + left.radius);
  });

  it("stays finite and in bounds over many steps", () => {
    const words = Array.from({ length: 20 }, (_, index) => body(index));
    for (let frame = 0; frame < 600; frame += 1)
      step(words, 1 / 60, {
        bounds,
        cover: { left: 0, top: 0, right: 300, bottom: 600 },
      });
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
    step([word], 0.05, field, { vx: 500, vy: 0 });
    expect(word.vx).toBeLessThan(0);
  });

  it("sizes the word window from the free area", () => {
    expect(visibleWordCount({ bounds: { width: 100, height: 100 } })).toBe(
      GRAVITY.minVisibleWords,
    );
    expect(visibleWordCount({ bounds: { width: 4000, height: 4000 } })).toBe(
      GRAVITY.maxVisibleWords,
    );
    // Artwork in the play area leaves room for fewer words.
    const open = visibleWordCount({ bounds: { width: 1600, height: 1000 } });
    const covered = visibleWordCount({
      bounds: { width: 1600, height: 1000 },
      cover: { left: 0, top: 0, right: 800, bottom: 1000 },
    });
    expect(covered).toBeLessThan(open);
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

describe("Space Gravity spawning", () => {
  it("lays a line out in rows across the area, duets at the right", () => {
    const sizes = [
      { width: 100, height: 40 },
      { width: 100, height: 40 },
      { width: 100, height: 40 },
    ];
    const left = lineLayout(sizes, 250);
    expect(left.places.map((place) => place.x)).toEqual([50, 150, 50]);
    expect(left.height).toBe(80);
    const right = lineLayout(sizes.slice(0, 1), 250, true);
    expect(right.places[0].x).toBe(200);
  });

  it("spreads a line out with gaps, centred, over a canvas", () => {
    const sizes = [
      { width: 100, height: 40 },
      { width: 100, height: 40 },
      { width: 100, height: 40 },
    ];
    const spread = lineLayout(sizes, 300, false, 44);
    // Two words and a gap fit a row, centred in the 300 px width.
    expect(spread.places.map((place) => place.x)).toEqual([78, 222, 150]);
    expect(spread.places[2].y - spread.places[0].y).toBe(84);
    expect(spread.height).toBe(124);
  });

  it("finds room beside words already on screen", () => {
    const first = body(1);
    first.naturalX = first.x = 400;
    first.naturalY = first.y = 300;
    const second = body(2);
    second.naturalX = 400;
    second.naturalY = 300;
    spawn(second, [first], field, false, () => 0.5);
    expect(spawnOverlap(second, first)).toBe(0);
  });

  it("spawns beside artwork only in the lyrics column", () => {
    const column = { left: 500, top: 0, right: 1000, bottom: 600 };
    const beside = {
      ...field,
      area: { left: 0, top: 0, right: 1000, bottom: 600 },
      layout: column,
      cover: { left: 100, top: 150, right: 400, bottom: 450 },
    };
    const crowd = Array.from({ length: 12 }, (_, index) => {
      const word = body(index + 10);
      word.x = 520 + (index % 4) * 120;
      word.y = 100 + Math.floor(index / 4) * 200;
      return word;
    });
    for (let seed = 0; seed < 20; seed += 1) {
      const word = body(seed + 40);
      word.naturalX = 520;
      word.naturalY = 300;
      let state = seed / 20;
      spawn(
        word,
        crowd,
        beside,
        false,
        () => (state = (state * 9301 + 0.49297) % 1),
      );
      expect(word.x - word.radius).toBeGreaterThanOrEqual(column.left - 0.5);
    }
  });

  it("centres lines in still rows under reduced motion", () => {
    const words = [body(1), body(2)];
    staticLayout([words], field);
    expect(words[0].y).toBe(words[1].y);
    expect(words[1].x - words[0].x).toBe(86);
    expect(words.every((word) => word.angle === 0)).toBe(true);
  });
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
