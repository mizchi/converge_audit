import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./test/browser",
  testMatch: ["bounded-payload-queue.spec.ts", "encounter-lifecycle.spec.ts", "encounter-http.spec.ts", "payload-pool.spec.ts"],
  workers: 1,
  retries: 0,
  reporter: "line",
  use: { ...devices["Desktop Chrome"], baseURL: "http://127.0.0.1:5179" },
  webServer: {
    command: "pnpm exec vite --config vite.config.ts --host 127.0.0.1 --port 5179 --strictPort",
    url: "http://127.0.0.1:5179",
    reuseExistingServer: false,
    timeout: 30_000,
  },
});
