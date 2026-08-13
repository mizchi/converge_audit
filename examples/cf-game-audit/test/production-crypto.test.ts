import { describe, expect, it } from "vitest";
import {
  audit_browser_ed25519_verify,
  audit_browser_sha256,
} from "../../../_build/js/release/build/x/game_audit/browser_bridge/browser_bridge.js";
import {
  audit_benchmark_make_checkpoint_delivery_authentication,
} from "../../../_build/js/release/build/x/game_audit/worker_fixture/worker_fixture.js";
import {
  STANDARD_WEBCRYPTO_BACKEND_ID,
  createStandardWebCryptoBackend,
  cryptoRuntimeAdmission,
  type AuditCryptoBackend,
} from "../../player-local-runtime/crypto-backend";
import {
  compileVerificationKeyHistory,
  signKeyBoundStatementAsync,
  verifyKeyBoundStatementAsync,
  type VerificationKeyRecord,
} from "../../player-local-runtime/key-lifecycle";
import {
  checkpointDeliveryPartialAuthenticationMatches,
  signCheckpointDeliveryApprovalStandard,
  signCheckpointDeliveryAuthenticationStandard,
  verifyCheckpointDeliveryAuthenticationPartialDual,
  verifyCheckpointDeliveryAuthenticationDual,
  verifyCheckpointDeliveryAuthenticationStandard,
} from "../src/checkpoint-delivery-crypto";
import {
  loadCheckpointRuntime,
  verifyCheckpointDeliveryAuthenticationSync,
  type CheckpointDeliveryAuthentication,
  type CheckpointDeliveryAuthenticationInput,
  type CheckpointDeliveryAuthenticationPolicy,
  type CheckpointRuntimeBoundary,
} from "../src/moonbit";

const RFC_8032_PUBLIC_KEY =
  "d75a980182b10ab7d54bfed3c964073a" +
  "0ee172f3daa62325af021a68f707511a";
const RFC_8032_EMPTY_SIGNATURE =
  "e5564300c360ac729086e2cc806e828a" +
  "84877f1eb8e5d974d873e06522490155" +
  "5fb8821590a33bacc61e39701cf9b46b" +
  "d25bf5f0595bbe24655141438e7a100b";

const experimentalBackend: AuditCryptoBackend = {
  descriptor: {
    id: "experimental-moonbit-sha256-ed25519-v1",
    assurance: "experimental",
    hashScheme: "sha256-v1",
    signatureScheme: "ed25519-v1",
  },
  hashString: async (value) => audit_browser_sha256(value),
  verify: async (publicKey, message, signature) =>
    audit_browser_ed25519_verify(publicKey, message, signature),
};

function cryptoConformance(name: string, backend: AuditCryptoBackend): void {
  describe(`${name} crypto conformance`, () => {
    it("matches SHA-256 and RFC 8032 verification vectors", async () => {
      await expect(backend.hashString("abc")).resolves.toBe(
        "ba7816bf8f01cfea414140de5dae2223" +
          "b00361a396177a9cb410ff61f20015ad",
      );
      await expect(backend.verify(
        RFC_8032_PUBLIC_KEY,
        "",
        RFC_8032_EMPTY_SIGNATURE,
      )).resolves.toBe(true);
      await expect(backend.verify(
        RFC_8032_PUBLIC_KEY,
        "tampered",
        RFC_8032_EMPTY_SIGNATURE,
      )).resolves.toBe(false);
      await expect(backend.verify(
        "not-hex",
        "",
        RFC_8032_EMPTY_SIGNATURE,
      )).resolves.toBe(false);
    });
  });
}

cryptoConformance("experimental MoonBit", experimentalBackend);
const standardBackend = createStandardWebCryptoBackend(crypto);
cryptoConformance("standard WebCrypto", standardBackend);

describe("production crypto admission", () => {
  it("fails closed when production selects an experimental or unknown backend", () => {
    expect(cryptoRuntimeAdmission("production", experimentalBackend.descriptor))
      .toEqual({ ok: false, reason: "production_backend_required" });
    expect(cryptoRuntimeAdmission("production", {
      ...standardBackend.descriptor,
      id: "unknown-backend",
    })).toEqual({ ok: false, reason: "backend_not_allowlisted" });
  });

  it("allows the pinned standard backend and keeps development explicit", () => {
    expect(standardBackend.descriptor.id).toBe(STANDARD_WEBCRYPTO_BACKEND_ID);
    expect(cryptoRuntimeAdmission("production", standardBackend.descriptor))
      .toEqual({ ok: true });
    expect(cryptoRuntimeAdmission("development", experimentalBackend.descriptor))
      .toEqual({ ok: true });
  });
});

describe("standard WebCrypto signer custody", () => {
  it("generates a non-extractable private key and restores the same signer", async () => {
    const generated = await standardBackend.generateSigningKey();

    expect(generated.material.privateKey.type).toBe("private");
    expect(generated.material.privateKey.extractable).toBe(false);
    expect(generated.material.privateKey.usages).toEqual(["sign"]);
    await expect(
      crypto.subtle.exportKey("pkcs8", generated.material.privateKey),
    ).rejects.toThrow();

    const signature = await generated.signer.signDigest("checkpoint-digest");
    await expect(standardBackend.verify(
      generated.signer.publicKey,
      "checkpoint-digest",
      signature,
    )).resolves.toBe(true);

    const restored = await standardBackend.restoreSigningKey(generated.material);
    expect(restored.publicKey).toBe(generated.signer.publicKey);
    expect(Object.keys(restored).sort()).toEqual([
      "publicKey",
      "scheme",
      "signDigest",
    ]);
    expect(JSON.stringify(restored)).not.toMatch(/private|seed/i);
    await expect(standardBackend.verify(
      restored.publicKey,
      "after-restart",
      await restored.signDigest("after-restart"),
    )).resolves.toBe(true);
  });

  it("connects the async backend to versioned key lifecycle admission", async () => {
    const generated = await standardBackend.generateSigningKey();
    const key: VerificationKeyRecord = {
      version: 1,
      keyId: "checkpoint-producer",
      keyVersion: 1,
      subjectId: "player-1",
      purpose: "checkpoint-producer",
      scopeId: "world-1",
      scheme: generated.signer.scheme,
      publicKey: generated.signer.publicKey,
      validFromMs: 0,
      validUntilMs: 1_000,
      revokedAtMs: null,
    };
    const compiled = compileVerificationKeyHistory([key]);
    if (!compiled.ok) throw new Error(compiled.reason);
    const authentication = await signKeyBoundStatementAsync({
      key,
      unitId: "encounter-1",
      statementDigest: "checkpoint-1",
      issuedAtMs: 100,
      signer: generated.signer,
      digest: standardBackend,
    });

    await expect(verifyKeyBoundStatementAsync(authentication, {
      purpose: key.purpose,
      scopeId: key.scopeId,
      unitId: "encounter-1",
      subjectId: key.subjectId,
      statementDigest: "checkpoint-1",
      nowMs: 100,
      maxClockSkewMs: 0,
      history: compiled.history,
      digest: standardBackend,
      verifiers: { [generated.signer.scheme]: standardBackend },
    })).resolves.toEqual({
      ok: true,
      keyId: key.keyId,
      keyVersion: key.keyVersion,
    });
  });
});

const DELIVERY_PRODUCER_SEED =
  "000102030405060708090a0b0c0d0e0f" +
  "101112131415161718191a1b1c1d1e1f";
const DELIVERY_WITNESS_SEED =
  "202122232425262728292a2b2c2d2e2f" +
  "303132333435363738393a3b3c3d3e3f";
const DELIVERY_BOUNDARY: CheckpointRuntimeBoundary = {
  protocol_version: 1,
  purpose: "checkpoint-delivery-test",
  manifest_digest: "manifest-1",
  scope_id: "world-1",
  unit_id: "encounter-1",
};

function deliveryFixture(approvalCount: number): {
  policy: CheckpointDeliveryAuthenticationPolicy;
  authentication: CheckpointDeliveryAuthentication;
} {
  const value = JSON.parse(
    audit_benchmark_make_checkpoint_delivery_authentication(
      DELIVERY_PRODUCER_SEED,
      "producer-1",
      [DELIVERY_WITNESS_SEED],
      ["witness-1"],
      1,
      approvalCount,
      DELIVERY_BOUNDARY.protocol_version,
      DELIVERY_BOUNDARY.purpose,
      DELIVERY_BOUNDARY.manifest_digest,
      DELIVERY_BOUNDARY.scope_id,
      DELIVERY_BOUNDARY.unit_id,
      "authority-1",
      1,
      "checkpoint-0",
      "checkpoint-1",
      "canonical-envelope-1",
    ),
  ) as {
    ok: true;
    policy: CheckpointDeliveryAuthenticationPolicy;
    authentication: CheckpointDeliveryAuthentication;
  };
  if (!value.ok) throw new Error("delivery fixture failed");
  return value;
}

function deliveryInput(authentication: CheckpointDeliveryAuthentication) {
  return {
    boundary: DELIVERY_BOUNDARY,
    destinationId: "authority-1",
    epoch: 1,
    previousCheckpoint: "checkpoint-0",
    checkpointDigest: "checkpoint-1",
    canonicalEnvelope: "canonical-envelope-1",
    policy: deliveryFixture(1).policy,
    authentication,
  };
}

describe("standard checkpoint-delivery authentication", () => {
  it("signs producer and witness bytes with generated non-extractable keys", async () => {
    const runtime = await loadCheckpointRuntime();
    const producer = await standardBackend.generateSigningKey();
    const witness = await standardBackend.generateSigningKey();
    const statement = {
      boundary: DELIVERY_BOUNDARY,
      destinationId: "authority-1",
      epoch: 1,
      previousCheckpoint: "checkpoint-0",
      checkpointDigest: "checkpoint-standard-signed",
      canonicalEnvelope: "canonical-envelope-standard-signed",
    };
    const policy: CheckpointDeliveryAuthenticationPolicy = {
      producer_id: "producer-standard",
      producer_key: producer.signer.publicKey,
      witnesses: [{
        witness_id: "witness-standard",
        witness_key: witness.signer.publicKey,
      }],
      required_approvals: 1,
    };
    const issuedAtMs = 1_000;
    const producerKey: VerificationKeyRecord = {
      version: 1,
      keyId: "producer-standard-key",
      keyVersion: 1,
      subjectId: policy.producer_id,
      purpose: "checkpoint-producer",
      scopeId: DELIVERY_BOUNDARY.scope_id,
      scheme: producer.signer.scheme,
      publicKey: producer.signer.publicKey,
      validFromMs: 0,
      validUntilMs: 10_000,
      revokedAtMs: null,
    };
    const witnessKey: VerificationKeyRecord = {
      version: 1,
      keyId: "witness-standard-key",
      keyVersion: 1,
      subjectId: "witness-standard",
      purpose: "checkpoint-witness",
      scopeId: DELIVERY_BOUNDARY.scope_id,
      scheme: witness.signer.scheme,
      publicKey: witness.signer.publicKey,
      validFromMs: 0,
      validUntilMs: 10_000,
      revokedAtMs: null,
    };
    const compiled = compileVerificationKeyHistory([producerKey, witnessKey]);
    if (!compiled.ok) throw new Error(compiled.reason);
    const migration = {
      keyHistory: compiled.history,
      nowMs: issuedAtMs,
      maxClockSkewMs: 0,
      legacyAcceptUntilMs: 500,
    };
    const producerAuthentication =
      await signCheckpointDeliveryAuthenticationStandard(
        runtime,
        statement,
        "producer-standard",
        producer.signer,
        standardBackend,
        producerKey,
        issuedAtMs,
      );
    expect(producerAuthentication).toMatchObject({
      version: 2,
      producer_key_authentication: {
        keyId: producerKey.keyId,
        keyVersion: producerKey.keyVersion,
      },
    });
    if (!producerAuthentication.producer_key_authentication) {
      throw new Error("missing producer key authentication");
    }
    const producerInput: CheckpointDeliveryAuthenticationInput = {
      ...statement,
      policy,
      authentication: producerAuthentication,
    };
    await expect(verifyCheckpointDeliveryAuthenticationPartialDual(
      runtime,
      producerInput,
      standardBackend,
      migration,
    )).resolves.toMatchObject({
      ok: true,
      producer_id: "producer-standard",
      approval_count: 0,
      quorum_satisfied: false,
    });

    const approval = await signCheckpointDeliveryApprovalStandard(
      runtime,
      producerAuthentication.statement_digest,
      "witness-standard",
      witness.signer,
      standardBackend,
      witnessKey,
      DELIVERY_BOUNDARY.scope_id,
      DELIVERY_BOUNDARY.unit_id,
      issuedAtMs,
    );
    expect(approval).toMatchObject({
      key_authentication: {
        keyId: witnessKey.keyId,
        keyVersion: witnessKey.keyVersion,
      },
    });
    await expect(signCheckpointDeliveryApprovalStandard(
      runtime,
      producerAuthentication.statement_digest,
      "witness-standard",
      witness.signer,
      standardBackend,
      { ...witnessKey, scopeId: "retargeted-world" },
      DELIVERY_BOUNDARY.scope_id,
      DELIVERY_BOUNDARY.unit_id,
      issuedAtMs,
    )).rejects.toThrow("checkpoint_delivery_key_binding_mismatch");
    await expect(verifyCheckpointDeliveryAuthenticationDual(
      runtime,
      {
        ...producerInput,
        authentication: {
          ...producerAuthentication,
          approvals: [approval],
        },
      },
      standardBackend,
      migration,
    )).resolves.toEqual({
      ok: true,
      producer_id: "producer-standard",
      approval_count: 1,
    });

    await expect(verifyCheckpointDeliveryAuthenticationDual(
      runtime,
      {
        ...producerInput,
        authentication: {
          ...producerAuthentication,
          producer_key_authentication: {
            ...producerAuthentication.producer_key_authentication,
            scopeId: "retargeted-world",
          },
          approvals: [approval],
        },
      },
      standardBackend,
      migration,
    )).resolves.toEqual({
      ok: false,
      error: "invalid_producer_key_authentication:expected_binding_mismatch",
    });
  });

  it("accepts legacy checkpoint authentication only before its cutoff", async () => {
    const runtime = await loadCheckpointRuntime();
    const input = deliveryInput(deliveryFixture(1).authentication);
    const compiled = compileVerificationKeyHistory([{
      version: 1,
      keyId: "unused-v2-key",
      keyVersion: 1,
      subjectId: "producer-1",
      purpose: "checkpoint-producer",
      scopeId: DELIVERY_BOUNDARY.scope_id,
      scheme: "ed25519-v1",
      publicKey: input.policy.producer_key,
      validFromMs: 0,
      validUntilMs: 10_000,
      revokedAtMs: null,
    }]);
    if (!compiled.ok) throw new Error(compiled.reason);
    const migration = {
      keyHistory: compiled.history,
      nowMs: 500,
      maxClockSkewMs: 0,
      legacyAcceptUntilMs: 500,
    };
    await expect(verifyCheckpointDeliveryAuthenticationDual(
      runtime,
      input,
      standardBackend,
      migration,
    )).resolves.toEqual({
      ok: false,
      error: "legacy_authentication_expired",
    });
  });

  it("mints an exact partial capability for producer-only collection ingress", async () => {
    const runtime = await loadCheckpointRuntime();
    const input = deliveryInput(deliveryFixture(0).authentication);
    const result = await verifyCheckpointDeliveryAuthenticationPartialDual(
      runtime,
      input,
      standardBackend,
    );
    expect(result).toMatchObject({
      ok: true,
      producer_id: "producer-1",
      approval_count: 0,
      quorum_satisfied: false,
    });
    if (!result.ok) throw new Error(result.error);
    expect(checkpointDeliveryPartialAuthenticationMatches(
      result.capability,
      input,
    )).toBe(true);
    expect(checkpointDeliveryPartialAuthenticationMatches(
      result.capability,
      { ...input, destinationId: "authority-2" },
    )).toBe(false);
  });

  it("refuses a non-production backend before minting a capability", async () => {
    const runtime = await loadCheckpointRuntime();
    const fixture = deliveryFixture(1);
    await expect(verifyCheckpointDeliveryAuthenticationStandard(
      runtime,
      deliveryInput(fixture.authentication),
      experimentalBackend,
    )).resolves.toEqual({
      ok: false,
      error: "production_backend_required",
    });
    await expect(verifyCheckpointDeliveryAuthenticationPartialDual(
      runtime,
      deliveryInput(deliveryFixture(0).authentication),
      experimentalBackend,
    )).resolves.toEqual({
      ok: false,
      error: "production_backend_required",
    });
  });

  it("agrees with the MoonBit capability on a producer plus witness quorum", async () => {
    const runtime = await loadCheckpointRuntime();
    const fixture = deliveryFixture(1);
    await expect(verifyCheckpointDeliveryAuthenticationStandard(
      runtime,
      deliveryInput(fixture.authentication),
      standardBackend,
    )).resolves.toEqual({
      ok: true,
      producer_id: "producer-1",
      approval_count: 1,
    });
    await expect(verifyCheckpointDeliveryAuthenticationDual(
      runtime,
      deliveryInput(fixture.authentication),
      standardBackend,
    )).resolves.toEqual({
      ok: true,
      producer_id: "producer-1",
      approval_count: 1,
    });
  });

  it("rejects retargeting, signature corruption, and under-quorum delivery", async () => {
    const runtime = await loadCheckpointRuntime();
    const fixture = deliveryFixture(1);
    const cases: Array<{
      input: CheckpointDeliveryAuthenticationInput;
      error: string;
    }> = [
      {
        input: {
          ...deliveryInput(fixture.authentication),
          destinationId: "authority-2",
        },
        error: "statement_digest_mismatch",
      },
      {
        input: deliveryInput({
          ...fixture.authentication,
          producer_signature: "00".repeat(64),
        }),
        error: "invalid_producer_signature",
      },
      {
        input: deliveryInput({
          ...fixture.authentication,
          approvals: [{
            ...fixture.authentication.approvals[0],
            signature: "00".repeat(64),
          }],
        }),
        error: "invalid_witness_signature",
      },
      {
        input: deliveryInput(deliveryFixture(0).authentication),
        error: "under_quorum",
      },
    ];

    for (const testCase of cases) {
      const expected = { ok: false, error: testCase.error };
      await expect(verifyCheckpointDeliveryAuthenticationStandard(
        runtime,
        testCase.input,
        standardBackend,
      )).resolves.toEqual(expected);
      expect(verifyCheckpointDeliveryAuthenticationSync(runtime, testCase.input))
        .toEqual(expected);
    }
  });
});
