import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

const seed =
  "000102030405060708090a0b0c0d0e0f" +
  "101112131415161718191a1b1c1d1e1f";
const publicKey =
  "03a107bff3ce10be1d70dd18e74bc099" +
  "67e4d6309ba50d5f1ddc8664125531b8";

export default defineConfig({
  test: {
    include: ["test/verification-key-signer-worker.test.ts"],
  },
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.key-signer.jsonc" },
      miniflare: {
        bindings: {
          SIGNER_CALLER_TOKEN: "test-signer-caller-token-000000",
          SIGNER_ADMIN_TOKEN: "test-signer-admin-token",
          SIGNING_KEY_SEED_HEX: seed,
          SIGNING_KEY_ID: "source-signing-key",
          SIGNING_KEY_VERSION: "1",
          SIGNING_KEY_LIFECYCLE_REVISION: "1",
          SIGNING_SUBJECT_ID: "evidence-source-a",
          SIGNING_PURPOSE: "evidence-case-resolution",
          SIGNING_SCOPE_ID: "reference-game",
          SIGNING_SCHEME: "ed25519-v1",
          SIGNING_PUBLIC_KEY: publicKey,
          SIGNING_VALID_FROM_MS: "0",
          SIGNING_VALID_UNTIL_MS: "9007199254740991",
          SIGNER_RUNTIME_PROFILE: "test",
        },
      },
    }),
  ],
});
