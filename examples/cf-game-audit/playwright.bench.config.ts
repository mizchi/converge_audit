import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./bench",
  testMatch: "player-local-indexeddb.browser.spec.ts",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: "line",
  use: {
    ...devices["Desktop Chrome"],
    baseURL: "http://127.0.0.1:8792",
  },
  webServer: {
    command: "pnpm run dev:e2e",
    url: "http://127.0.0.1:8792/health",
    reuseExistingServer: true,
    timeout: 30_000,
  },
});
