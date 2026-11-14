/* Kuroshiro and Kuromoji ship no types; the romanizer uses this much. */
declare module "kuroshiro" {
  export default class Kuroshiro {
    static Util: {
      kanaToRomaji(
        kana: string,
        system: "hepburn" | "passport" | "nippon",
      ): string;
    };
  }
}
declare module "kuroshiro-analyzer-kuromoji" {
  export default class KuromojiAnalyzer {
    constructor(options: { dictPath: string });
    init(): Promise<void>;
    parse(text: string): Promise<
      {
        surface_form: string;
        reading?: string;
        pronunciation?: string;
        pos?: string;
        pos_detail_1?: string;
      }[]
    >;
  }
}
declare module "kuromoji/src/loader/BrowserDictionaryLoader.js" {
  const loader: unknown;
  export default loader;
}
declare module "kuromoji" {
  const kuromoji: {
    builder(options: { dicPath: string }): {
      build(done: (error: unknown, tokenizer: never) => void): void;
    };
  };
  export default kuromoji;
}
