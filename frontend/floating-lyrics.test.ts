import { it, expect } from "vitest";
import { prepareFloatingWords, visibleFloatingWords } from "./floating-lyrics";
import type { Lyrics } from "./types";
it("bounds floating words and samples the same layout after pause or backward seeking", () => {
  const lyrics: Lyrics = {
    source: "test",
    synced: true,
    instrumental: false,
    lines: [
      {
        start_ms: 0,
        end_ms: 10000,
        text: "",
        translation: "",
        romanization: "",
        background: false,
        opposite: false,
        words: Array.from({ length: 100 }, (_, index) => ({
          text: ` word${index}`,
          start_ms: index * 90,
          end_ms: (index + 1) * 90,
        })),
      },
    ],
  };
  const groups = prepareFloatingWords(lyrics),
    before = visibleFloatingWords(groups, 6000);
  expect(before).toHaveLength(36);
  expect(visibleFloatingWords(groups, 6000)).toEqual(before);
  expect(visibleFloatingWords(groups, 1000)[0].text).toBe("word0");
  expect(visibleFloatingWords(groups, 30000)).toHaveLength(0);
});
