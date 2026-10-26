import { GIBBERISH_WORDS } from "./gibberish-dictionary";

/* Gibberish, from Spicy Lyrics' Unique Word Filters: lyrics respelled the
 * way someone who doesn't speak the language might write down what they
 * hear ("We know me chain sama" becomes "Wenomechainsama"). Ported from
 * the pixels-spicy-lyrics fork's src/utils/Lyrics/GibberishTransform.ts
 * (iPixelGalaxy/spicy-lyrics a60aa34, AGPL-3.0): the dictionary, the
 * phonetic rules for words it lacks, t/d + y blending and the joining.
 *
 * SpotiFlex changes: a word timed in syllables is respelled whole and then
 * shared back out over its syllables, where the fork respelled each
 * syllable alone ("beau-ti-ful" missed the dictionary's "byutifo"); phrases
 * keep the comma, question mark or other mark that ends them, as in the
 * meme's "Wenomechainsama, tumajarbisaun"; a line that began with a
 * capital still does; curly apostrophes and accents are read like plain
 * ones; and words with no Latin letters, such as Japanese or Korean, are
 * left as written. */

// Phonetic rules for words missing from the dictionary, in the fork's order.
const RULES: [RegExp, string][] = [
  [/ough/g, "o"],
  [/augh/g, "af"],
  [/ight/g, "ai"],
  [/ould/g, "u"],
  [/tion/g, "shun"],
  [/sion/g, "shun"],
  [/cious/g, "shus"],
  [/tious/g, "shus"],
  [/ious/g, "yus"],
  [/eous/g, "yus"],
  [/ture/g, "cha"],
  [/sure/g, "sha"],
  [/wh/g, "w"],
  [/ck/g, "k"],
  [/ph/g, "f"],
  [/gh/g, ""],
  [/kn/g, "n"],
  [/wr/g, "r"],
  [/mb$/g, "m"],
  [/mn/g, "n"],
  [/th/g, "t"],
  [/ness$/g, "nes"],
  [/ment$/g, "men"],
  [/able$/g, "abo"],
  [/ible$/g, "ibo"],
  [/ble$/g, "bo"],
  [/ple$/g, "po"],
  [/tle$/g, "to"],
  [/ful$/g, "fo"],
  [/ally$/g, "ali"],
  [/ously$/g, "usli"],
  [/ely$/g, "li"],
  [/ly$/g, "li"],
  [/ery$/g, "ri"],
  [/ary$/g, "ari"],
  [/ory$/g, "ori"],
  [/ity$/g, "iti"],
  [/ety$/g, "eti"],
  [/ier$/g, "ia"],
  [/er$/g, "a"],
  [/or$/g, "a"],
  [/ar$/g, "a"],
  [/our$/g, "a"],
  [/re$/g, "a"],
  [/ied$/g, "id"],
  [/([aeiou])ted$/g, "$1d"],
  [/([aeiou])ded$/g, "$1d"],
  [/([^aeiou])ed$/g, "$1"],
  [/ing$/g, "in"],
  [/eigh/g, "e"],
  [/ea/g, "e"],
  [/oo/g, "u"],
  [/ee/g, "i"],
  [/ie/g, "i"],
  [/ei/g, "e"],
  [/ou/g, "u"],
  [/oi/g, "oy"],
  [/au/g, "o"],
  [/aw/g, "o"],
  [/ow/g, "o"],
  [/ai/g, "e"],
  [/ay$/g, "e"],
  [/([bcdfghjklmnpqrstvwxyz])\1/g, "$1"],
  [/([bcdfghjklmnpqrstvwxyz])e$/g, "$1"],
];

const DOUBLE_CONSONANT = /([bcdfghjklmnpqrstvwxyz])\1/g;
/** Marks that end a phrase; the respelled phrase keeps them. */
const PHRASE_END = /[,;:!?.…]+$/;

/** Lower case, accents dropped, curly apostrophes made straight. */
function plain(text: string) {
  return text
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .replace(/[‘’ʼ`]/g, "'")
    .toLowerCase();
}

/** One hyphen-free part of a word: the dictionary, then phonetic rules. */
function respellPart(part: string) {
  const word = part.replace(/[^a-z0-9']/g, "").replace(/^'+|'+$/g, "");
  const known =
    GIBBERISH_WORDS.get(word) ?? GIBBERISH_WORDS.get(word.replace(/'/g, ""));
  if (known !== undefined) return known;
  let text = word.replace(/'/g, "");
  for (const [pattern, spelling] of RULES)
    text = text.replace(pattern, spelling);
  return text;
}

/** A word's respelling, or null when it has no Latin letters to respell. */
function respellWord(word: string): string | null {
  const text = plain(word);
  if (!/[a-z]/.test(text)) return null;
  return text
    .split(/[-‐-―]/)
    .map(respellPart)
    .join("");
}

/** Respelled words, each with what follows it: nothing inside a phrase,
 *  or the phrase's closing mark and a space. Words that are not respelled
 *  keep their own text and spacing. `words` hold their trailing spaces. */
export function gibberishWords(words: string[]): string[] {
  const out: string[] = [];
  let previous: { word: string; text: string } | undefined;
  let lineStart = true;
  const respelled: boolean[] = [];
  words.forEach((word, index) => {
    const core = respellWord(word);
    respelled.push(core !== null);
    if (core === null) {
      // A lone dash or other mark stands apart between respelled phrases.
      if (!/[\p{L}\p{N}]/u.test(word) && word.trim()) {
        const spaced = !out.length || /\s$/.test(out[out.length - 1]);
        out.push(
          `${spaced ? "" : " "}${word.trim()}${index < words.length - 1 ? " " : ""}`,
        );
      } else out.push(word);
      previous = undefined;
      return;
    }
    const trimmed = word.trimEnd();
    const mark = trimmed.match(PHRASE_END)?.[0] ?? "";
    const last = index === words.length - 1;
    let text = core;
    if (previous) {
      // t or d before a "y" word blends into ch or j ("met you": "mechu").
      const end = plain(previous.word)
        .replace(/[^a-z]+$/, "")
        .slice(-1);
      if (/^y[aeiou]/.test(plain(word)) && (end === "t" || end === "d")) {
        const blend = end === "t" ? "ch" : "j";
        out[out.length - 1] += blend;
        previous.text += blend;
      }
      // A consonant doubled across the join is said once.
      const before = previous.text.slice(-1);
      if (
        before &&
        text[0] === before &&
        /[bcdfghjklmnpqrstvwxyz]/.test(before)
      )
        text = text.slice(1);
    }
    if (lineStart && /^\P{L}*\p{Lu}/u.test(word))
      text = text.charAt(0).toUpperCase() + text.slice(1);
    lineStart = false;
    out.push(text + (mark ? mark + (last ? "" : " ") : ""));
    previous = mark ? undefined : { word, text };
  });
  // As in the fork, consonants doubled anywhere in the result are said once.
  return out.map((text, index) =>
    respelled[index] ? text.replace(DOUBLE_CONSONANT, "$1") : text,
  );
}

/** A whole line respelled. */
export function gibberishLine(text: string): string {
  const words = text.match(/\S+\s*/g);
  return words ? gibberishWords(words).join("") : text;
}

/** Words timed in syllables: each word is respelled whole, then its
 *  spelling is shared over its syllables by their share of the letters.
 *  A syllable ends a word when it ends with a space or ends the line. */
export function gibberishSyllables(syllables: string[]): string[] {
  const groups: number[][] = [];
  let group: number[] = [];
  syllables.forEach((syllable, index) => {
    group.push(index);
    if (/\s$/.test(syllable) || index === syllables.length - 1) {
      groups.push(group);
      group = [];
    }
  });
  const spelled = gibberishWords(
    groups.map((indexes) => indexes.map((index) => syllables[index]).join("")),
  );
  const out: string[] = [];
  groups.forEach((indexes, word) => {
    const text = spelled[word];
    if (indexes.length === 1) {
      out.push(text);
      return;
    }
    const original = indexes.map((index) => syllables[index]);
    if (respellWord(original.join("")) === null) {
      out.push(...original);
      return;
    }
    // Keep the closing mark and space on the word's last syllable.
    const tail = text.match(/[,;:!?.…]*\s*$/)?.[0] ?? "";
    const body = text.slice(0, text.length - tail.length);
    const weights = indexes.map(
      (index) => syllables[index].replace(/[^\p{L}\p{N}]/gu, "").length || 1,
    );
    const total = weights.reduce((sum, weight) => sum + weight, 0);
    let used = 0,
      seen = 0;
    indexes.forEach((_, part) => {
      seen += weights[part];
      const end =
        part === indexes.length - 1
          ? body.length
          : Math.round((body.length * seen) / total);
      out.push(body.slice(used, Math.max(used, end)));
      used = Math.max(used, end);
    });
    out[out.length - 1] += tail;
  });
  return out;
}
