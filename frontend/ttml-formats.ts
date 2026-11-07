import {
  type CreatorLine,
  type CreatorUnit,
  lineSpan,
} from "./ttml-creator-model";

// Word-timed formats AMLL TTML Tool reads and writes:
// QRC  [lineStart,lineDur]word(start,dur)word(start,dur)
// YRC  [lineStart,lineDur](start,dur,0)word(start,dur,0)word
// LYS  [prop]word(start,dur)word(start,dur); prop 3-8 marks background (6-8)
//      and second singer (2, 5, 8)
// ESLyric  [mm:ss.xx]word[mm:ss.xx]word[mm:ss.xx]; each stamp ends one word
//      and starts the next
export const WORD_FORMATS = ["qrc", "yrc", "lys", "eslrc"] as const;
export type WordFormat = (typeof WORD_FORMATS)[number];
export const EXPORT_FORMATS = ["lrc", ...WORD_FORMATS] as const;
export type ExportFormat = (typeof EXPORT_FORMATS)[number];

export const formatOf = (filename: string) =>
  filename.toLowerCase().match(/\.([a-z]+)$/)?.[1] ?? "";

interface Timed {
  text: string;
  start: number;
  end: number;
}

/** Words carry their own spacing; a word without a space before it is a syllable of the last. */
function toUnits(words: Timed[]): CreatorUnit[] {
  const units: CreatorUnit[] = [];
  let gap = true;
  for (const word of words) {
    const text = word.text.trim();
    if (!text) {
      gap = true;
      continue;
    }
    units.push({
      text,
      joined: units.length > 0 && !gap && !/^\s/.test(word.text),
      start: word.start,
      end: word.end,
    });
    gap = /\s$/.test(word.text);
  }
  return units;
}

function line(
  words: Timed[],
  background = false,
  opposite = false,
): CreatorLine | null {
  if (background && words.length) {
    words[0] = { ...words[0], text: words[0].text.replace(/^[(（]/, "") };
    const last = words.length - 1;
    words[last] = {
      ...words[last],
      text: words[last].text.replace(/[)）](\s*)$/, "$1"),
    };
  }
  const units = toUnits(words);
  return units.length ? { units, background, opposite } : null;
}

const bracketed = (words: Timed[]) =>
  words.length > 0 &&
  /^[(（]/.test(words[0].text.trim()) &&
  /[)）]$/.test(words[words.length - 1].text.trim());

function textAfter(pattern: RegExp, body: string): Timed[] {
  return [...body.matchAll(pattern)].map((match) => ({
    text: match[1],
    start: Number(match[2]),
    end: Number(match[2]) + Number(match[3]),
  }));
}

function unwrapQrc(source: string): string {
  const content = source.match(/LyricContent="([\s\S]*?)"\s*\/?>/)?.[1];
  if (!content) return source;
  return content
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

function stamp(text: string): number | null {
  const match = text.match(/^(\d+):(\d+(?:\.\d+)?)$/);
  return match
    ? Math.round((Number(match[1]) * 60 + Number(match[2])) * 1000)
    : null;
}

export function parseWordFormat(
  format: WordFormat,
  source: string,
): CreatorLine[] {
  const lines: CreatorLine[] = [];
  const rows = (format === "qrc" ? unwrapQrc(source) : source)
    .split(/\r?\n/)
    .map((row) => row.trim())
    .filter(Boolean);
  for (const row of rows) {
    let parsed: CreatorLine | null = null;
    if (format === "qrc") {
      const body = row.match(/^\[\d+,\d+\](.*)$/)?.[1];
      if (body === undefined) continue;
      const words = textAfter(/(.*?)\((\d+),(\d+)\)/g, body);
      parsed = line(words, bracketed(words));
    } else if (format === "yrc") {
      const body = row.match(/^\[\d+,\d+\](.*)$/)?.[1];
      if (body === undefined) continue;
      const words = [
        ...body.matchAll(/\((\d+),(\d+),\d+\)(.*?)(?=\(\d+,\d+,\d+\)|$)/g),
      ].map((match) => ({
        text: match[3],
        start: Number(match[1]),
        end: Number(match[1]) + Number(match[2]),
      }));
      parsed = line(words, bracketed(words));
    } else if (format === "lys") {
      const match = row.match(/^\[(\d+)\](.*)$/);
      if (!match) continue;
      const prop = Number(match[1]) <= 8 ? Number(match[1]) : 0;
      const words = textAfter(/(.*?)\((\d+),(\d+)\)/g, match[2]);
      const background = prop <= 2 ? bracketed(words) : prop >= 6;
      parsed = line(words, background, prop % 3 === 2);
    } else {
      const parts = row.split(/\[(\d+:\d+(?:\.\d+)?)\]/);
      const words: Timed[] = [];
      for (let at = 1; at + 2 < parts.length; at += 2) {
        const start = stamp(parts[at]);
        const end = stamp(parts[at + 2]);
        if (start === null || end === null || !parts[at + 1]) continue;
        words.push({ text: parts[at + 1], start, end });
      }
      parsed = line(words, bracketed(words));
    }
    if (parsed) lines.push(parsed);
  }
  return lines;
}

/** Word texts with their spacing: a space ends each word but the last. */
function spaced(
  line: CreatorLine,
): { text: string; start: number; end: number }[] {
  const timed = line.units.filter(
    (unit) => unit.start !== undefined && unit.end !== undefined,
  );
  return timed.map((unit, index) => {
    const next = timed[index + 1];
    let text = unit.text;
    if (line.background && index === 0) text = `(${text}`;
    if (line.background && !next) text = `${text})`;
    return {
      text: next && !next.joined ? `${text} ` : text,
      start: unit.start!,
      end: unit.end!,
    };
  });
}

function lrcStamp(ms: number) {
  const centis = Math.round(ms / 10);
  const minutes = Math.floor(centis / 6000);
  const seconds = (centis % 6000) / 100;
  return `${String(minutes).padStart(2, "0")}:${seconds.toFixed(2).padStart(5, "0")}`;
}

export function exportLyrics(
  format: ExportFormat,
  lines: CreatorLine[],
): string {
  return lines
    .map((line) => {
      const words = spaced(line);
      const span = lineSpan(line);
      if (!words.length || !span) return null;
      const length = span.end - span.start;
      if (format === "lrc")
        return `[${lrcStamp(span.start)}]${words.map((word) => word.text).join("")}`;
      if (format === "qrc")
        return `[${span.start},${length}]${words.map((word) => `${word.text}(${word.start},${word.end - word.start})`).join("")}`;
      if (format === "yrc")
        return `[${span.start},${length}]${words.map((word) => `(${word.start},${word.end - word.start},0)${word.text}`).join("")}`;
      if (format === "lys")
        return `[${(line.opposite ? 2 : 1) + (line.background ? 6 : 3)}]${words.map((word) => `${word.text}(${word.start},${word.end - word.start})`).join("")}`;
      return `${words.map((word) => `[${lrcStamp(word.start)}]${word.text}`).join("")}[${lrcStamp(words.at(-1)!.end)}]`;
    })
    .filter((row): row is string => row !== null)
    .join("\n");
}
