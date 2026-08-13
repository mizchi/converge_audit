import { describe, expect, it } from "vitest";
import { createStandardWebCryptoBackend } from "../../player-local-runtime/crypto-backend";
import { verifyDependentDigestVerificationPlan } from "../../player-local-runtime/dependent-digest-verification-plan";

describe("dependent digest verification plan", () => {
  it("injects an actual child digest into its parent statement", async () => {
    const backend = createStandardWebCryptoBackend(crypto);
    const childDigest = await backend.hashString("child");
    const parentDigest = await backend.hashString(`parent(${childDigest})`);
    const plan = {
      hash_check_count: 2,
      hash_checks: [
        {
          kind: "leaf",
          check_index: 0,
          statement_segments: ["child"],
          dependency_check_indices: [],
          expected_digest: childDigest,
        },
        {
          kind: "parent",
          check_index: 1,
          statement_segments: ["parent(", ")"],
          dependency_check_indices: [0],
          expected_digest: parentDigest,
        },
      ],
    };

    await expect(verifyDependentDigestVerificationPlan(plan, backend))
      .resolves.toEqual({ ok: true, checkCount: 2 });
  });

  it("rejects forward dependencies and detects a broken backend", async () => {
    const backend = createStandardWebCryptoBackend(crypto);
    const childDigest = await backend.hashString("child");
    const plan = {
      hash_check_count: 1,
      hash_checks: [{
        kind: "leaf",
        check_index: 0,
        statement_segments: ["child"],
        dependency_check_indices: [],
        expected_digest: childDigest,
      }],
    };
    await expect(verifyDependentDigestVerificationPlan(
      {
        ...plan,
        hash_checks: [{
          ...plan.hash_checks[0],
          statement_segments: ["", ""],
          dependency_check_indices: [0],
        }],
      },
      backend,
    )).resolves.toEqual({ ok: false, reason: "invalid_plan", checkIndex: 0 });
    await expect(verifyDependentDigestVerificationPlan(plan, {
      hashString: async () => "0".repeat(64),
    })).resolves.toEqual({
      ok: false,
      reason: "digest_mismatch",
      checkIndex: 0,
    });
  });
});
