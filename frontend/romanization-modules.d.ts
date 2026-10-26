/* Kuroshiro and Kuromoji ship no types; the romanizer uses this much. */
declare module "kuroshiro" {
  export default class Kuroshiro {
    init(analyzer: unknown): Promise<void>;
    convert(
      text: string,
      options: { to: "romaji"; mode: "spaced" | "normal" },
    ): Promise<string>;
  }
}
declare module "kuroshiro-analyzer-kuromoji" {
  export default class KuromojiAnalyzer {
    constructor(options: { dictPath: string });
  }
}
declare module "kuromoji/src/loader/BrowserDictionaryLoader.js" {
  const loader: unknown;
  export default loader;
}
