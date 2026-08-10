import { describe, expect, it } from "vitest";
import {
  audit_browser_ed25519_public_key,
  audit_browser_ed25519_sign,
  audit_browser_ed25519_verify,
  audit_browser_sha256,
} from "../../../_build/js/release/build/x/game_audit/browser_bridge/browser_bridge.js";
import {
  canonicalKeyBoundSignatureStatement,
  compileVerificationKeyHistory,
  decodeVerificationKeyHistory,
  signKeyBoundStatement,
  validateVerificationKeyHistory,
  verifyKeyBoundStatement,
  type KeyBoundSigner,
  type KeyLifecycleVerifierRegistry,
  type VerificationKeyRecord,
} from "../../player-local-runtime/key-lifecycle";

const OLD_SEED =
  "000102030405060708090a0b0c0d0e0f" +
  "101112131415161718191a1b1c1d1e1f";
const NEW_SEED =
  "202122232425262728292a2b2c2d2e2f" +
  "303132333435363738393a3b3c3d3e3f";
const SCHEME = "moonbit-ed25519-v1";
const digest = { hashString: audit_browser_sha256 };
const verifiers = {
  [SCHEME]: { verify: audit_browser_ed25519_verify },
};

function key(
  version: number,
  seed: string,
  validFromMs: number,
  validUntilMs: number,
  revokedAtMs: number | null = null,
): VerificationKeyRecord {
  return {
    version: 1,
    keyId: "checkpoint-producer",
    keyVersion: version,
    subjectId: "player-1",
    purpose: "checkpoint-producer",
    scopeId: "world-1",
    scheme: SCHEME,
    publicKey: audit_browser_ed25519_public_key(seed),
    validFromMs,
    validUntilMs,
    revokedAtMs,
  };
}

function signer(seed: string): KeyBoundSigner {
  return {
    scheme: SCHEME,
    publicKey: audit_browser_ed25519_public_key(seed),
    signDigest: (value) => audit_browser_ed25519_sign(seed, value),
  };
}

function verification(
  history: VerificationKeyRecord[],
  authentication: ReturnType<typeof signKeyBoundStatement>,
  overrides: Partial<{
    purpose: string;
    scopeId: string;
    unitId: string;
    subjectId: string;
    statementDigest: string;
    nowMs: number;
    verifiers: KeyLifecycleVerifierRegistry;
  }> = {},
) {
  const compiled = compileVerificationKeyHistory(history);
  if (!compiled.ok) throw new Error(compiled.reason);
  return verifyKeyBoundStatement(authentication, {
    purpose: "checkpoint-producer",
    scopeId: "world-1",
    unitId: "encounter-7",
    subjectId: "player-1",
    statementDigest: "checkpoint-statement-digest-7",
    nowMs: 250,
    maxClockSkewMs: 0,
    history: compiled.history,
    digest,
    verifiers,
    ...overrides,
  });
}

describe("versioned verification-key lifecycle", () => {
  it("canonically binds the checkpoint digest and exact key identity", () => {
    const authentication = signKeyBoundStatement({
      key: key(1, OLD_SEED, 0, 100),
      unitId: "encounter-7",
      statementDigest: "checkpoint-statement-digest-7",
      issuedAtMs: 50,
      signer: signer(OLD_SEED),
      digest,
    });

    expect(canonicalKeyBoundSignatureStatement(authentication)).toBe(
      JSON.stringify([
        "converge-audit-key-bound-signature-v1",
        1,
        "checkpoint-producer",
        "world-1",
        "encounter-7",
        "player-1",
        "checkpoint-producer",
        1,
        SCHEME,
        audit_browser_ed25519_public_key(OLD_SEED),
        "checkpoint-statement-digest-7",
        50,
      ]),
    );
    expect(verification([key(1, OLD_SEED, 0, 100)], authentication)).toEqual({
      ok: true,
      keyId: "checkpoint-producer",
      keyVersion: 1,
    });
  });

  it("verifies an old checkpoint from archived signing-time key state after rotation", () => {
    const oldKey = key(1, OLD_SEED, 0, 100);
    const newKey = key(2, NEW_SEED, 100, 300);
    const authentication = signKeyBoundStatement({
      key: oldKey,
      unitId: "encounter-7",
      statementDigest: "checkpoint-statement-digest-7",
      issuedAtMs: 50,
      signer: signer(OLD_SEED),
      digest,
    });

    expect(validateVerificationKeyHistory([oldKey, newKey])).toEqual({
      ok: true,
    });
    expect(verification([oldKey, newKey], authentication)).toEqual({
      ok: true,
      keyId: "checkpoint-producer",
      keyVersion: 1,
    });
    expect(verification([newKey], authentication)).toEqual({
      ok: false,
      reason: "unknown_key_version",
    });
  });

  it("uses the signed issuance time for validity and effective revocation", () => {
    const issuedAtMs = 50;
    const authentication = signKeyBoundStatement({
      key: key(1, OLD_SEED, 0, 100),
      unitId: "encounter-7",
      statementDigest: "checkpoint-statement-digest-7",
      issuedAtMs,
      signer: signer(OLD_SEED),
      digest,
    });

    expect(verification([
      key(1, OLD_SEED, 0, 100, issuedAtMs + 1),
    ], authentication)).toEqual({
      ok: true,
      keyId: "checkpoint-producer",
      keyVersion: 1,
    });
    expect(verification([
      key(1, OLD_SEED, 0, 100, issuedAtMs),
    ], authentication)).toEqual({
      ok: false,
      reason: "key_revoked_at_issuance",
    });
    expect(verification([
      key(1, OLD_SEED, issuedAtMs + 1, 100),
    ], authentication)).toEqual({
      ok: false,
      reason: "key_not_yet_valid_at_issuance",
    });
    expect(verification([
      key(1, OLD_SEED, 0, issuedAtMs),
    ], authentication)).toEqual({
      ok: false,
      reason: "key_expired_at_issuance",
    });
  });

  it("rejects cross-purpose, cross-scope, and key-version substitution", () => {
    const oldKey = key(1, OLD_SEED, 0, 100);
    const newKey = key(2, NEW_SEED, 100, 300);
    const authentication = signKeyBoundStatement({
      key: oldKey,
      unitId: "encounter-7",
      statementDigest: "checkpoint-statement-digest-7",
      issuedAtMs: 50,
      signer: signer(OLD_SEED),
      digest,
    });

    expect(verification([oldKey, newKey], authentication, {
      purpose: "market-listing",
    })).toEqual({ ok: false, reason: "expected_binding_mismatch" });
    expect(verification([oldKey, newKey], authentication, {
      scopeId: "world-2",
    })).toEqual({ ok: false, reason: "expected_binding_mismatch" });
    expect(verification([oldKey, newKey], {
      ...authentication,
      keyVersion: 2,
    })).toEqual({ ok: false, reason: "key_record_binding_mismatch" });
  });

  it("fails closed on a future statement, unsupported scheme, or bad signature", () => {
    const oldKey = key(1, OLD_SEED, 0, 100);
    const authentication = signKeyBoundStatement({
      key: oldKey,
      unitId: "encounter-7",
      statementDigest: "checkpoint-statement-digest-7",
      issuedAtMs: 50,
      signer: signer(OLD_SEED),
      digest,
    });

    expect(verification([oldKey], authentication, { nowMs: 49 })).toEqual({
      ok: false,
      reason: "statement_from_future",
    });
    expect(verification([oldKey], authentication, { verifiers: {} })).toEqual({
      ok: false,
      reason: "unsupported_scheme",
    });
    expect(verification([oldKey], {
      ...authentication,
      signature: "00".repeat(64),
    })).toEqual({ ok: false, reason: "invalid_signature" });
  });

  it("rejects overlapping rotation records and decodes the snake-case wire history", () => {
    expect(validateVerificationKeyHistory([
      key(1, OLD_SEED, 0, 101),
      key(2, NEW_SEED, 100, 300),
    ])).toEqual({ ok: false, reason: "overlapping_key_versions" });

    const decoded = decodeVerificationKeyHistory(JSON.stringify({
      version: 1,
      keys: [
        {
          version: 1,
          key_id: "checkpoint-producer",
          key_version: 1,
          subject_id: "player-1",
          purpose: "checkpoint-producer",
          scope_id: "world-1",
          scheme: SCHEME,
          public_key: audit_browser_ed25519_public_key(OLD_SEED),
          valid_from_ms: 0,
          valid_until_ms: 100,
          revoked_at_ms: null,
        },
        {
          version: 1,
          key_id: "checkpoint-producer",
          key_version: 2,
          subject_id: "player-1",
          purpose: "checkpoint-producer",
          scope_id: "world-1",
          scheme: SCHEME,
          public_key: audit_browser_ed25519_public_key(NEW_SEED),
          valid_from_ms: 100,
          valid_until_ms: 300,
          revoked_at_ms: null,
        },
      ],
    }));
    expect(decoded).toEqual([
      key(1, OLD_SEED, 0, 100),
      key(2, NEW_SEED, 100, 300),
    ]);
  });

  it("keeps player private material outside the authority authentication wire", () => {
    const privateSeedMarker = OLD_SEED;
    const localSigner = signer(privateSeedMarker);
    const authentication = signKeyBoundStatement({
      key: key(1, OLD_SEED, 0, 100),
      unitId: "encounter-7",
      statementDigest: "checkpoint-statement-digest-7",
      issuedAtMs: 50,
      signer: localSigner,
      digest,
    });

    const authorityWire = JSON.stringify(authentication);
    expect(authorityWire).not.toContain(privateSeedMarker);
    expect(authorityWire).not.toMatch(/private|seed/i);
    expect(verification(
      [key(1, OLD_SEED, 0, 100)],
      JSON.parse(authorityWire),
    )).toEqual({
      ok: true,
      keyId: "checkpoint-producer",
      keyVersion: 1,
    });
  });
});
