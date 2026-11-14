import { useSyncExternalStore } from "react";
import { transliterate } from "transliteration";
import { wordGroups } from "./lyric-motion";
import {
  koreanSyllables,
  romanizePieces,
  type JapaneseToken,
  type Readers,
} from "./romanize-line";
import type { Line, Lyrics, Word } from "./types";

/* Romanization as Spicy Lyrics does it (iPixelGalaxy/spicy-lyrics,
 * src/utils/Lyrics/ProcessLyrics.ts): the scripts present across the whole
 * song pick the converters, and each word or line runs through every one
 * whose letters it holds, in a fixed order. A song with kana is Japanese, so
 * its kanji read as Japanese (Kuroshiro over the Kuromoji dictionary), never
 * as Chinese; Han text without kana is Chinese (pinyin). Korean, Cyrillic
 * and Greek have their own converters. Romanization supplied with the lyrics
 * always wins. Lyssna addition: any other non-Latin letters, such as
 * Arabic or Thai, fall back to a general transliteration. */

type Script = "japanese" | "chinese" | "korean" | "cyrillic" | "greek";

const KANA = /[ぁ-ゖァ-ヺ]/u;
const HAN = /\p{Script=Han}/u;
const KOREAN = /[가-힯ᄀ-ᇿ㄰-㆏ꥠ-꥿ힰ-퟿]/u;
const GREEK = /[Ͱ-Ͽἀ-῿]/u;
const FOREIGN = /(?:(?!\p{Script=Latin})[\p{L}\p{M}‌‍])+/gu;

/** The scripts present across the song, in conversion order. */
export function songScripts(texts: string[]): Script[] {
  const all = texts.join("\n");
  const scripts: Script[] = [];
  if (KANA.test(all)) scripts.push("japanese");
  else if (HAN.test(all)) scripts.push("chinese");
  // Like the fork, Cyrillic needs two letters in a row across the song, so
  // one look-alike letter does not count.
  if (KOREAN.test(all)) scripts.push("korean");
  if (/[Ѐ-ԯⷠ-ⷿꙀ-ꚟ]{2,}/u.test(all)) scripts.push("cyrillic");
  if (GREEK.test(all)) scripts.push("greek");
  return scripts;
}

export function romanizeKorean(text: string) {
  return text.replace(/[가-힣]+/gu, (run) => koreanSyllables(run).join(""));
}

/* Greek: ELOT 743 letters, with the common two-letter sounds. */
const GREEK_PAIRS: [RegExp, string][] = [
  [/αυ(?=[θκξπσςτφχψ]|$)/giu, "af"],
  [/αυ/giu, "av"],
  [/ευ(?=[θκξπσςτφχψ]|$)/giu, "ef"],
  [/ευ/giu, "ev"],
  [/ου/giu, "ou"],
  [/μπ/giu, "b"],
  [/ντ/giu, "nt"],
  [/γγ/giu, "ng"],
  [/γκ/giu, "gk"],
];
const GREEK_LETTERS: Record<string, string> = {
  α: "a",
  β: "v",
  γ: "g",
  δ: "d",
  ε: "e",
  ζ: "z",
  η: "i",
  θ: "th",
  ι: "i",
  κ: "k",
  λ: "l",
  μ: "m",
  ν: "n",
  ξ: "x",
  ο: "o",
  π: "p",
  ρ: "r",
  σ: "s",
  ς: "s",
  τ: "t",
  υ: "y",
  φ: "f",
  χ: "ch",
  ψ: "ps",
  ω: "o",
};
export function romanizeGreek(text: string) {
  return text.replace(/[Ͱ-Ͽἀ-῿]+/gu, (run) => {
    const capital = run[0] !== run[0].toLowerCase();
    let out = run.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
    for (const [pattern, latin] of GREEK_PAIRS)
      out = out.replace(pattern, latin);
    out = [...out].map((letter) => GREEK_LETTERS[letter] ?? letter).join("");
    return capital ? out[0].toUpperCase() + out.slice(1) : out;
  });
}

export interface RomanizeOptions {
  /** Japanese spelled as romanized lyrics usually are: kyou, koohii, wa. */
  romajiAsWritten?: boolean;
}

let japanese:
  | Promise<{
      tokenize: (text: string) => Promise<JapaneseToken[]>;
      kanaToRomaji: (kana: string) => string;
    }>
  | undefined;
/** The Kuromoji dictionary, loaded on first need. */
function loadJapanese() {
  japanese ??= (async () => {
    const [{ default: Kuroshiro }, { default: Analyzer }, loader] =
      await Promise.all([
        import("kuroshiro"),
        import("kuroshiro-analyzer-kuromoji"),
        import("kuromoji/src/loader/BrowserDictionaryLoader.js"),
      ]);
    // The dictionary is served gzipped; a server that already unpacked it
    // (sent with Content-Encoding) hands over plain bytes.
    const Loader = (loader.default ?? loader) as {
      prototype: {
        loadArrayBuffer(
          url: string,
          done: (error: unknown, buffer: ArrayBuffer | null) => void,
        ): void;
      };
    };
    Loader.prototype.loadArrayBuffer = (url, done) => {
      void fetch(url)
        .then(async (response) => {
          if (!response.ok) throw new Error(response.statusText);
          const bytes = new Uint8Array(await response.arrayBuffer());
          if (bytes[0] !== 0x1f || bytes[1] !== 0x8b) return bytes.buffer;
          const stream = new Blob([bytes])
            .stream()
            .pipeThrough(new DecompressionStream("gzip"));
          return new Response(stream).arrayBuffer();
        })
        .then(
          (buffer) => done(null, buffer),
          (error) => done(error, null),
        );
    };
    const analyzer = new Analyzer({ dictPath: "/kuromoji-dict/" });
    await analyzer.init();
    return {
      tokenize: (text: string) => analyzer.parse(text),
      kanaToRomaji: (kana: string) =>
        Kuroshiro.Util.kanaToRomaji(kana, "hepburn"),
    };
  })();
  return japanese;
}

async function readers(
  scripts: Script[],
  texts: string[],
  options: RomanizeOptions,
): Promise<Readers> {
  const found: Readers = {
    ukrainian: /[іїєґІЇЄҐ]/u.test(texts.join("\n")),
  };
  await Promise.all([
    scripts.includes("japanese")
      ? loadJapanese().then(
          (reader) =>
            (found.japanese = {
              ...reader,
              asWritten: options.romajiAsWritten !== false,
            }),
        )
      : undefined,
    scripts.includes("chinese")
      ? import("pinyin-pro").then(({ pinyin }) => {
          found.pinyin = (text) =>
            pinyin(text, { type: "all" }).map((item) =>
              item.isZh ? item.pinyin : "",
            );
        })
      : undefined,
  ]);
  return found;
}

/** Pieces of one line through the song's readers, then any other
 *  non-Latin letters through a general transliteration. */
async function romanizeLine(
  pieces: string[],
  read: Readers,
): Promise<string[]> {
  const out = await romanizePieces(pieces, read, romanizeGreek);
  return out.map((text) =>
    text.replace(FOREIGN, (run) =>
      /\p{L}/u.test(run) ? transliterate(run.normalize("NFC")) || run : run,
    ),
  );
}

async function romanizeItem(text: string, read: Readers) {
  return (await romanizeLine([text], read))[0];
}

/** The provider reads each syllable separately and joins the readings with
 *  single spaces, empty for syllables it left unread. When the pieces match
 *  the syllables one to one, each reading keeps its syllable's own timing. */
function perSyllable(line: Line): string[] | undefined {
  if (line.words.length < 2) return undefined;
  const parts = line.romanization.split(" ");
  return parts.length === line.words.length ? parts : undefined;
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

/** Lyrics romanized: supplied romanization first, then the song's
 *  converters over each word (or each line without word timing). */
export async function romanizeLyrics(
  lyrics: Lyrics,
  options: RomanizeOptions = {},
): Promise<Lyrics> {
  const texts = lyrics.lines.flatMap((line) => [
    line.text,
    ...line.words.map((word) => word.text),
  ]);
  const scripts = songScripts(texts);
  // As in the fork, nothing loads when the lyrics bring every reading.
  const read = lyrics.lines.every((line) => line.romanization.trim())
    ? {}
    : await readers(scripts, texts, options);
  let changed = false;
  let estimated = !!lyrics.estimated_words;
  const lines = await Promise.all(
    lyrics.lines.map(async (line) => {
      const authored = line.romanization.trim();
      const syllables = authored ? perSyllable(line) : undefined;
      if (syllables) {
        const texts = await Promise.all(
          line.words.map((word, index) =>
            romanizeItem(syllables[index].trim() || word.text.trim(), read),
          ),
        );
        const words = line.words.map((word, index) => {
          const text = texts[index].trim();
          // Readings stand apart as the provider's line did; untouched
          // syllables keep their own joins ("beau" + "ti" + "ful").
          const spaced =
            index > 0 &&
            (/^\s/u.test(word.text) ||
              text !== word.text.trim() ||
              texts[index - 1].trim() !== line.words[index - 1].text.trim());
          return { ...word, text: spaced ? ` ${text}` : text };
        });
        changed = true;
        return {
          ...line,
          text: words.map((word) => word.text).join(""),
          words,
          romanization: "",
        };
      }
      if (authored) {
        const supplied = await romanizeItem(authored, read);
        const words = suppliedWords(line, supplied);
        changed = true;
        estimated ||= words.some((word) => word.estimated);
        return { ...line, text: supplied, words, romanization: "" };
      }
      // The whole line is read at once so a word split over syllables
      // keeps its reading.
      const texts = await romanizeLine(
        line.words.length ? line.words.map((word) => word.text) : [line.text],
        read,
      );
      const words = line.words.map((word, index) =>
        texts[index] === word.text ? word : { ...word, text: texts[index] },
      );
      const text = words.length
        ? words.map((word) => word.text).join("")
        : texts[0];
      if (
        text === line.text &&
        words.every((word, index) => word === line.words[index])
      )
        return line;
      changed = true;
      return { ...line, text, words, romanization: "" };
    }),
  );
  return changed ? { ...lyrics, lines, estimated_words: estimated } : lyrics;
}

type Waiting = {
  lyrics: Lyrics;
  options: RomanizeOptions;
  done: (result: Lyrics) => void;
};
let worker: Worker | null | undefined;
let nextJob = 0;
const jobs = new Map<number, Waiting>();
/** The worker, started on first use; null where workers are unavailable. */
function romanizer() {
  if (worker !== undefined) return worker;
  try {
    worker =
      typeof Worker === "function" && typeof window !== "undefined"
        ? new Worker(new URL("./romanize-worker.ts", import.meta.url), {
            type: "module",
          })
        : null;
  } catch {
    worker = null;
  }
  worker?.addEventListener(
    "message",
    (event: MessageEvent<{ id: number; lyrics: Lyrics | null }>) => {
      const job = jobs.get(event.data.id);
      jobs.delete(event.data.id);
      job?.done(event.data.lyrics ?? job.lyrics);
    },
  );
  // A worker that cannot start hands its songs back to this thread.
  worker?.addEventListener("error", () => {
    worker = null;
    const waiting = [...jobs.values()];
    jobs.clear();
    for (const job of waiting)
      void romanizeLyrics(job.lyrics, job.options)
        .catch(() => job.lyrics)
        .then(job.done);
  });
  return worker;
}
/** The Japanese dictionary holds about 340 MB once loaded. An idle worker
 *  is shut down so that memory returns to the system; the next song that
 *  needs it starts a fresh one. Converted songs stay cached on this side. */
const IDLE_MS = 20_000;
let idle: ReturnType<typeof setTimeout> | undefined;
function settle() {
  clearTimeout(idle);
  idle = undefined;
  if (jobs.size || !worker) return;
  idle = setTimeout(() => {
    if (jobs.size || !worker) return;
    worker.terminate();
    worker = undefined;
  }, IDLE_MS);
}
/** Converts in the worker when there is one, else on this thread. */
export function romanizeAway(
  lyrics: Lyrics,
  options: RomanizeOptions = {},
): Promise<Lyrics> {
  const thread = romanizer();
  if (!thread) return romanizeLyrics(lyrics, options);
  clearTimeout(idle);
  return new Promise<Lyrics>((done) => {
    const id = ++nextJob;
    jobs.set(id, { lyrics, options, done });
    thread.postMessage({ id, lyrics, options });
  }).finally(settle);
}

// One cache per spelling, so switching Romaji as Written converts again.
const ready = [new WeakMap<Lyrics, Lyrics>(), new WeakMap<Lyrics, Lyrics>()];
const started = [new WeakSet<Lyrics>(), new WeakSet<Lyrics>()];
const listeners = new Set<() => void>();
let version = 0;

/** Romanized lyrics once ready; until then the lyrics as they are, and the
 *  views re-render through `useRomanization` when the result lands. Each
 *  lyrics object is converted once and the result reused. */
export function romanizedLyrics(
  lyrics: Lyrics,
  options: RomanizeOptions = {},
): Lyrics {
  const slot = options.romajiAsWritten === false ? 1 : 0;
  const done = ready[slot].get(lyrics);
  if (done) return done;
  if (!started[slot].has(lyrics)) {
    started[slot].add(lyrics);
    void romanizeAway(lyrics, options)
      .catch(() => lyrics)
      .then((result) => {
        ready[slot].set(lyrics, result);
        if (result === lyrics) return;
        version += 1;
        listeners.forEach((listener) => listener());
      });
  }
  return lyrics;
}

/** What `displayLyrics` needs to romanize, or false when it is off. */
export function romanizeFor(settings: {
  romanized?: boolean;
  romaji_as_written?: boolean;
}): RomanizeOptions | false {
  return settings.romanized
    ? { romajiAsWritten: settings.romaji_as_written !== false }
    : false;
}

/** Re-renders the caller when romanized lyrics finish converting. */
export function useRomanization() {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => version,
  );
}
