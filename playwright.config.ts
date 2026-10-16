import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "tests/frontend",
  use: {
    baseURL: "http://127.0.0.1:1420",
    viewport: { width: 1600, height: 1000 },
  },
  webServer: {
    command: "npm run dev",
    url: "http://127.0.0.1:1420",
    reuseExistingServer: !process.env.CI,
  },
});
