import { describe, expect, it } from "vitest";
import {
  audit_browser_ed25519_public_key,
  audit_browser_ed25519_sign,
  audit_browser_ed25519_verify,
  audit_browser_sha256,
} from "../../../_build/js/release/build/x/game_audit/browser_bridge/browser_bridge.js";
import {
  evidenceCaseDismissalStatementDigest,
  verifyEvidenceCaseDismissalCertificate,
  type EvidenceCaseDismissalCertificate,
  type EvidenceCaseDismissalStatement,
} from "../src/evidence-case-dismissal-certificate";

const seed =
  "c0c1c2c3c4c5c6c7c8c9cacbcccdcecf" +
  "d0d1d2d3d4d5d6d7d8d9dadbdcdddedf";
const digest = { hashString: audit_browser_sha256 };
const roster = {
  "external-arbiter-a": {
    scheme: "moonbit-ed25519-v1",
    publicKey: audit_browser_ed25519_public_key(seed),
  },
};
const verifiers = {
  "moonbit-ed25519-v1": { verify: audit_browser_ed25519_verify },
};
const now = 2_000_000;

function statement(
  overrides: Partial<EvidenceCaseDismissalStatement> = {},
): EvidenceCaseDismissalStatement {
  return {
    version: 1,
    scope: "reference-game",
    unit: "dungeon-1",
    evidenceCaseId: "c".repeat(64),
    reasonCode: "challenge_not_reproduced",
    issuedAtMs: now - 1,
    expiresAtMs: now + 1_000,
    ...overrides,
  };
}

function certificate(
  value: EvidenceCaseDismissalStatement,
): EvidenceCaseDismissalCertificate {
  const statementDigest = evidenceCaseDismissalStatementDigest(value, digest);
  return {
    statement: value,
    authentication: {
      scheme: "moonbit-ed25519-v1",
      arbiterId: "external-arbiter-a",
      signature: audit_browser_ed25519_sign(seed, statementDigest),
    },
  };
}

function verify(value: EvidenceCaseDismissalCertificate) {
  return verifyEvidenceCaseDismissalCertificate(value, {
    expectedScope: "reference-game",
    expectedUnit: "dungeon-1",
    nowMs: now,
    maxClockSkewMs: 0,
    roster,
    verifiers,
    digest,
  });
}

describe("evidence case dismissal certificate", () => {
  it("accepts a signed exact case dismissal", () => {
    expect(verify(certificate(statement()))).toMatchObject({
      ok: true,
      dismissalId: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
  });

  it("rejects retargeting, expiry, and an unknown arbiter", () => {
    const retargeted = certificate(statement());
    retargeted.statement.evidenceCaseId = "d".repeat(64);
    expect(verify(retargeted)).toEqual({
      ok: false,
      reason: "invalid_signature",
    });
    expect(verify(certificate(statement({ expiresAtMs: now - 1 })))).toEqual({
      ok: false,
      reason: "certificate_expired",
    });
    const unknown = certificate(statement());
    unknown.authentication.arbiterId = "unknown";
    expect(verify(unknown)).toEqual({
      ok: false,
      reason: "unknown_arbiter",
    });
  });
});
