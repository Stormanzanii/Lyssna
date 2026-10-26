import type { Line, Lyrics } from "./types";
import { gibberishLine, gibberishSyllables } from "./gibberish";

/** Unique Word Filters from Spicy Lyrics' Effects: every lyric word in
 *  lower or upper case, or respelled as gibberish (see gibberish.ts).
 *  Translations and readings are left alone. */
export type WordFilter = "off" | "gibberish" | "lower" | "upper";

const filtered = {
  gibberish: new WeakMap<Lyrics, Lyrics>(),
  lower: new WeakMap<Lyrics, Lyrics>(),
  upper: new WeakMap<Lyrics, Lyrics>(),
};

/** A line respelled as gibberish: timed words are respelled together so
 *  phrases join, and the line text follows them. */
function gibberish(line: Line): Line {
  if (!line.words.length) return { ...line, text: gibberishLine(line.text) };
  const texts = gibberishSyllables(line.words.map((word) => word.text));
  return {
    ...line,
    text: texts.join("").trim(),
    words: line.words.map((word, index) => ({ ...word, text: texts[index] })),
  };
}

/** The lyrics with the filter applied. The same lyrics give the same
 *  object back, so animators keyed on them are not rebuilt each frame. */
export function filterWords<T extends Lyrics | null | undefined>(
  lyrics: T,
  filter: WordFilter = "off",
): T {
  if (!lyrics || filter === "off" || !(filter in filtered)) return lyrics;
  const cache = filtered[filter];
  let result = cache.get(lyrics);
  if (!result) {
    const change = (text: string) =>
      filter === "lower" ? text.toLocaleLowerCase() : text.toLocaleUpperCase();
    result = {
      ...lyrics,
      lines: lyrics.lines.map((line) =>
        filter === "gibberish"
          ? gibberish(line)
          : {
              ...line,
              text: change(line.text),
              words: line.words.map((word) => ({
                ...word,
                text: change(word.text),
              })),
            },
      ),
    };
    cache.set(lyrics, result);
  }
  return result as T;
}
