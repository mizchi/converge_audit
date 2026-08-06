import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
  },
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        bindings: {
          ADMIN_TOKEN: "test-admin-token",
          WITNESS_SOURCE_BUCKET_KEY: "test-source-bucket-key-000000000000",
          LINEAGE_ARBITER_ROSTER: JSON.stringify({
            "external-arbiter-a": {
              scheme: "moonbit-ed25519-v1",
              public_key:
                "dde3bccec7f3a66a1115f45d720f4dc135c3ae7c4e22dca38fdb1efd6a495ff8",
            },
          }),
          LINEAGE_DECISION_MAX_CLOCK_SKEW_MS: "0",
        },
      },
    }),
  ],
});
