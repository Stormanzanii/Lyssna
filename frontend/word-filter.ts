import type { Lyrics } from "./types";

/** Unique Word Filters from Spicy Lyrics' Effects: every lyric word in
 *  lower or upper case. Translations and readings keep their own case. */
export type WordFilter = "off" | "lower" | "upper";

const filtered = {
  lower: new WeakMap<Lyrics, Lyrics>(),
  upper: new WeakMap<Lyrics, Lyrics>(),
};

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
      lines: lyrics.lines.map((line) => ({
        ...line,
        text: change(line.text),
        words: line.words.map((word) => ({ ...word, text: change(word.text) })),
      })),
    };
    cache.set(lyrics, result);
  }
  return result as T;
}
