// English syllable splitting reimplemented from spicylyrics/ttml-tool
// (AGPL-3.0): its dictionary, a speech-based fallback, and remembered splits.
import nlp from "compromise/tokenize";
import nlpSpeech from "compromise-speech";
import dictionaryData from "./ttml-syllable-dict.json";

type Entry = number | number[];

const dictionary = new Map<string, Entry>(
  Object.entries(dictionaryData as Record<string, Entry>),
);
const speech = nlp.extend(nlpSpeech as never);
const EDGE = /^[\p{P}\p{S}]$/u;

function core(text: string) {
  const chars = Array.from(text);
  let start = 0;
  let end = chars.length;
  while (start < end && EDGE.test(chars[start])) start++;
  while (end > start && EDGE.test(chars[end - 1])) end--;
  return { chars, start, end, word: chars.slice(start, end).join("") };
}

/** Character offsets inside `text` where its syllables meet. */
function boundariesFromParts(parts: string[]): number[] {
  const out: number[] = [];
  let at = 0;
  for (const part of parts.slice(0, -1)) {
    at += Array.from(part).length;
    out.push(at);
  }
  return out;
}

function speechSplit(word: string): string[] {
  const syllables = (speech(word).syllables() as string[][]).flat();
  if (syllables.length <= 1) return [word];
  let offset = 0;
  const spans = syllables.map((syllable) => {
    const match = word
      .slice(offset)
      .toLowerCase()
      .indexOf(syllable.toLowerCase());
    const begin = offset;
    offset = offset + Math.max(0, match) + syllable.length;
    return { begin, end: offset };
  });
  spans.forEach((span, index) => {
    const next = spans[index + 1];
    if (!next) {
      span.end = word.length;
      return;
    }
    span.end = next.begin;
    // Keep an apostrophe with the syllable after it: "don|'t" not "don'|t".
    if (/[’']/.test(word.charAt(span.end - 1))) {
      span.end--;
      next.begin--;
    }
  });
  const parts = spans
    .map(({ begin, end }) => word.slice(begin, end))
    .filter(Boolean);
  const merged: string[] = [];
  for (const part of parts) {
    if (/^[’'](?:s|re|ve|ll|d|m|t)$/i.test(part) && merged.length)
      merged[merged.length - 1] += part;
    else merged.push(part);
  }
  return merged;
}

function dictionarySplit(word: string): string[] | null {
  const key = word.toLowerCase();
  const entry =
    dictionary.get(key) ??
    (key.endsWith("in") ? dictionary.get(`${key}g`) : undefined);
  if (entry === undefined) return null;
  const lengths = typeof entry === "number" ? [entry] : entry;
  const chars = Array.from(word);
  const parts: string[] = [];
  let start = 0;
  for (const length of lengths) {
    const end = start + length;
    if (end <= start || end >= chars.length) break;
    parts.push(chars.slice(start, end).join(""));
    start = end;
  }
  parts.push(chars.slice(start).join(""));
  return parts.filter(Boolean);
}

export type LearnedSplits = Record<string, number[]>;

export const learnedKey = (text: string) =>
  core(text).word.normalize("NFC").toLowerCase();

/** Split offsets for `text`, counted in characters of the whole token. */
export function suggestSplit(text: string, learned: LearnedSplits): number[] {
  const { start, end, word } = core(text);
  if (!word) return [];
  const remembered = learned[learnedKey(text)];
  const inner = remembered
    ? remembered.filter((at) => at > 0 && at < end - start)
    : /^[\p{L}’']+$/u.test(word) && /[a-z]/i.test(word)
      ? boundariesFromParts(dictionarySplit(word) ?? speechSplit(word))
      : [];
  return inner.map((at) => at + start);
}

/** `text` cut at the given character offsets. */
export function cutAt(text: string, offsets: number[]): string[] {
  const chars = Array.from(text);
  const sorted = [...new Set(offsets)]
    .filter((at) => at > 0 && at < chars.length)
    .sort((a, b) => a - b);
  const parts: string[] = [];
  let start = 0;
  for (const end of [...sorted, chars.length]) {
    parts.push(chars.slice(start, end).join(""));
    start = end;
  }
  return parts;
}

/** Offsets relative to the word core, so "Hello?" and "hello" share a rule. */
export function learnFrom(text: string, offsets: number[]) {
  const { start, end } = core(text);
  return {
    key: learnedKey(text),
    offsets: offsets
      .map((at) => at - start)
      .filter((at) => at > 0 && at < end - start)
      .sort((a, b) => a - b),
  };
}

// As in amll-ttml-tool's segmentation (GPL-3.0): Latin, Cyrillic and Greek
// stay whole words; Han, kana and Hangul split per character, and so does
// every other script. Lyssna splits by grapheme so Thai and Indic marks stay
// on their letter, keeps small kana and ー with their mora, and leans
// punctuation on its neighbour. Cursive scripts stay whole: split letters
// would render in their isolated forms.
const WORDLIKE =
  /[\p{Script=Latin}\p{Script=Cyrillic}\p{Script=Greek}\p{Script=Arabic}\p{Script=Syriac}\p{Script=Nko}\p{Script=Mongolian}\d]/u;
const LETTER = /[\p{L}\p{N}]/u;
const MORA_TAIL =
  /^[ぁぃぅぇぉっゃゅょゎゕゖァィゥェォッャュョヮヵヶㇰ-ㇿーｧ-ｯｰ]$/u;
const OPENING = /^[([{<「『（【《〈〔｢“‘«‹¿¡]$/u;
const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

export function symbolPieces(text: string): string[] {
  const pieces: string[] = [];
  let run = "";
  let carry = "";
  const flush = () => {
    if (run) pieces.push(carry + run);
    else if (carry) pieces.push(carry);
    run = "";
    carry = "";
  };
  for (const { segment } of graphemes.segment(text)) {
    if (!LETTER.test(segment)) {
      if (OPENING.test(segment) && !run) carry += segment;
      else if (OPENING.test(segment)) {
        flush();
        carry = segment;
      } else if (run) run += segment;
      else if (pieces.length) pieces[pieces.length - 1] += segment;
      else carry += segment;
    } else if (WORDLIKE.test(segment)) {
      run += segment;
    } else if (MORA_TAIL.test(segment) && (run || pieces.length)) {
      if (run) run += segment;
      else pieces[pieces.length - 1] += segment;
    } else {
      if (run) flush();
      run = segment;
      flush();
    }
  }
  flush();
  return pieces.length ? pieces : [text];
}
