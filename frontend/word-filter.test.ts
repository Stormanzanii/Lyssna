import { describe, expect, it } from "vitest";
import { filterWords } from "./word-filter";
import type { Lyrics } from "./types";

const lyrics: Lyrics = {
  source: "test",
  synced: true,
  instrumental: false,
  lines: [
    {
      text: "Hello World",
      start_ms: 0,
      end_ms: 1000,
      translation: "Bonjour",
      romanization: "",
      background: false,
      opposite: false,
      words: [
        { text: "Hello ", start_ms: 0, end_ms: 500 },
        { text: "World", start_ms: 500, end_ms: 1000 },
      ],
    },
  ],
};

describe("unique word filters", () => {
  it("leaves lyrics alone when off", () => {
    expect(filterWords(lyrics, "off")).toBe(lyrics);
    expect(filterWords(undefined, "upper")).toBeUndefined();
  });

  it("changes the case of lines and words but not translations", () => {
    const upper = filterWords(lyrics, "upper");
    expect(upper.lines[0].text).toBe("HELLO WORLD");
    expect(upper.lines[0].words.map((word) => word.text)).toEqual([
      "HELLO ",
      "WORLD",
    ]);
    expect(upper.lines[0].translation).toBe("Bonjour");
    expect(upper.lines[0].words[1].start_ms).toBe(500);
    expect(filterWords(lyrics, "lower").lines[0].text).toBe("hello world");
  });

  it("respells timed words as gibberish and keeps their timing", () => {
    const gibberish = filterWords(lyrics, "gibberish");
    expect(gibberish.lines[0].words.map((word) => word.text).join("")).toBe(
      gibberish.lines[0].text,
    );
    expect(gibberish.lines[0].text).not.toContain(" ");
    expect(gibberish.lines[0].words[1].start_ms).toBe(500);
    expect(gibberish.lines[0].translation).toBe("Bonjour");
    expect(filterWords(gibberish, "gibberish")).toBe(
      filterWords(gibberish, "gibberish"),
    );
  });

  it("returns the same object for the same lyrics and filter", () => {
    expect(filterWords(lyrics, "upper")).toBe(filterWords(lyrics, "upper"));
    expect(filterWords(lyrics, "upper")).not.toBe(filterWords(lyrics, "lower"));
  });
});
