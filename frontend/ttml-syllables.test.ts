import { describe, expect, it } from "vitest";
import { cutAt, learnFrom, suggestSplit } from "./ttml-syllables";

const split = (word: string, learned = {}) =>
  cutAt(word, suggestSplit(word, learned));

describe("TTML syllable splitting", () => {
  it("splits English words by dictionary or speech rules", () => {
    expect(split("everybody")).toEqual(["e", "very", "bo", "dy"]);
    expect(split("here")).toEqual(["here"]);
    expect(split("hamburger").length).toBeGreaterThan(1);
    expect(split("hamburger").join("")).toBe("hamburger");
  });

  it("keeps punctuation on the edges and leaves non-words alone", () => {
    expect(split("Everybody,")).toEqual(["E", "very", "bo", "dy,"]);
    expect(split("2024")).toEqual(["2024"]);
    expect(split("...")).toEqual(["..."]);
  });

  it("prefers a remembered split, matched without case or punctuation", () => {
    const rule = learnFrom("Ham|burger".replace("|", ""), [3, 6]);
    expect(rule).toEqual({ key: "hamburger", offsets: [3, 6] });
    const learned = { [rule.key]: rule.offsets };
    expect(split('"HAMBURGER!"', learned)).toEqual(['"HAM', "BUR", 'GER!"']);
  });
});
