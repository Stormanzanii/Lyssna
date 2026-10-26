import { describe, expect, it } from "vitest";
import { gibberishLine, gibberishSyllables, gibberishWords } from "./gibberish";
import { GIBBERISH_WORDS } from "./gibberish-dictionary";

describe("gibberish", () => {
  it("carries the fork's whole dictionary", () => {
    expect(GIBBERISH_WORDS.size).toBe(2001);
    expect(GIBBERISH_WORDS.get("beautiful")).toBe("byutifo");
    expect(GIBBERISH_WORDS.get("i'm")).toBe("am");
  });

  it("joins a phrase into one word and keeps its closing mark", () => {
    expect(gibberishLine("I'm in love with you, my dear")).toBe(
      "Amenlufwitu, madia",
    );
    expect(gibberishLine("so beautiful")).not.toContain(" ");
  });

  it("blends t or d into a following y word", () => {
    expect(gibberishWords(["met ", "you"]).join("")).toMatch(/ch/);
    expect(gibberishWords(["did ", "you"]).join("")).toMatch(/j/);
  });

  it("reads curly apostrophes and accents like plain ones", () => {
    expect(gibberishLine("I’m")).toBe(gibberishLine("I'm"));
    expect(gibberishLine("café")).toBe(gibberishLine("cafe"));
  });

  it("falls back to phonetic rules for words it lacks", () => {
    expect(gibberishLine("zorphling")).toBe("zorflin");
  });

  it("leaves words with no Latin letters as written", () => {
    expect(gibberishLine("夜に駆ける")).toBe("夜に駆ける");
  });

  it("respells a syllable-timed word whole, then shares it out", () => {
    const syllables = gibberishSyllables(["beau", "ti", "ful ", "day"]);
    expect(syllables).toHaveLength(4);
    expect(syllables.slice(0, 3).join("")).toBe("byutifo");
    expect(syllables.every((part) => part.length > 0)).toBe(true);
    expect(syllables.join("")).toBe(gibberishLine("beautiful day"));
  });

  it("keeps untouched syllables of words it leaves alone", () => {
    expect(gibberishSyllables(["夜", "に "])).toEqual(["夜", "に "]);
  });
});
