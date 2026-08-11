import { describe, expect, it } from "vitest";
import { createStandardWebCryptoBackend } from "../../player-local-runtime/crypto-backend";
import { verifyDigestVerificationPlan } from "../../player-local-runtime/digest-verification-plan";

describe("digest verification plan", () => {
  it("executes canonical digest checks without owning their semantics", async () => {
    const backend = createStandardWebCryptoBackend(crypto);
    const canonicalStatement = "MoonBit-owned canonical statement";
    const expectedDigest = await backend.hashString(canonicalStatement);
    const plan = {
      hash_check_count: 1,
      hash_checks: [{
        kind: "example_digest",
        check_index: 0,
        canonical_statement: canonicalStatement,
        expected_digest: expectedDigest,
      }],
    };

    await expect(verifyDigestVerificationPlan(plan, backend)).resolves.toEqual({
      ok: true,
      checkCount: 1,
    });
    await expect(verifyDigestVerificationPlan(
      { ...plan, hash_check_count: 2 },
      backend,
    )).resolves.toEqual({
      ok: false,
      reason: "invalid_plan",
      checkIndex: 0,
    });
    await expect(verifyDigestVerificationPlan(
      plan,
      { hashString: async () => "0".repeat(64) },
    )).resolves.toEqual({
      ok: false,
      reason: "digest_mismatch",
      checkIndex: 0,
    });
  });
});
