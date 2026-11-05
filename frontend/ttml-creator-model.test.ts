import { describe, expect, it } from "vitest";
import {
  breakLine,
  duplicateLine,
  editUnit,
  formatTime,
  fromLyrics,
  insertLines,
  keepTimings,
  markEnd,
  markNext,
  markStart,
  moveLine,
  moveSpace,
  moveWord,
  nextCursor,
  parseText,
  problems,
  applyRomanized,
  romanizeRequest,
  setLineText,
  setUnitRoman,
  splitMatching,
  splitUnit,
  toLyrics,
  toText,
  toTtml,
  toggleJoin,
} from "./ttml-creator-model";
import { romanizeLyrics } from "./romanization";
import type { Lyrics } from "./types";

const meta = { name: "Song & <Co>", artists: ["A", "B"], spotifyId: "abc" };

function timeAll(text: string) {
  let lines = markStart(parseText(text), { line: 0, unit: 0 }, 1000);
  let cursor = { line: 0, unit: 0 };
  let time = 1400;
  while (nextCursor(lines, cursor)) {
    ({ lines, cursor } = markNext(lines, cursor, time));
    time += 400;
  }
  return markEnd(lines, cursor, time).lines;
}

describe("TTML Creator model", () => {
  it("reads syllables, background vocals and the second singer from text", () => {
    const lines = parseText("beau|ti|ful day\n(oh yeah)\nv2: other  side\n\n");
    expect(lines).toHaveLength(3);
    expect(lines[0].units.map((unit) => [unit.text, unit.joined])).toEqual([
      ["beau", false],
      ["ti", true],
      ["ful", true],
      ["day", false],
    ]);
    expect(lines[1]).toMatchObject({ background: true, opposite: false });
    expect(lines[2]).toMatchObject({ background: false, opposite: true });
    expect(parseText(toText(lines))).toEqual(lines);
  });

  it("taps start, chain and end words in order", () => {
    let lines = parseText("one two\nthree");
    lines = markStart(lines, { line: 0, unit: 0 }, 100);
    let step = markNext(lines, { line: 0, unit: 0 }, 300);
    expect(step.cursor).toEqual({ line: 0, unit: 1 });
    expect(step.lines[0].units[1].start).toBe(300);
    step = markEnd(step.lines, step.cursor, 500);
    expect(step.cursor).toEqual({ line: 1, unit: 0 });
    expect(step.lines[0].units.map((unit) => [unit.start, unit.end])).toEqual([
      [100, 300],
      [300, 500],
    ]);
    expect(step.lines[1].units[0].start).toBeUndefined();
  });

  it("a fresh start drops an end that would come before it", () => {
    let lines = markEnd(parseText("word"), { line: 0, unit: 0 }, 900).lines;
    lines = markStart(lines, { line: 0, unit: 0 }, 1200);
    expect(lines[0].units[0]).toMatchObject({ start: 1200, end: undefined });
  });

  it("editing text keeps timings of unchanged lines", () => {
    const timedLines = timeAll("keep me\nchange me");
    const edited = keepTimings(timedLines, parseText("keep me\nchanged me"));
    expect(edited[0].units[0].start).toBe(1000);
    expect(edited[1].units[0].start).toBeUndefined();
  });

  it("exports TTML with escaped text, word spacing and nested background", () => {
    const lines = timeAll("Rock & roll|ing\n(back)");
    expect(problems(lines)).toEqual([]);
    const ttml = toTtml(lines, meta);
    expect(ttml).toContain('itunes:timing="Word"');
    expect(ttml).toContain(
      '<amll:meta key="musicName" value="Song &amp; &lt;Co&gt;"/>',
    );
    expect(ttml).toContain('<amll:meta key="spotifyId" value="abc"/>');
    expect(ttml).toContain(
      '<span begin="00:01.000" end="00:01.400">Rock</span> <span begin="00:01.400" end="00:01.800">&amp;</span> <span begin="00:01.800" end="00:02.200">roll</span><span begin="00:02.200" end="00:02.600">ing</span>',
    );
    expect(ttml).toContain('<span ttm:role="x-bg" begin="00:02.600"');
    expect(ttml.match(/<p /g)).toHaveLength(1);
  });

  it("previews only timed words, with spaces between words", () => {
    const lines = timeAll("a b|c");
    const preview = toLyrics(lines);
    expect(preview.lines[0].words.map((word) => word.text)).toEqual([
      "a",
      " b",
      "c",
    ]);
    expect(preview.lines[0].text).toBe("a bc");
    expect(toLyrics(parseText("untimed")).lines).toEqual([]);
  });

  it("starts from shown lyrics, keeping authored word timing only", () => {
    const lyrics: Lyrics = {
      source: "x",
      instrumental: false,
      synced: true,
      lines: [
        {
          start_ms: 0,
          end_ms: 900,
          text: "hello world",
          translation: "",
          romanization: "",
          background: false,
          opposite: true,
          words: [
            { start_ms: 0, end_ms: 400, text: "hel" },
            { start_ms: 400, end_ms: 500, text: "lo" },
            { start_ms: 500, end_ms: 900, text: " world" },
          ],
        },
        {
          start_ms: 900,
          end_ms: 1500,
          text: "guessed words",
          translation: "",
          romanization: "",
          background: false,
          opposite: false,
          words: [
            {
              start_ms: 900,
              end_ms: 1500,
              text: "guessed words",
              estimated: true,
            },
          ],
        },
      ],
    };
    const lines = fromLyrics(lyrics);
    expect(lines[0]).toMatchObject({ opposite: true });
    expect(
      lines[0].units.map((unit) => [unit.text, unit.joined, unit.start]),
    ).toEqual([
      ["hel", false, 0],
      ["lo", true, 400],
      ["world", false, 500],
    ]);
    expect(lines[1].units.map((unit) => [unit.start, unit.end])).toEqual([
      [900, undefined],
      [undefined, 1500],
    ]);
  });

  it("keeps real line times on a line's edges and leaves static lyrics untimed", () => {
    const line = {
      start_ms: 2000,
      end_ms: 3500,
      text: "line synced words",
      translation: "",
      romanization: "",
      background: false,
      opposite: false,
      words: [],
    };
    const edges = (lyrics: Lyrics) =>
      fromLyrics(lyrics)[0].units.map((unit) => [unit.start, unit.end]);
    const lyrics: Lyrics = {
      source: "x",
      instrumental: false,
      synced: true,
      lines: [line],
    };
    expect(edges(lyrics)).toEqual([
      [2000, undefined],
      [undefined, undefined],
      [undefined, 3500],
    ]);
    const untimed = [
      [undefined, undefined],
      [undefined, undefined],
      [undefined, undefined],
    ];
    expect(edges({ ...lyrics, synced: false })).toEqual(untimed);
    expect(edges({ ...lyrics, estimated_lines: true })).toEqual(untimed);
  });

  it("formats times and reports untimed words", () => {
    expect(formatTime(61_234.4)).toBe("01:01.234");
    expect(problems(parseText("a b"))).toEqual([
      "2 of 2 words have no timing yet.",
    ]);
  });
});

describe("TTML Creator card editing", () => {
  const words = (lines: ReturnType<typeof parseText>) =>
    lines.map((line) => toText([line]));

  it("edits, splits and deletes words, keeping timing on a plain rename", () => {
    let lines = timeAll("one two");
    lines = editUnit(lines, { line: 0, unit: 1 }, "too");
    expect(lines[0].units[1]).toMatchObject({ text: "too", start: 1400 });
    lines = editUnit(lines, { line: 0, unit: 1 }, "t|o o");
    expect(words(lines)).toEqual(["one t|o o"]);
    expect(lines[0].units[1].start).toBeUndefined();
    lines = editUnit(lines, { line: 0, unit: 0 }, "");
    expect(words(lines)).toEqual(["t|o o"]);
    expect(editUnit(parseText("x"), { line: 0, unit: 0 }, " ")).toEqual([]);
  });

  it("joins words, inserts lines and exports translations", () => {
    let lines = toggleJoin(parseText("a b"), { line: 0, unit: 1 });
    expect(words(lines)).toEqual(["a|b"]);
    lines = insertLines(timeAll("first\nlast"), 0, "mid one\n(bg)");
    expect(words(lines)).toEqual(["first", "mid one", "(bg)", "last"]);
    lines = setLineText(timeAll("hola"), 0, "translation", "hello");
    lines = setLineText(lines, 0, "romanization", "");
    expect(lines[0].romanization).toBeUndefined();
    expect(toTtml(lines, meta)).toContain(
      '<span ttm:role="x-translation">hello</span></p>',
    );
    expect(toLyrics(lines).lines[0].translation).toBe("hello");
    expect(keepTimings(lines, parseText("hola"))[0].translation).toBe("hello");
  });

  it("keeps word romanization through export, import and auto fill", () => {
    let lines = timeAll("未完 成");
    expect(lines[0].units.map((unit) => unit.text)).toEqual(["未", "完", "成"]);
    lines = setUnitRoman(lines, { line: 0, unit: 0 }, " mi ");
    lines = setUnitRoman(lines, { line: 0, unit: 1 }, "kan");
    lines = setUnitRoman(lines, { line: 0, unit: 2 }, "sei");
    expect(toLyrics(lines).lines[0].romanization).toBe("mi kan sei");
    const ttml = toTtml(lines, meta);
    expect(ttml).toContain('<text for="L1"><span begin=');
    expect(ttml).toContain(">mi</span><span");
    expect(ttml).toContain(">kan</span> <span");
    expect(ttml).not.toContain("x-roman");
    expect(
      fromLyrics(toLyrics(lines))[0].units.map((unit) => unit.roman),
    ).toEqual(["mi", "kan", "sei"]);
    expect(keepTimings(lines, parseText("未完 成"))[0].units[2].roman).toBe(
      "sei",
    );

    const blank = timeAll("мир hi да");
    const request = romanizeRequest(blank);
    const result = romanizeRequest(parseText("mir hi da"));
    const filled = applyRomanized(
      setUnitRoman(blank, { line: 0, unit: 2 }, "mine"),
      request,
      result,
    );
    expect(filled[0].units.map((unit) => unit.roman)).toEqual([
      "mir",
      undefined,
      "mine",
    ]);
    const edited = editUnit(blank, { line: 0, unit: 0 }, "мой");
    expect(applyRomanized(edited, request, result)[0].units[0].roman).toBe(
      undefined,
    );
  });

  it("auto romanizes words in any non-Latin script", async () => {
    const lines = parseText(
      "مرحبا สวัสดี नमस्ते שלום გამარჯობა 안녕 привет hi",
    );
    const request = romanizeRequest(lines);
    const filled = applyRomanized(
      lines,
      request,
      await romanizeLyrics(request),
    );
    const readings = filled[0].units.map((unit) => unit.roman);
    expect(readings.at(-1)).toBeUndefined();
    for (const reading of readings.slice(0, -1))
      expect(reading).toMatch(/^[ -~]+$/);
  });

  it("moves lines, whole words and spaces", () => {
    const lines = parseText("a\nb\nc");
    expect(words(moveLine(lines, 0, 3))).toEqual(["b", "c", "a"]);
    expect(words(moveLine(lines, 2, 0))).toEqual(["c", "a", "b"]);
    expect(moveLine(lines, 1, 2)).toBe(lines);
    const song = parseText("one t|wo three\nfour");
    expect(
      words(moveWord(song, { line: 0, unit: 2 }, { line: 0, unit: 4 })),
    ).toEqual(["one three t|wo", "four"]);
    expect(
      words(moveWord(song, { line: 0, unit: 3 }, { line: 0, unit: 0 })),
    ).toEqual(["three one t|wo", "four"]);
    expect(
      words(moveWord(song, { line: 1, unit: 0 }, { line: 0, unit: 1 })),
    ).toEqual(["one four t|wo three"]);
    expect(moveWord(song, { line: 0, unit: 1 }, { line: 0, unit: 3 })).toBe(
      song,
    );
    expect(
      words(moveSpace(song, { line: 0, unit: 1 }, { line: 0, unit: 2 })),
    ).toEqual(["one|t wo three", "four"]);
    expect(moveSpace(song, { line: 0, unit: 1 }, { line: 0, unit: 3 })).toBe(
      song,
    );
  });
});

describe("TTML Creator word menu", () => {
  it("splits a timed word evenly and an untimed one keeps its edges", () => {
    const lines = splitUnit(timeAll("go now"), { line: 0, unit: 0 }, [
      "g",
      "o",
    ]);
    expect(
      lines[0].units.map((unit) => [
        unit.text,
        unit.joined,
        unit.start,
        unit.end,
      ]),
    ).toEqual([
      ["g", false, 1000, 1200],
      ["o", true, 1200, 1400],
      ["now", false, 1400, 1800],
    ]);
    const started = markStart(parseText("abc"), { line: 0, unit: 0 }, 50);
    expect(
      splitUnit(started, { line: 0, unit: 0 }, ["a", "bc"])[0].units.map(
        (unit) => [unit.start, unit.end],
      ),
    ).toEqual([
      [50, undefined],
      [undefined, undefined],
    ]);
  });

  it("splits every matching word, optionally ignoring case", () => {
    const lines = parseText("Baby baby BABY");
    const cut = (text: string) => [text.slice(0, 2), text.slice(2)];
    expect(toText(splitMatching(lines, "baby", cut, false))).toBe(
      "Baby ba|by BABY",
    );
    expect(toText(splitMatching(lines, "baby", cut, true))).toBe(
      "Ba|by ba|by BA|BY",
    );
  });

  it("moves words to a new line and duplicates lines", () => {
    const lines = parseText("(one two|x three)");
    expect(toText(breakLine(lines, { line: 0, unit: 1 }, false))).toBe(
      "(one)\n(two|x three)",
    );
    expect(toText(breakLine(lines, { line: 0, unit: 3 }, true))).toBe(
      "(one two|x)\n(three)",
    );
    expect(breakLine(lines, { line: 0, unit: 0 }, false)).toBe(lines);
    expect(toText(duplicateLine(parseText("a\nb"), 0))).toBe("a\na\nb");
  });
});
