import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import { readFileSync } from "node:fs";

const pkg = JSON.parse(
  readFileSync(new URL("./package.json", import.meta.url), "utf8"),
);

export default defineConfig({
  root: "frontend",
  define: { __APP_VERSION__: JSON.stringify(pkg.version) },
  plugins: [
    react(),
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
  clearScreen: false,
  server: {
    host: "127.0.0.1",
    port: 1420,
    strictPort: true,
    watch: { ignored: ["**/target/**"] },
  },
  build: { outDir: "../dist", emptyOutDir: true, target: "chrome110" },
  test: { include: ["**/*.test.ts"] },
});
