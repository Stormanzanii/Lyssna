// Kuromoji's browser loader imports zlibjs, which needs a global `this` that
// bundled modules lack. Lyssna replaces that loader's unpacking with the
// browser's own DecompressionStream (romanization.ts), so this stands in.
module.exports = {
  Zlib: {
    Gunzip() {
      throw new Error("Unpacked by DecompressionStream instead");
    },
  },
};
