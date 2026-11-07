import { describe, expect, it } from "vitest";
import type { CreatorLine } from "./ttml-creator-model";
import { WORD_FORMATS, exportLyrics, parseWordFormat } from "./ttml-formats";

const lines: CreatorLine[] = [
  {
    background: false,
    opposite: false,
    units: [
      { text: "For", joined: false, start: 1000, end: 1300 },
      { text: "ev", joined: false, start: 1300, end: 1500 },
      { text: "er", joined: true, start: 1500, end: 1900 },
    ],
  },
  {
    background: true,
    opposite: true,
    units: [{ text: "ooh", joined: false, start: 2000, end: 2600 }],
  },
];

describe("TTML Creator word formats", () => {
  it.each(WORD_FORMATS)("%s keeps words, syllables and timing", (format) => {
    const back = parseWordFormat(format, exportLyrics(format, lines));
    expect(back.map((line) => line.units)).toEqual(
      lines.map((line) => line.units),
    );
    expect(back[1].background).toBe(true);
    if (format === "lys") expect(back[1].opposite).toBe(true);
  });

  it("writes the shapes AMLL documents", () => {
    expect(exportLyrics("qrc", lines).split("\n")[0]).toBe(
      "[1000,900]For (1000,300)ev(1300,200)er(1500,400)",
    );
    expect(exportLyrics("yrc", lines).split("\n")[0]).toBe(
      "[1000,900](1000,300,0)For (1300,200,0)ev(1500,400,0)er",
    );
    expect(exportLyrics("lys", lines).split("\n")[1]).toBe(
      "[8](ooh)(2000,600)",
    );
    expect(exportLyrics("eslrc", lines).split("\n")[0]).toBe(
      "[00:01.00]For [00:01.30]ev[00:01.50]er[00:01.90]",
    );
    expect(exportLyrics("lrc", lines)).toBe(
      "[00:01.00]For ever\n[00:02.00](ooh)",
    );
  });

  it("reads QRC inside QQ Music's XML wrapper", () => {
    const xml =
      '<?xml version="1.0"?><QrcInfos><LyricInfo><Lyric_1 LyricType="1" LyricContent="[ti:x]&#10;[500,400]Hi (500,200)there(700,200)&#10;"/></LyricInfo></QrcInfos>'.replace(
        /&#10;/g,
        "\n",
      );
    const back = parseWordFormat("qrc", xml);
    expect(back[0].units.map((unit) => unit.text)).toEqual(["Hi", "there"]);
  });
});
