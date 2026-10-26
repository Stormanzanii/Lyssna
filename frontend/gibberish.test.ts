import { describe, expect, it } from "vitest";
import { gibberishLine, gibberishSyllables, gibberishWords } from "./gibberish";
import { GIBBERISH_ENTRIES } from "./gibberish-dictionary";

describe("gibberish", () => {
  it("carries the fork's whole dictionary", () => {
    expect(GIBBERISH_ENTRIES).toHaveLength(2113);
    expect(gibberishLine("beautiful")).toBe("byutifo");
  });

  it("joins a line into lower-case words without punctuation", () => {
    expect(gibberishLine("I'm in love with you, my dear")).toBe(
      "emenlufwitumadia",
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
    expect(syllables.join("")).toBe("byutifode");
  });

  it("ends words at spaces before syllables too", () => {
    // Lyrics put the space before a word as often as after the last one.
    expect(
      gibberishSyllables(["The", " morn", "ing", " light", " is"]).join(""),
    ).toBe("demoninlaies");
    // Words timed alone keep doubled letters across them, as in the fork.
    expect(gibberishSyllables(["don't", " know"]).join("")).toBe("donnu");
    expect(gibberishLine("don't know")).toBe("donu");
    expect(gibberishLine("The morning light is turning blue")).toBe(
      "demoninlaiesterinblu",
    );
  });

  it("keeps untouched syllables of words it leaves alone", () => {
    expect(gibberishSyllables(["夜", "に "])).toEqual(["夜", "に "]);
  });
});
