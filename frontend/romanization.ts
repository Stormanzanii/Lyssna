import { transliterate } from "transliteration";
import { wordGroups } from "./lyric-motion";
import type { Line, Lyrics, Word } from "./types";

const foreignRuns = /(?:(?!\p{Script=Latin})[\p{L}\p{M}\u200c\u200d])+/gu;
const cache = new WeakMap<Lyrics, Lyrics>();

/** Local Unicode fallback; retain Latin text, punctuation and unknown symbols. */
export function romanizeText(text: string) {
  return text.replace(foreignRuns, (run) => {
    if (!/\p{L}/u.test(run)) return run;
    return transliterate(run.normalize("NFC")) || run;
  });
}

/** Prefer authored word spans. Otherwise mark a line-wide allocation estimated. */
function suppliedWords(line: Line, text: string): Word[] {
  if (!line.words.length) return [];
  const units = text.match(/\s*\S+/gu) ?? [];
  const groups = wordGroups(line.words);
  if (groups.length === units.length) {
    return groups.map((group, index) => ({
      ...group[0],
      text: units[index],
      start_ms: Math.min(...group.map((word) => word.start_ms)),
      end_ms: Math.max(...group.map((word) => word.end_ms)),
    }));
  }
  const start = Math.min(...line.words.map((word) => word.start_ms));
  const end = Math.max(...line.words.map((word) => word.end_ms));
  const weights = units.map((unit) =>
    Math.max(1, Array.from(unit.trim()).length),
  );
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  let used = 0;
  return units.map((unit, index) => {
    const from = start + Math.round(((end - start) * used) / total);
    used += weights[index];
    return {
      text: unit,
      start_ms: from,
      end_ms:
        index === units.length - 1
          ? end
          : start + Math.round(((end - start) * used) / total),
      estimated: true,
    };
  });
}

/** One immutable, cached projection used by normal, floating and preview lyrics. */
export function romanizedLyrics(lyrics: Lyrics): Lyrics {
  const existing = cache.get(lyrics);
  if (existing) return existing;
  let changed = false;
  let estimated = !!lyrics.estimated_words;
  const lines = lyrics.lines.map((line) => {
    const supplied = romanizeText(line.romanization.trim());
    const words = supplied
      ? suppliedWords(line, supplied)
      : line.words.map((word) => {
          const text = romanizeText(word.text);
          return text === word.text ? word : { ...word, text };
        });
    const text =
      supplied ||
      (words.length
        ? words.map((word) => word.text).join("")
        : romanizeText(line.text));
    if (
      !supplied &&
      text === line.text &&
      words.every((word, index) => word === line.words[index])
    )
      return line;
    changed = true;
    estimated ||= words.some((word) => word.estimated);
    return { ...line, text, words, romanization: "" };
  });
  const result = changed
    ? { ...lyrics, lines, estimated_words: estimated }
    : lyrics;
  cache.set(lyrics, result);
  return result;
}
