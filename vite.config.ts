import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const pkg = JSON.parse(
  readFileSync(new URL("./package.json", import.meta.url), "utf8"),
);

const kuromojiDict = new URL("./node_modules/kuromoji/dict/", import.meta.url);
const kuromojiFiles = readdirSync(kuromojiDict).filter((name) =>
  name.endsWith(".dat.gz"),
);

export default defineConfig({
  root: "frontend",
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
    __APP_PLATFORM__: JSON.stringify(
      process.env.TAURI_ENV_PLATFORM ?? process.platform,
    ),
  },
  plugins: [
    react(),
    {
      // Kuromoji's Japanese dictionary for romanization, served and
      // bundled as-is from node_modules at /kuromoji-dict/.
      name: "kuromoji-dictionary",
      configureServer(server) {
        server.middlewares.use("/kuromoji-dict/", (request, response, next) => {
          const name = (request.url ?? "").replace(/^\//, "").split("?")[0];
          if (!kuromojiFiles.includes(name)) return next();
          response.setHeader("Content-Type", "application/octet-stream");
          response.end(readFileSync(new URL(name, kuromojiDict)));
        });
      },
      generateBundle() {
        for (const name of kuromojiFiles)
          this.emitFile({
            type: "asset",
            fileName: `kuromoji-dict/${name}`,
            source: readFileSync(new URL(name, kuromojiDict)),
          });
      },
    },
    {
      name: "bundled-library-notices",
      generateBundle() {
        this.emitFile({
          type: "asset",
          fileName: "THIRD_PARTY_NOTICES.txt",
          source:
            readFileSync(
              new URL("./THIRD_PARTY_NOTICES.md", import.meta.url),
              "utf8",
            ) +
            "\n\n## SpotiFlex\n\nSource: https://github.com/Stormanzanii/SpotiFlex\n\n" +
            readFileSync(new URL("./LICENSE", import.meta.url), "utf8"),
        });
      },
    },
  ],
  resolve: {
    alias: {
      path: fileURLToPath(new URL("./frontend/path-shim.js", import.meta.url)),
      "zlibjs/bin/gunzip.min.js": fileURLToPath(
        new URL("./frontend/zlib-shim.js", import.meta.url),
      ),
    },
  },
  clearScreen: false,
  server: {
    host: "127.0.0.1",
    port: 1420,
    strictPort: true,
    watch: { ignored: ["**/target/**"] },
  },
  build: {
    outDir: "../dist",
    emptyOutDir: true,
    target: ["chrome110", "safari15"],
    rolldownOptions: {
      output: {
        codeSplitting: {
          groups: [
            {
              name: "react",
              test: /[\\/]node_modules[\\/](react|react-dom|scheduler)[\\/]/,
            },
            {
              name: "transliteration",
              test: /[\\/]node_modules[\\/]transliteration[\\/]/,
            },
          ],
        },
      },
    },
  },
  test: { include: ["**/*.test.ts"] },
});
