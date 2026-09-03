import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "core",
          include: [
            "test/unit/**/*.test.ts",
            "test/properties/**/*.test.ts",
            "test/simulation/**/*.test.ts",
            "test/negative/**/*.test.ts",
          ],
        },
      },
      {
        test: {
          name: "worker",
          include: ["test/worker/**/*.test.ts"],
        },
        plugins: [cloudflareTest({ wrangler: { configPath: "./wrangler.jsonc" } })],
      },
    ],
  },
});
