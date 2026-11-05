import { describe, expect, it } from "vitest";
import {
  formatTime,
  fromLyrics,
  keepTimings,
  markEnd,
  markNext,
  markStart,
  nextCursor,
  parseText,
  problems,
  toLyrics,
  toText,
  toTtml,
} from "./ttml-creator-model";
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
    expect(lines[1].units.map((unit) => unit.start)).toEqual([
      undefined,
      undefined,
    ]);
  });

  it("formats times and reports untimed words", () => {
    expect(formatTime(61_234.4)).toBe("01:01.234");
    expect(problems(parseText("a b"))).toEqual([
      "2 of 2 words have no timing yet.",
    ]);
  });
});
