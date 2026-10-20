import { describe, expect, it } from "vitest";
import {
  convertToWordSync,
  displayLyrics,
  distribute,
  effectiveLineEnd,
  needsWordSync,
  splitUnits,
} from "./word-sync";
import type { Line, Lyrics } from "./types";

const line = (text: string, start: number, end: number): Line => ({
  start_ms: start,
  end_ms: end,
  text,
  translation: "",
  romanization: "",
  words: [],
  background: false,
  opposite: false,
});
const lyrics = (...lines: Line[]): Lyrics => ({
  lines,
  source: "test",
  instrumental: false,
  synced: true,
});

describe("word sync", () => {
  it("splits time across words by letter weight", () => {
    const [converted] = convertToWordSync(
      lyrics(line("I love everything", 0, 1600)),
    ).lines;
    expect(converted.words.map((word) => word.text)).toEqual([
      "I",
      " love",
      " everything",
    ]);
    expect(converted.words[0].start_ms).toBe(0);
    expect(converted.words.at(-1)!.end_ms).toBe(1600);
    const durations = converted.words.map(
      (word) => word.end_ms - word.start_ms,
    );
    expect(durations[2]).toBeGreaterThan(durations[1]);
    expect(durations[1]).toBeGreaterThan(durations[0]);
    expect(converted.words.every((word) => word.estimated)).toBe(true);
  });

  it("turns bracketed parts into background vocals after their line", () => {
    const converted = convertToWordSync(
      lyrics(line("Hold on (hold on)", 1000, 3000)),
    );
    expect(converted.lines.map((item) => [item.text, item.background])).toEqual(
      [
        ["Hold on", false],
        ["Hold on", true],
      ],
    );
    expect(converted.estimated_words).toBe(true);
  });

  it("attaches a bracketed-only line to the line before it", () => {
    const converted = convertToWordSync(
      lyrics(
        line("Say my name", 0, 1000),
        line("(say it)", 1000, 1500),
        line("Every night", 1500, 2500),
      ),
    );
    expect(converted.lines.map((item) => item.background)).toEqual([
      false,
      true,
      false,
    ]);
  });

  it("trims a line that runs into the next far past its words", () => {
    const lines = [line("Go", 0, 9000), line("Next line", 9000, 10000)];
    expect(effectiveLineEnd(lines, 0)).toBeLessThan(2000);
    // A real gap before the next line is kept as authored.
    const gapped = [line("Go", 0, 9000), line("Next", 9500, 10000)];
    expect(effectiveLineEnd(gapped, 0)).toBe(9000);
  });

  it("keeps hyphen parts joined and splits connected CJK text", () => {
    expect(splitUnits("na-na-na")).toEqual([
      { text: "na-", partOfWord: true },
      { text: "na-", partOfWord: true },
      { text: "na", partOfWord: false },
    ]);
    expect(splitUnits("私の証").length).toBeGreaterThan(1);
  });

  it("only converts line-synced lyrics and caches the result", () => {
    const worded = lyrics({
      ...line("Hi", 0, 500),
      words: [{ text: "Hi", start_ms: 0, end_ms: 500 }],
    });
    expect(needsWordSync(worded)).toBe(false);
    expect(displayLyrics(worded, true)).toBe(worded);
    const plain = lyrics(line("Hello there", 0, 1000));
    expect(displayLyrics(plain, false)).toBe(plain);
    expect(displayLyrics(plain, true)).toBe(displayLyrics(plain, true));
    expect(needsWordSync({ ...plain, synced: false })).toBe(false);
  });

  it("distributes the remainder to the last part", () => {
    expect(distribute(0, 1000, [1, 1, 1]).at(-1)!.end).toBe(1000);
  });
});
