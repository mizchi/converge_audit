import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    exclude: [
      "test/evidence-resolution-relay-worker.test.ts",
      "test/verification-key-signer-worker.test.ts",
    ],
  },
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        bindings: {
          ADMIN_TOKEN: "test-admin-token",
          // Deterministic fixture only. Deployment must provision its own secret.
          ENCOUNTER_SIGNING_SEED_HEX: "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f",
          ENCOUNTER_SIGNING_PUBLIC_KEY: "03a107bff3ce10be1d70dd18e74bc09967e4d6309ba50d5f1ddc8664125531b8",
          WITNESS_SOURCE_BUCKET_KEY: "test-source-bucket-key-000000000000",
          LINEAGE_ARBITER_ROSTER: JSON.stringify({
            "external-arbiter-a": {
              scheme: "moonbit-ed25519-v1",
              public_key:
                "dde3bccec7f3a66a1115f45d720f4dc135c3ae7c4e22dca38fdb1efd6a495ff8",
            },
          }),
          LINEAGE_DECISION_MAX_CLOCK_SKEW_MS: "0",
          EVIDENCE_HOLD_SOURCE_ROSTER: JSON.stringify({
            "evidence-source-a": {
              scheme: "moonbit-ed25519-v1",
              public_key:
                "13d9908a70925992ed546007d27f50da68ba7217ef62ac3cca784529ff10471c",
            },
          }),
          EVIDENCE_HOLD_SOURCE_KEY_HISTORY: JSON.stringify({
            version: 1,
            keys: [{
              version: 1,
              key_id: "evidence-source-signing-key",
              key_version: 1,
              subject_id: "evidence-source-a",
              purpose: "evidence-case-resolution",
              scope_id: "reference-game",
              scheme: "moonbit-ed25519-v1",
              public_key:
                "13d9908a70925992ed546007d27f50da68ba7217ef62ac3cca784529ff10471c",
              valid_from_ms: 0,
              valid_until_ms: Number.MAX_SAFE_INTEGER,
              revoked_at_ms: null,
            }],
          }),
          EVIDENCE_HOLD_LEGACY_ACCEPT_UNTIL_MS: String(
            Number.MAX_SAFE_INTEGER,
          ),
          EVIDENCE_HOLD_SOURCE_KEY_SCOPE_ID: "reference-game",
          EVIDENCE_HOLD_KEY_MAX_CLOCK_SKEW_MS: "5000",
        },
      },
    }),
  ],
});
