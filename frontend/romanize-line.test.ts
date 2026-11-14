import { beforeAll, expect, it } from "vitest";
import kuromoji from "kuromoji";
import Kuroshiro from "kuroshiro";
import {
  alignReading,
  koreanSyllables,
  romanizeCyrillicWord,
  romanizePieces,
  type JapaneseToken,
  type Readers,
} from "./romanize-line";

let tokenize: (text: string) => Promise<JapaneseToken[]>;
beforeAll(async () => {
  const tokenizer = await new Promise<{
    tokenize(text: string): JapaneseToken[];
  }>((done, fail) =>
    kuromoji
      .builder({ dicPath: "node_modules/kuromoji/dict" })
      .build((error: unknown, built: never) =>
        error ? fail(error) : done(built),
      ),
  );
  tokenize = async (text) => tokenizer.tokenize(text);
}, 60_000);

const japanese = (asWritten = true): Readers => ({
  japanese: {
    tokenize,
    kanaToRomaji: (kana) => Kuroshiro.Util.kanaToRomaji(kana, "hepburn"),
    asWritten,
  },
});

it("keeps a word's reading when it is split across syllables", async () => {
  expect(await romanizePieces(["一", "緒", "に"], japanese())).toEqual([
    "Issho",
    "",
    " ni",
  ]);
});

it("reads a kanji that sits in a syllable of its own", async () => {
  const out = await romanizePieces(
    ["怒り", "抱", "い", "て", "も"],
    japanese(),
  );
  expect(out.join("")).toBe("Ikari daite mo");
});

it("reads Japanese with a space after every syllable as one line", async () => {
  const spaced = await romanizePieces(["一 ", "緒 ", "に"], japanese());
  expect(spaced.join("")).toBe("Issho ni");
});

it("spells romaji as written or with long vowels", async () => {
  expect((await romanizePieces(["今日は東京へ"], japanese())).join("")).toBe(
    "Kyou wa toukyou e",
  );
  expect((await romanizePieces(["コーヒーを"], japanese())).join("")).toBe(
    "Koohii wo",
  );
  expect(
    (await romanizePieces(["今日は東京へ"], japanese(false))).join(""),
  ).toBe("Kyō wa tōkyō e");
});

it("doubles the sound after a small tsu split from it", async () => {
  expect((await romanizePieces(["ちょっ", "と"], japanese())).join("")).toBe(
    "Chotto",
  );
});

it("splits a reading over the kana written around a kanji", () => {
  expect(alignReading("抱い", "ダイ")).toEqual(["ダ", "イ"]);
  expect(alignReading("一緒", "イッショ")).toEqual(["イッショ", ""]);
  expect(alignReading("行く", "ユク")).toEqual(["ユ", "ク"]);
  expect(alignReading("言う", "ユー")).toBeUndefined();
});

it("reads Korean by how it sounds", () => {
  expect(koreanSyllables("사랑해").join("")).toBe("saranghae");
  expect(koreanSyllables("같이").join("")).toBe("gachi");
  expect(koreanSyllables("합니다").join("")).toBe("hamnida");
  expect(koreanSyllables("한국").join("")).toBe("hanguk");
  expect(koreanSyllables("좋아").join("")).toBe("joa");
  expect(koreanSyllables("신라").join("")).toBe("silla");
  expect(koreanSyllables("안녕하세요").join("")).toBe("annyeonghaseyo");
  // Each syllable keeps its own share for word timing.
  expect(koreanSyllables("같이")).toEqual(["ga", "chi"]);
});

it("reads Chinese by word, spaced", async () => {
  const { pinyin } = await import("pinyin-pro");
  const readers: Readers = {
    pinyin: (text) =>
      pinyin(text, { type: "all" }).map((item) =>
        item.isZh ? item.pinyin : "",
      ),
  };
  expect((await romanizePieces(["长", "大"], readers)).join("")).toBe(
    "Zhǎng dà",
  );
});

it("uses Russian or Ukrainian spelling", async () => {
  expect((await romanizePieces(["Я тебя люблю"], {})).join("")).toBe(
    "Ya tebya lyublyu",
  );
  expect((await romanizePieces(["Київ"], { ukrainian: true })).join("")).toBe(
    "Kyiv",
  );
  expect(romanizeCyrillicWord("ЩАСТЯ", true)).toBe("SHCHASTIA");
  // A word split over syllables keeps its middle-of-word spelling.
  expect(
    (await romanizePieces(["Ки", "їв"], { ukrainian: true })).join(""),
  ).toBe("Kyiv");
});

it("keeps Latin words and spaces as they are", async () => {
  expect(await romanizePieces(["Hello ", "world"], {})).toEqual([
    "Hello ",
    "world",
  ]);
});
