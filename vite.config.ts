import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig({
  root: "frontend",
  plugins: [react()],
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
