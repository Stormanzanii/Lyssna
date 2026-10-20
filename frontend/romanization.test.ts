import { expect, it } from "vitest";
import { displayLyrics } from "./word-sync";
import type { Lyrics } from "./types";

function sample(text: string, romanization = ""): Lyrics {
  return {
    source: "test",
    synced: true,
    instrumental: false,
    lines: [
      {
        text,
        romanization,
        translation: "Translation",
        start_ms: 1000,
        end_ms: 3000,
        words: [{ text, start_ms: 1000, end_ms: 3000 }],
        background: false,
        opposite: true,
      },
    ],
  };
}

it("replaces main lyric text with supplied readings without mutating the original", () => {
  const source = sample("東京", "Tokyo");
  const original = structuredClone(source);
  const display = displayLyrics(source, false, true);
  expect(display.lines[0].text).toBe("Tokyo");
  expect(display.lines[0].words.map((word) => word.text).join("")).toBe(
    "Tokyo",
  );
  expect(display.lines[0].translation).toBe("Translation");
  expect(display.lines[0].opposite).toBe(true);
  expect(source).toEqual(original);
  expect(displayLyrics(source, false, false)).toBe(source);
  expect(displayLyrics(source, false, true)).toBe(display);
});

it.each([
  "안녕하세요",
  "こんにちは",
  "你好",
  "Привет",
  "Γεια",
  "مرحبا",
  "שלום",
  "नमस्ते",
  "বাংলা",
  "สวัสดี",
  "ქართული",
  "Հայերեն",
])("romanizes %s without supplied readings", (text) => {
  const display = displayLyrics(sample(text), false, true);
  expect(display.lines[0].text).not.toBe(text);
  expect(display.lines[0].text).toMatch(/[a-z]/i);
  expect(display.lines[0].text).toMatch(
    /^[\p{Script=Latin}\p{Script=Common}]+$/u,
  );
  expect(display.lines[0].words[0].start_ms).toBe(1000);
  expect(display.lines[0].words[0].end_ms).toBe(3000);
});

it("keeps Latin text, punctuation and unsupported symbols intact", () => {
  expect(
    displayLyrics(sample("Café, déjà vu! 🎵"), false, true).lines[0].text,
  ).toBe("Café, déjà vu! 🎵");
});

it("retains authored group timing for matching supplied words", () => {
  const source = sample("東京 です", "Tokyo desu");
  source.lines[0].words = [
    { text: "東京", start_ms: 1000, end_ms: 1600 },
    { text: " です", start_ms: 1800, end_ms: 3000 },
  ];
  const words = displayLyrics(source, false, true).lines[0].words;
  expect(words.map((word) => [word.text, word.start_ms, word.end_ms])).toEqual([
    ["Tokyo", 1000, 1600],
    [" desu", 1800, 3000],
  ]);
});

it("romanizes line-synced text before estimating words for Space Gravity", () => {
  const source = sample("안녕하세요", "annyeonghaseyo");
  source.lines[0].words = [];
  const display = displayLyrics(source, true, true);
  expect(display.lines[0].text).toBe("annyeonghaseyo");
  expect(display.lines[0].words.length).toBeGreaterThan(0);
  expect(display.estimated_words).toBe(true);
});

it("marks unmatched romanized word timing estimated while retaining the source interval", () => {
  const source = sample("안녕하세요", "hello friend");
  const display = displayLyrics(source, false, true);
  const words = display.lines[0].words;
  expect(display.estimated_words).toBe(true);
  expect(words.every((word) => word.estimated)).toBe(true);
  expect(words[0].start_ms).toBe(1000);
  expect(words.at(-1)!.end_ms).toBe(3000);
  expect(words[0].end_ms).toBe(words[1].start_ms);
});

it("keeps an unconvertible run visible instead of dropping the lyric", () => {
  const source = sample("𒀀");
  expect(displayLyrics(source, false, true).lines[0].text).toBe(
    source.lines[0].text,
  );
});
