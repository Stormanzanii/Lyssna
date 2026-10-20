import type { Line, Lyrics, Word } from "./types";
import { romanizedLyrics } from "./romanization";

/*
 * Experimental word sync: estimated word timing for line-synced lyrics.
 *
 * Reimplements the behaviour of Spicy Lyrics' ExperimentalWordSync
 * (iPixelGalaxy/spicy-lyrics, AGPL-3.0) for SpotiFlex's lyric model. Each
 * line's time is spread over its words by letter weight, bracketed parts
 * become background vocals, and a line whose end runs straight into the next
 * line but lasts far longer than its words need is trimmed to a speech-rate
 * estimate. Spotify's audio analysis, which upstream uses to snap boundaries
 * and to time unsynced lyrics, is not available to SpotiFlex, so only those
 * text-based estimates are used.
 */

type Segment = { background: boolean; text: string };
type Unit = { text: string; partOfWord: boolean };

const BRACKETED = /(\[[^[\]]+\]|\([^()]+\)|\{[^{}]+\})/g;
const BRACKETED_ONLY = /^(\[[^[\]]+\]|\([^()]+\)|\{[^{}]+\})$/;
const CJK =
  /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
const HANGUL_ONLY = /^\p{Script=Hangul}+$/u;
const VOCABLE =
  /^(oh|ooh|oooh|whoa|woah|ah|aah|ha|hey|yeah|ya|na|la|da|dum|doo|wo)$/;
/** Line ends this close (ms) to the next start look auto-filled, not sung. */
const SUSPICIOUS_END_MS = 50;
/** A gap this long (ms) around a bracketed-only line makes it a lead line. */
const MEANINGFUL_GAP_MS = 350;

const normalize = (text: string | undefined) =>
  (text ?? "").replace(/\s+/g, " ").trim();

/** Letters that take time to sing; punctuation and spaces do not. */
export function textWeight(text: string) {
  const compact = text
    .replace(/[.,!?;:'"()[\]{}\-—–…@#$%^&*~`]/g, "")
    .replace(/\s/g, "");
  return Math.max(1, compact.length || text.trim().length);
}

function segments(text: string): Segment[] {
  const normalized = normalize(text);
  if (!normalized) return [];
  const result: Segment[] = [];
  for (const part of normalized.split(BRACKETED)) {
    const piece = normalize(part);
    if (!piece) continue;
    if (BRACKETED_ONLY.test(piece)) {
      const inner = normalize(piece.slice(1, -1));
      if (inner) result.push({ background: true, text: inner });
    } else result.push({ background: false, text: piece });
  }
  return result.length ? result : [{ background: false, text: normalized }];
}

function hyphenUnits(token: string): Unit[] {
  const parts = token.split("-").map((part) => part.trim());
  if (parts.length === 1) return [{ text: token, partOfWord: false }];
  const units = parts.flatMap((part, index) =>
    part
      ? [
          {
            text: index < parts.length - 1 ? `${part}-` : part,
            partOfWord: index < parts.length - 1,
          },
        ]
      : [],
  );
  return units.length ? units : [{ text: token, partOfWord: false }];
}

function cjkUnits(token: string, splitHangul: boolean): Unit[] {
  if (!CJK.test(token)) return hyphenUnits(token);
  const pieces =
    typeof Intl.Segmenter === "function"
      ? Array.from(
          new Intl.Segmenter(undefined, { granularity: "word" }).segment(token),
          ({ segment }) => segment,
        )
      : Array.from(token);
  const units = pieces
    .flatMap((piece) =>
      splitHangul && HANGUL_ONLY.test(piece) ? Array.from(piece) : [piece],
    )
    .filter(Boolean);
  return units.map((text, index) => ({
    text,
    partOfWord: index < units.length - 1,
  }));
}

/** Splits text into timed units: words, hyphen parts and CJK words. */
export function splitUnits(text: string): Unit[] {
  const normalized = normalize(text);
  if (!normalized) return [];
  const spaced = /\s/.test(normalized);
  return normalized
    .split(/\s+/)
    .flatMap((token) => cjkUnits(token, !spaced))
    .filter((unit) => unit.text);
}

/** Splits [start, end) in proportion to weights; the last part ends at end. */
export function distribute(start: number, end: number, weights: number[]) {
  const total = weights.reduce((sum, weight) => sum + Math.max(1, weight), 0);
  const duration = Math.max(0, end - start);
  let used = 0,
    cursor = start;
  return weights.map((weight, index) => {
    const from = cursor;
    if (index === weights.length - 1 || duration <= 0)
      return { start: from, end };
    used += Math.max(1, weight);
    cursor = start + Math.round((duration * used) / total);
    return { start: from, end: cursor };
  });
}

/** Words for `text`, using SpotiFlex's leading-space word convention. */
function buildWords(text: string, start: number, end: number): Word[] {
  const units = splitUnits(text);
  const ranges = distribute(
    start,
    end,
    units.map((unit) => textWeight(unit.text)),
  );
  return units.map((unit, index) => ({
    text: `${index > 0 && !units[index - 1].partOfWord ? " " : ""}${unit.text}`,
    start_ms: ranges[index].start,
    end_ms: ranges[index].end,
    estimated: true,
  }));
}

function capitalizeFirst(words: Word[]) {
  const first = words[0];
  if (!first) return;
  const index = Array.from(first.text).findIndex(
    (char) => char.toLowerCase() !== char.toUpperCase(),
  );
  if (index < 0) return;
  const chars = Array.from(first.text);
  if (chars[index] === chars[index].toLowerCase())
    chars[index] = chars[index].toUpperCase();
  first.text = chars.join("");
}

export function isVocableLine(text: string) {
  const normalized = normalize(text).toLowerCase();
  const words = splitUnits(normalized).map((unit) => unit.text);
  if (!words.length || words.length > 5) return false;
  const simple = normalized.split(/\s+/).filter(Boolean).length;
  const hyphens = (normalized.match(/-/g) ?? []).length >= 2;
  return (
    words.every((word) => {
      const letters = word.replace(/[^a-z]/g, "");
      return (
        letters.length >= 1 && letters.length <= 5 && VOCABLE.test(letters)
      );
    }) &&
    (hyphens || simple <= 3)
  );
}

/** How long (ms) a line of text usually takes to sing. */
export function spokenDuration(text: string) {
  const units = splitUnits(text);
  if (!units.length) return 400;
  const weight = units.reduce((sum, unit) => sum + textWeight(unit.text), 0);
  const normalized = normalize(text);
  const pause = /[.!?]$/.test(normalized)
    ? 0.12
    : /[,;:]$/.test(normalized)
      ? 0.07
      : 0;
  return (
    Math.max(0.4, 0.18 + units.length * 0.16 + weight * 0.045 + pause) * 1000
  );
}

/**
 * Line-synced sources often end every line exactly where the next begins.
 * When that end is far later than the words need, finish the words sooner so
 * they do not crawl through an instrumental gap.
 */
export function effectiveLineEnd(lines: Line[], index: number) {
  const line = lines[index],
    next = lines.slice(index + 1).find((item) => !item.background);
  if (!next || Math.abs(line.end_ms - next.start_ms) > SUSPICIOUS_END_MS)
    return line.end_ms;
  const background = segments(line.text).some((segment) => segment.background);
  const vocable = isVocableLine(line.text);
  const predicted =
    spokenDuration(line.text) * (background ? 1.2 : 1) * (vocable ? 1.65 : 1);
  const threshold = (background ? 1.95 : 1.6) * (vocable ? 1.42 : 1);
  if (line.end_ms - line.start_ms <= predicted * threshold) return line.end_ms;
  const trim = background ? 1.1 : vocable ? 1.62 : 1.22;
  return Math.min(line.end_ms, Math.round(line.start_ms + predicted * trim));
}

/** True when lyrics are synced by line only and could gain word timing. */
export function needsWordSync(lyrics: Lyrics | null | undefined) {
  return !!(
    lyrics?.synced &&
    lyrics.lines.length &&
    lyrics.lines.every((line) => !line.words.length)
  );
}

function backgroundOnly(line: Line | undefined) {
  const parts = line ? segments(line.text) : [];
  return parts.length > 0 && parts.every((part) => part.background);
}

/** Converts line-synced lyrics to estimated word timing. */
export function convertToWordSync(lyrics: Lyrics): Lyrics {
  if (!needsWordSync(lyrics)) return lyrics;
  const source = lyrics.lines.filter((line) => normalize(line.text));
  const output: Line[] = [];
  let lastLead: Line | undefined;
  source.forEach((line, index) => {
    const end = effectiveLineEnd(source, index);
    const parts = segments(line.text);
    const ranges = distribute(
      line.start_ms,
      end,
      parts.map((part) => textWeight(part.text)),
    );
    const lead: Word[] = [];
    const backgrounds: Line[] = [];
    parts.forEach((part, partIndex) => {
      const words = buildWords(
        part.text,
        ranges[partIndex].start,
        ranges[partIndex].end,
      );
      if (!words.length) return;
      if (!part.background) {
        if (lead.length && !/^\s/.test(words[0].text))
          words[0].text = ` ${words[0].text}`;
        lead.push(...words);
        return;
      }
      words[0].text = words[0].text.trimStart();
      capitalizeFirst(words);
      backgrounds.push({
        ...line,
        start_ms: ranges[partIndex].start,
        end_ms: ranges[partIndex].end,
        text: words.map((word) => word.text).join(""),
        translation: "",
        romanization: "",
        words,
        background: true,
      });
    });
    if (lead.length) {
      lastLead = {
        ...line,
        end_ms: end,
        text: lead.map((word) => word.text).join(""),
        words: lead,
      };
      output.push(lastLead, ...backgrounds);
      return;
    }
    // A bracketed-only line: keep it as a sung line when it stands alone in
    // a gap or among other bracketed lines, otherwise hang it on the line
    // before as backing vocals.
    const gap =
      line.start_ms - (source[index - 1]?.end_ms ?? -Infinity) >
        MEANINGFUL_GAP_MS ||
      (source[index + 1]?.start_ms ?? Infinity) - end > MEANINGFUL_GAP_MS;
    const standalone =
      backgroundOnly(source[index - 1]) ||
      backgroundOnly(source[index + 1]) ||
      gap;
    if (!standalone && lastLead && lastLead.opposite === line.opposite) {
      output.push(...backgrounds);
      return;
    }
    const words = buildWords(
      backgrounds.map((item) => item.text).join(" "),
      line.start_ms,
      end,
    );
    if (!words.length) return;
    lastLead = {
      ...line,
      end_ms: end,
      text: words.map((word) => word.text).join(""),
      words,
    };
    output.push(lastLead);
  });
  return { ...lyrics, lines: output, estimated_words: true };
}

const cache = new WeakMap<Lyrics, Lyrics>();
/** Lyrics as displayed: converted when word sync is on and applies. */
export function displayLyrics<T extends Lyrics | null | undefined>(
  lyrics: T,
  wordSync: boolean,
  romanized = false,
): T {
  if (lyrics && romanized) lyrics = romanizedLyrics(lyrics) as T;
  if (!lyrics || !wordSync || !needsWordSync(lyrics)) return lyrics;
  let converted = cache.get(lyrics);
  if (!converted) {
    converted = convertToWordSync(lyrics);
    cache.set(lyrics, converted);
  }
  return converted as T;
}
