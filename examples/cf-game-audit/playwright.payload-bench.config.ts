import { defineConfig } from "@playwright/test";
import payload from "./playwright.payload.config.ts";

export default defineConfig({
  ...payload,
  testDir: "./bench",
  testMatch: "payload-pool.browser.spec.ts",
  outputDir: "./test-results/payload-pool-bench",
});
