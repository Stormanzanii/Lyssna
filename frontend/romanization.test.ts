import { expect, it, vi } from "vitest";
import {
  romanizeGreek,
  romanizeKorean,
  romanizeLyrics,
  songScripts,
} from "./romanization";
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

/** Lyrics as shown once romanization has converted them. */
async function shown(source: Lyrics, wordSync = false) {
  displayLyrics(source, wordSync, true);
  await romanizeLyrics(source);
  await vi.waitFor(() => {
    const display = displayLyrics(source, wordSync, true);
    if (display === displayLyrics(source, wordSync, false))
      throw new Error("not converted yet");
  });
  return displayLyrics(source, wordSync, true);
}

it("replaces main lyric text with supplied readings without mutating the original", async () => {
  const source = sample("東京", "Tokyo");
  const original = structuredClone(source);
  const display = await shown(source);
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
])("romanizes %s without supplied readings", async (text) => {
  const display = await romanizeLyrics(sample(text));
  expect(display.lines[0].text).not.toBe(text);
  expect(display.lines[0].text).toMatch(/[a-z]/i);
  expect(display.lines[0].text).toMatch(
    /^[\p{Script=Latin}\p{Script=Common}]+$/u,
  );
  expect(display.lines[0].words[0].start_ms).toBe(1000);
  expect(display.lines[0].words[0].end_ms).toBe(3000);
});

it("keeps Latin text, punctuation and unsupported symbols intact", async () => {
  expect(
    (await romanizeLyrics(sample("Café, déjà vu! 🎵"))).lines[0].text,
  ).toBe("Café, déjà vu! 🎵");
});

it("reads each script the way Spicy Lyrics does", async () => {
  expect(romanizeKorean("안녕하세요")).toBe("annyeonghaseyo");
  expect(romanizeGreek("Γεια σου")).toBe("Geia sou");
  expect((await romanizeLyrics(sample("你好"))).lines[0].text).toBe("nǐ-hǎo");
  expect((await romanizeLyrics(sample("Привет"))).lines[0].text).toBe("Privet");
});

it("reads kanji as Japanese in a song with kana, as Chinese otherwise", () => {
  expect(songScripts(["東京", "へ行く"])).toEqual(["japanese"]);
  expect(songScripts(["東京"])).toEqual(["chinese"]);
  expect(songScripts(["Д", "안녕"])).toEqual(["korean"]);
  expect(songScripts(["Привет"])).toEqual(["cyrillic"]);
});

it("retains authored group timing for matching supplied words", async () => {
  const source = sample("東京 です", "Tokyo desu");
  source.lines[0].words = [
    { text: "東京", start_ms: 1000, end_ms: 1600 },
    { text: " です", start_ms: 1800, end_ms: 3000 },
  ];
  const words = (await shown(source)).lines[0].words;
  expect(words.map((word) => [word.text, word.start_ms, word.end_ms])).toEqual([
    ["Tokyo", 1000, 1600],
    [" desu", 1800, 3000],
  ]);
});

it("romanizes line-synced text before estimating words for Space Gravity", async () => {
  const source = sample("안녕하세요", "annyeonghaseyo");
  source.lines[0].words = [];
  const display = await shown(source, true);
  expect(display.lines[0].text).toBe("annyeonghaseyo");
  expect(display.lines[0].words.length).toBeGreaterThan(0);
  expect(display.estimated_words).toBe(true);
});

it("marks unmatched romanized word timing estimated while retaining the source interval", async () => {
  const source = sample("안녕하세요", "hello friend");
  const display = await shown(source);
  const words = display.lines[0].words;
  expect(display.estimated_words).toBe(true);
  expect(words.every((word) => word.estimated)).toBe(true);
  expect(words[0].start_ms).toBe(1000);
  expect(words.at(-1)!.end_ms).toBe(3000);
  expect(words[0].end_ms).toBe(words[1].start_ms);
});

it("keeps an unconvertible run visible instead of dropping the lyric", async () => {
  const source = sample("𒀀");
  expect((await romanizeLyrics(source)).lines[0].text).toBe(
    source.lines[0].text,
  );
});
