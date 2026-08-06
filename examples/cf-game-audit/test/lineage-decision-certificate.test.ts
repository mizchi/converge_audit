import { describe, expect, it } from "vitest";
import {
  audit_browser_ed25519_public_key,
  audit_browser_ed25519_sign,
  audit_browser_ed25519_verify,
  audit_browser_sha256,
} from "../../../_build/js/release/build/x/game_audit/browser_bridge/browser_bridge.js";
import {
  lineageDecisionStatementDigest,
  verifyLineageDecisionCertificate,
  type LineageDecisionCertificate,
  type LineageDecisionStatement,
} from "../src/lineage-decision-certificate";

const ARBITER_SEED =
  "c0c1c2c3c4c5c6c7c8c9cacbcccdcecf" +
  "d0d1d2d3d4d5d6d7d8d9dadbdcdddedf";
const ARBITER_ID = "external-arbiter-a";
const NOW = 2_000_000;
const digest = { hashString: audit_browser_sha256 };
const verifiers = {
  "moonbit-ed25519-v1": { verify: audit_browser_ed25519_verify },
};
const roster = {
  [ARBITER_ID]: {
    scheme: "moonbit-ed25519-v1",
    publicKey: audit_browser_ed25519_public_key(ARBITER_SEED),
  },
};

function provisionalRevocation(
  overrides: Partial<LineageDecisionStatement> = {},
): LineageDecisionStatement {
  return {
    version: 1,
    scope: "reference-game",
    unit: "dungeon-1",
    assetId: "asset-1",
    ancestorId: "a".repeat(64),
    ancestorKind: "origin",
    expectedRevision: 0,
    revision: 1,
    outcome: "revoked",
    reasonCode: "checkpoint_challenge_upheld",
    issuedAtMs: NOW - 1_000,
    expiresAtMs: NOW + 1_000,
    appealDeadlineAtMs: NOW + 60_000,
    appealOfDecisionId: null,
    finalizedAtMs: null,
    ...overrides,
  };
}

function certificate(
  statement: LineageDecisionStatement,
  arbiterId = ARBITER_ID,
): LineageDecisionCertificate {
  const statementDigest = lineageDecisionStatementDigest(statement, digest);
  return {
    statement,
    authentication: {
      scheme: "moonbit-ed25519-v1",
      arbiterId,
      signature: audit_browser_ed25519_sign(ARBITER_SEED, statementDigest),
    },
  };
}

function verify(value: LineageDecisionCertificate, nowMs = NOW) {
  return verifyLineageDecisionCertificate(value, {
    expectedScope: "reference-game",
    expectedUnit: "dungeon-1",
    nowMs,
    maxClockSkewMs: 250,
    roster,
    verifiers,
    digest,
  });
}

describe("lineage decision certificate", () => {
  it("accepts an authenticated provisional revocation", () => {
    expect(verify(certificate(provisionalRevocation()))).toMatchObject({
      ok: true,
      lifecycle: "appeal_open",
      decisionId: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
  });

  it("rejects an unknown arbiter and an unsupported scheme", () => {
    expect(verify(certificate(provisionalRevocation(), "unknown"))).toEqual({
      ok: false,
      reason: "unknown_arbiter",
    });
    const unsupported = certificate(provisionalRevocation());
    unsupported.authentication.scheme = "future-pq-v1";
    expect(verify(unsupported)).toEqual({
      ok: false,
      reason: "arbiter_scheme_mismatch",
    });
  });

  it("rejects missing or invalid signatures and tampered lineage bindings", () => {
    const unsigned = certificate(provisionalRevocation());
    unsigned.authentication.signature = "";
    expect(verify(unsigned)).toEqual({
      ok: false,
      reason: "invalid_signature",
    });

    const tampered = certificate(provisionalRevocation());
    tampered.statement.assetId = "asset-2";
    expect(verify(tampered)).toEqual({
      ok: false,
      reason: "invalid_signature",
    });
  });

  it("admits the skew boundary and rejects expired or future certificates", () => {
    const justExpired = provisionalRevocation({ expiresAtMs: NOW - 250 });
    expect(verify(certificate(justExpired))).toMatchObject({ ok: true });
    const expired = provisionalRevocation({ expiresAtMs: NOW - 251 });
    expect(verify(certificate(expired))).toEqual({
      ok: false,
      reason: "certificate_expired",
    });
    const future = provisionalRevocation({ issuedAtMs: NOW + 251 });
    expect(verify(certificate(future))).toEqual({
      ok: false,
      reason: "certificate_from_future",
    });
  });

  it("requires a monotonic revision and a bounded provisional appeal shape", () => {
    const stale = provisionalRevocation({ revision: 2 });
    expect(verify(certificate(stale))).toEqual({
      ok: false,
      reason: "invalid_revision",
    });
    const noWindow = provisionalRevocation({ appealDeadlineAtMs: null });
    expect(verify(certificate(noWindow))).toEqual({
      ok: false,
      reason: "invalid_lifecycle",
    });
  });

  it("accepts only a finalized appeal bound to the revoked decision", () => {
    const revoked = verify(certificate(provisionalRevocation()));
    if (!revoked.ok) throw new Error(revoked.reason);
    const appeal = provisionalRevocation({
      expectedRevision: 1,
      revision: 2,
      outcome: "eligible",
      reasonCode: "authoritative_replay_accepted",
      appealDeadlineAtMs: null,
      appealOfDecisionId: revoked.decisionId,
      finalizedAtMs: NOW - 1_500,
    });
    expect(verify(certificate(appeal))).toMatchObject({
      ok: true,
      lifecycle: "finalized",
    });
    const unbound = { ...appeal, appealOfDecisionId: null };
    expect(verify(certificate(unbound))).toEqual({
      ok: false,
      reason: "invalid_lifecycle",
    });
  });
});
