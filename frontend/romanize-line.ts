/* Line-level romanization. A lyric line arrives as pieces (its timed
 * syllables, or the whole line); each script reads the line as one text so
 * words split over syllables keep their reading, and the readings are handed
 * back to the syllable each one starts in. */

export interface JapaneseToken {
  surface_form: string;
  reading?: string;
  pronunciation?: string;
  pos?: string;
  pos_detail_1?: string;
}

export interface Readers {
  japanese?: {
    tokenize: (text: string) => Promise<JapaneseToken[]>;
    kanaToRomaji: (kana: string) => string;
    asWritten: boolean;
  };
  pinyin?: (text: string) => string[];
  ukrainian?: boolean;
}

interface Cell {
  char: string;
  owner: number;
  out: string;
  /** A new word starts here, so the reading gets a space before it. */
  start: boolean;
}

const KANA = /[ぁ-ゖァ-ヺー]/u;
const JAPANESE = /[぀-ヿ\p{Script=Han}々〆ヶ]/u;
const HAN = /\p{Script=Han}/u;
const HANGUL = /[가-힣]/u;
const CYRILLIC = /[Ѐ-ԯ]/u;
const SPACE = /\s/u;

const JAPANESE_MARKS: Record<string, string> = {
  "、": ",",
  "。": ".",
  "「": '"',
  "」": '"',
  "『": '"',
  "』": '"',
  "！": "!",
  "？": "?",
  "～": "~",
  "〜": "~",
  "・": " ",
  "　": " ",
  "（": "(",
  "）": ")",
};

const toKatakana = (text: string) =>
  text.replace(/[ぁ-ゖ]/gu, (kana) =>
    String.fromCharCode(kana.charCodeAt(0) + 0x60),
  );

/** Splits a token's reading over its characters: kana read as themselves
 *  and each kanji run takes what is left, all on the run's first character.
 *  Undefined when the reading does not fit the written kana. */
export function alignReading(surface: string, reading: string) {
  const chars = [...surface];
  const runs: { kana: boolean; text: string; from: number }[] = [];
  chars.forEach((char, index) => {
    const kana = KANA.test(char);
    const last = runs[runs.length - 1];
    if (last && last.kana === kana) last.text += char;
    else runs.push({ kana, text: char, from: index });
  });
  const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(
    `^${runs.map((run) => (run.kana ? escape(toKatakana(run.text)) : "(.+?)")).join("")}$`,
    "u",
  );
  const match = pattern.exec(toKatakana(reading));
  if (!match) return undefined;
  const out = chars.map(() => "");
  let group = 1;
  for (const run of runs) {
    if (run.kana)
      [...run.text].forEach(
        (char, index) => (out[run.from + index] = toKatakana(char)),
      );
    else out[run.from] = match[group++];
  }
  return out;
}

const MACRONS: Record<string, string> = {
  ā: "aa",
  ī: "ii",
  ū: "uu",
  ē: "ee",
  ō: "oo",
  Ā: "Aa",
  Ī: "Ii",
  Ū: "Uu",
  Ē: "Ee",
  Ō: "Oo",
};

async function readJapanese(
  cells: Cell[],
  japanese: NonNullable<Readers["japanese"]>,
) {
  if (!cells.some((cell) => JAPANESE.test(cell.char))) return;
  // Lyrics often put a space after every Japanese syllable; reading those
  // one by one turns kanji into the wrong words.
  const kept: number[] = [];
  const neighbour = (from: number, step: number) => {
    for (let at = from + step; at >= 0 && at < cells.length; at += step)
      if (!SPACE.test(cells[at].char)) return cells[at].char;
    return "";
  };
  cells.forEach((cell, index) => {
    if (
      SPACE.test(cell.char) &&
      JAPANESE.test(neighbour(index, -1)) &&
      JAPANESE.test(neighbour(index, 1))
    )
      cell.out = "";
    else kept.push(index);
  });
  const tokens = await japanese.tokenize(
    kept.map((index) => cells[index].char).join(""),
  );
  let at = 0;
  let previous: JapaneseToken | undefined;
  // A small tsu that ends one token doubles the sound starting the next.
  let carried = "";
  for (const token of tokens) {
    const chars = [...token.surface_form];
    const indices = kept.slice(at, at + chars.length);
    at += chars.length;
    const before = previous;
    previous = token;
    if (!indices.length || !chars.some((char) => JAPANESE.test(char))) {
      carried = "";
      continue;
    }
    const particle = token.pos === "助詞";
    // Endings stay on their word: 抱いて is "daite", 走った "hashitta".
    const attaches =
      ((token.pos === "助動詞" || token.pos_detail_1 === "接続助詞") &&
        ["動詞", "形容詞", "助動詞"].includes(before?.pos ?? "")) ||
      token.pos_detail_1 === "接尾";
    let kana =
      (japanese.asWritten
        ? token.reading
        : token.pronunciation || token.reading) || "";
    if (!kana || kana === "*")
      kana = chars.every((char) => KANA.test(char)) ? token.surface_form : "";
    if (!kana) {
      carried = "";
      continue;
    }
    if (particle && token.surface_form === "は") kana = "ワ";
    if (particle && token.surface_form === "へ") kana = "エ";
    const aligned = alignReading(token.surface_form, kana) ?? [
      toKatakana(kana),
      ...chars.slice(1).map(() => ""),
    ];
    // One piece of reading per syllable the token spans.
    const groups: { first: number; kana: string }[] = [];
    indices.forEach((index, offset) => {
      const last = groups[groups.length - 1];
      if (last && cells[last.first].owner === cells[index].owner)
        last.kana += aligned[offset];
      else groups.push({ first: index, kana: aligned[offset] });
    });
    // Small kana and long marks belong to the sound before them; a small
    // tsu doubles the sound after it.
    for (let index = 1; index < groups.length; index++) {
      const before = groups[index - 1];
      const group = groups[index];
      while (/^[ャュョァィゥェォヮー]/u.test(group.kana)) {
        before.kana += group.kana[0];
        group.kana = group.kana.slice(1);
      }
      if (before.kana.endsWith("ッ") && group.kana) {
        before.kana = before.kana.slice(0, -1);
        group.kana = `ッ${group.kana}`;
      }
    }
    groups[0].kana = carried + groups[0].kana;
    carried = "";
    const last = groups[groups.length - 1];
    if (last.kana.endsWith("ッ")) {
      last.kana = last.kana.slice(0, -1);
      carried = "ッ";
    }
    indices.forEach((index) => (cells[index].out = ""));
    groups.forEach((group, index) => {
      let romaji =
        particle && token.surface_form === "を" && japanese.asWritten
          ? "wo"
          : japanese.kanaToRomaji(group.kana);
      if (japanese.asWritten)
        romaji = romaji.replace(/[āīūēōĀĪŪĒŌ]/gu, (vowel) => MACRONS[vowel]);
      cells[group.first].out = romaji.replace(/ッ/gu, "");
      if (index === 0 && !attaches) cells[group.first].start = true;
    });
  }
  for (const cell of cells)
    if (cell.char in JAPANESE_MARKS && cell.out === cell.char)
      cell.out = JAPANESE_MARKS[cell.char];
}

function readChinese(cells: Cell[], pinyin: NonNullable<Readers["pinyin"]>) {
  if (!cells.some((cell) => HAN.test(cell.char))) return;
  // Read as one text so a character with two readings takes the one its
  // word needs.
  const readings = pinyin(cells.map((cell) => cell.char).join(""));
  cells.forEach((cell, index) => {
    if (HAN.test(cell.char) && readings[index]) {
      cell.out = readings[index];
      cell.start = true;
    }
  });
}

/* Korean: Revised Romanization of how the line sounds. Each final
 * consonant meets the next syllable's initial, which moves it across a
 * silent ㅇ, softens ㄷ/ㅌ before 이, and turns stops nasal before ㄴ/ㅁ. */
const INITIALS = "g kk n d tt r m b pp s ss  j jj ch k t p h".split(" ");
const VOWELS =
  "a ae ya yae eo e yeo ye o wa wae oe yo u wo we wi yu eu ui i".split(" ");
const FINALS = " k k k n n n t l k m l l l p l m p p t t ng t t k t p t".split(
  " ",
);
// Final consonant index to [final left behind, initial carried over].
const CARRY: Record<number, [number, number]> = {
  1: [0, 0],
  2: [0, 1],
  3: [1, 10],
  4: [0, 2],
  5: [4, 12],
  6: [4, 11],
  7: [0, 3],
  8: [0, 5],
  9: [8, 0],
  10: [8, 6],
  11: [8, 7],
  12: [8, 10],
  13: [8, 16],
  14: [8, 17],
  15: [0, 5],
  16: [0, 6],
  17: [0, 7],
  18: [17, 10],
  19: [0, 9],
  20: [0, 10],
  22: [0, 12],
  23: [0, 14],
  24: [0, 15],
  25: [0, 16],
  26: [0, 17],
  27: [0, 11],
};
const K_CLASS = [1, 2, 3, 9, 24];
const T_CLASS = [7, 19, 20, 22, 23, 25, 27];
const P_CLASS = [17, 18, 26, 11, 14];
const ASPIRATE: Record<number, number> = { 0: 15, 3: 16, 12: 14 };
const STOP_ASPIRATE: Record<number, number> = { 1: 15, 7: 16, 17: 17, 22: 14 };

/** Each syllable of a Hangul run as it sounds next to its neighbours. */
export function koreanSyllables(run: string) {
  const syllables = [...run].map((char) => {
    const code = char.charCodeAt(0) - 0xac00;
    return {
      initial: Math.floor(code / 588),
      vowel: Math.floor((code % 588) / 28),
      final: code % 28,
      l: false,
    };
  });
  for (let index = 0; index + 1 < syllables.length; index++) {
    const one = syllables[index];
    const next = syllables[index + 1];
    const final = one.final;
    if (!final) continue;
    if (next.initial === 11 && final !== 21) {
      [one.final, next.initial] = CARRY[final];
      if (next.initial === 5) next.l = false;
      if (next.vowel === 20 && next.initial === 3) next.initial = 12;
      if (next.vowel === 20 && next.initial === 16) next.initial = 14;
    } else if ([27, 6, 15].includes(final) && next.initial in ASPIRATE) {
      one.final = final === 27 ? 0 : final === 6 ? 4 : 8;
      next.initial = ASPIRATE[next.initial];
    } else if (next.initial === 18 && final in STOP_ASPIRATE) {
      one.final = 0;
      next.initial = STOP_ASPIRATE[final];
    } else if (next.initial === 2 || next.initial === 6) {
      if (K_CLASS.includes(final)) one.final = 21;
      else if (T_CLASS.includes(final)) one.final = 4;
      else if (P_CLASS.includes(final)) one.final = 16;
      else if (final === 8 && next.initial === 2) {
        next.initial = 5;
        next.l = true;
      }
    } else if (next.initial === 5) {
      if (final === 4 || final === 8) {
        one.final = 8;
        next.l = true;
      } else if (final === 16 || final === 21) next.initial = 2;
      else if (K_CLASS.includes(final)) {
        one.final = 21;
        next.initial = 2;
      } else if (P_CLASS.includes(final)) {
        one.final = 16;
        next.initial = 2;
      }
    }
  }
  return syllables.map(
    (syllable) =>
      (syllable.l ? "l" : INITIALS[syllable.initial]) +
      VOWELS[syllable.vowel] +
      FINALS[syllable.final],
  );
}

function readKorean(cells: Cell[]) {
  for (let index = 0; index < cells.length;) {
    if (!HANGUL.test(cells[index].char)) {
      index++;
      continue;
    }
    let end = index;
    while (end < cells.length && HANGUL.test(cells[end].char)) end++;
    const run = cells.slice(index, end);
    koreanSyllables(run.map((cell) => cell.char).join("")).forEach(
      (sound, offset) => (run[offset].out = sound),
    );
    index = end;
  }
}

/* Cyrillic: Russian, or Ukrainian when the song uses Ukrainian letters. */
const RUSSIAN: Record<string, string> = {
  а: "a",
  б: "b",
  в: "v",
  г: "g",
  д: "d",
  е: "e",
  ё: "yo",
  ж: "zh",
  з: "z",
  и: "i",
  й: "y",
  к: "k",
  л: "l",
  м: "m",
  н: "n",
  о: "o",
  п: "p",
  р: "r",
  с: "s",
  т: "t",
  у: "u",
  ф: "f",
  х: "kh",
  ц: "ts",
  ч: "ch",
  ш: "sh",
  щ: "shch",
  ъ: "",
  ы: "y",
  ь: "",
  э: "e",
  ю: "yu",
  я: "ya",
  ђ: "dj",
  ј: "j",
  љ: "lj",
  њ: "nj",
  ћ: "c",
  џ: "dz",
  ѓ: "gj",
  ќ: "kj",
  ѕ: "dz",
  ў: "w",
};
const UKRAINIAN: Record<string, string> = {
  ...RUSSIAN,
  г: "h",
  ґ: "g",
  и: "y",
  і: "i",
  ї: "yi",
  є: "ye",
  "'": "",
  "’": "",
};
// Ukrainian spells these differently inside a word than at its start.
const UKRAINIAN_INSIDE: Record<string, string> = {
  ї: "i",
  є: "ie",
  й: "i",
  ю: "iu",
  я: "ia",
};

export function romanizeCyrillicWord(word: string, ukrainian: boolean) {
  const letters = [...word];
  const table = ukrainian ? UKRAINIAN : RUSSIAN;
  const out = letters
    .map((letter, index) => {
      const lower = letter.toLowerCase();
      let latin =
        ukrainian && index > 0 && lower in UKRAINIAN_INSIDE
          ? UKRAINIAN_INSIDE[lower]
          : (table[lower] ?? letter);
      if (
        ukrainian &&
        lower === "г" &&
        letters[index - 1]?.toLowerCase() === "з"
      )
        latin = "gh";
      if (letter !== lower && latin)
        latin =
          word.length > 1 && word === word.toUpperCase()
            ? latin.toUpperCase()
            : latin[0].toUpperCase() + latin.slice(1);
      return latin;
    })
    .join("");
  return out;
}

function readCyrillic(cells: Cell[], ukrainian: boolean) {
  const letter = (char: string) =>
    CYRILLIC.test(char) || (ukrainian && /['’]/u.test(char));
  for (let index = 0; index < cells.length;) {
    if (!CYRILLIC.test(cells[index].char)) {
      index++;
      continue;
    }
    let end = index;
    while (end < cells.length && letter(cells[end].char)) end++;
    const word = cells.slice(index, end);
    // Each syllable's share is read with the word around it, so a letter
    // keeps the spelling it has in the middle of the word.
    let read = 0;
    const owners: Cell[][] = [];
    for (const cell of word) {
      const last = owners[owners.length - 1];
      if (last && last[0].owner === cell.owner) last.push(cell);
      else owners.push([cell]);
    }
    const whole = word.map((cell) => cell.char).join("");
    for (const group of owners) {
      const before = romanizeCyrillicWord(
        whole.slice(0, read + group.length),
        ukrainian,
      );
      const earlier = read
        ? romanizeCyrillicWord(whole.slice(0, read), ukrainian)
        : "";
      group.forEach(
        (cell, offset) =>
          (cell.out = offset ? "" : before.slice(earlier.length)),
      );
      read += group.length;
    }
    index = end;
  }
}

/** Letters of another script, read a syllable's share at a time. */
function readRuns(
  cells: Cell[],
  letter: RegExp,
  read: (text: string) => string,
) {
  for (let index = 0; index < cells.length;) {
    if (!letter.test(cells[index].char)) {
      index++;
      continue;
    }
    let end = index;
    while (
      end < cells.length &&
      letter.test(cells[end].char) &&
      cells[end].owner === cells[index].owner
    )
      end++;
    const run = cells.slice(index, end);
    const text = read(run.map((cell) => cell.char).join(""));
    run.forEach((cell, offset) => (cell.out = offset ? "" : text));
    index = end;
  }
}

/** Each piece of the line romanized, keeping the line's own spaces and
 *  adding one where a read word starts. */
export async function romanizePieces(
  pieces: string[],
  readers: Readers,
  greek: (text: string) => string = (text) => text,
): Promise<string[]> {
  const cells: Cell[] = pieces.flatMap((piece, owner) =>
    [...piece].map((char) => ({ char, owner, out: char, start: false })),
  );
  if (readers.japanese) await readJapanese(cells, readers.japanese);
  else if (readers.pinyin) readChinese(cells, readers.pinyin);
  readKorean(cells);
  readCyrillic(cells, !!readers.ukrainian);
  readRuns(cells, /[Ͱ-Ͽἀ-῿]/u, greek);
  const out = pieces.map(() => "");
  let emitted = "";
  for (const cell of cells) {
    let text = cell.out;
    if (cell.start && /\S$/u.test(emitted) && text && !/^\s/u.test(text))
      text = ` ${text}`;
    out[cell.owner] += text;
    emitted += text;
  }
  // A line that starts with a romanized word starts with a capital.
  const first = cells.find((cell) => /\p{L}/u.test(cell.char));
  if (first && first.out !== first.char) {
    const owner = out.findIndex((text) => /\p{L}/u.test(text));
    if (owner >= 0)
      out[owner] = out[owner].replace(/\p{L}/u, (letter) =>
        letter.toUpperCase(),
      );
  }
  return out;
}
