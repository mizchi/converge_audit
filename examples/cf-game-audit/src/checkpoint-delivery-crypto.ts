import {
  cryptoRuntimeAdmission,
  type AsyncAuditSigner,
  type AuditCryptoBackend,
} from "../../player-local-runtime/crypto-backend";
import {
  canonicalKeyBoundSignatureStatement,
  compileVerificationKeyHistory,
  decodeVerificationKeyHistory,
  signKeyBoundStatementAsync,
  verifyKeyBoundStatement,
  verifyKeyBoundStatementAsync,
  type CompiledVerificationKeyHistory,
  type KeyBoundAuthentication,
  type VerificationKeyRecord,
} from "../../player-local-runtime/key-lifecycle";
import {
  audit_browser_ed25519_verify,
  audit_browser_sha256,
} from "../../../_build/js/release/build/x/game_audit/browser_bridge/browser_bridge.js";
import {
  serializeCheckpointDeliveryApprovalSync,
  serializeCheckpointDeliveryStatementSync,
  verifyCheckpointDeliveryAuthenticationSync,
  type CheckpointDeliveryAuthenticationInput,
  type CheckpointDeliveryAuthenticationVerification,
  type CheckpointDeliveryApproval,
  type CheckpointDeliveryAuthentication,
  type LoadedCheckpointRuntime,
} from "./moonbit";

export type CheckpointDeliveryStatementInput = Omit<
  CheckpointDeliveryAuthenticationInput,
  "policy" | "authentication"
>;

export const CHECKPOINT_DELIVERY_PRODUCER_PURPOSE = "checkpoint-producer";
export const CHECKPOINT_DELIVERY_WITNESS_PURPOSE = "checkpoint-witness";

export interface CheckpointDeliveryAuthenticationMigration {
  keyHistory: CompiledVerificationKeyHistory;
  nowMs: number;
  maxClockSkewMs: number;
  /** Exclusive cutoff for accepting legacy protocol-v1 authentication. */
  legacyAcceptUntilMs: number;
}

const CHECKPOINT_KEY_HISTORY_CACHE_LIMIT = 256;
const checkpointKeyHistoryCache = new Map<
  string,
  CompiledVerificationKeyHistory
>();

export function checkpointDeliveryAuthenticationMigrationFromPolicy(
  policy: CheckpointDeliveryAuthenticationInput["policy"],
  nowMs: number,
): CheckpointDeliveryAuthenticationMigration | undefined {
  if (
    !Number.isSafeInteger(nowMs) || nowMs < 0 ||
    !Number.isSafeInteger(policy.legacy_accept_until_ms) ||
    (policy.legacy_accept_until_ms as number) < 0 ||
    !Number.isSafeInteger(policy.max_clock_skew_ms) ||
    (policy.max_clock_skew_ms as number) < 0 ||
    (policy.max_clock_skew_ms as number) > 300_000 ||
    !policy.key_history
  ) return undefined;
  const encodedHistory = JSON.stringify(policy.key_history);
  let keyHistory = checkpointKeyHistoryCache.get(encodedHistory);
  if (!keyHistory) {
    const records = decodeVerificationKeyHistory(encodedHistory);
    if (!records) return undefined;
    const compiled = compileVerificationKeyHistory(records);
    if (!compiled.ok) return undefined;
    keyHistory = compiled.history;
    if (checkpointKeyHistoryCache.size >= CHECKPOINT_KEY_HISTORY_CACHE_LIMIT) {
      checkpointKeyHistoryCache.clear();
    }
    checkpointKeyHistoryCache.set(encodedHistory, keyHistory);
  }
  return {
    keyHistory,
    nowMs,
    maxClockSkewMs: policy.max_clock_skew_ms as number,
    legacyAcceptUntilMs: policy.legacy_accept_until_ms as number,
  };
}

const partiallyAuthenticatedCheckpointDelivery = Symbol(
  "partially-authenticated-checkpoint-delivery",
);

/** Opaque, process-local proof that both crypto backends accepted exact bytes. */
export interface PartiallyAuthenticatedCheckpointDelivery {
  readonly [partiallyAuthenticatedCheckpointDelivery]: string;
}

export type PartialCheckpointDeliveryAuthenticationVerification =
  | {
    ok: true;
    producer_id: string;
    approval_count: number;
    quorum_satisfied: boolean;
    capability: PartiallyAuthenticatedCheckpointDelivery;
  }
  | { ok: false; error: string };

function partialAuthenticationBinding(
  input: CheckpointDeliveryAuthenticationInput,
): string {
  const { authentication, boundary, policy } = input;
  const witnesses = policy.witnesses
    .map((witness): [string, string] => [
      witness.witness_id,
      witness.witness_key,
    ])
    .sort((left, right) =>
      JSON.stringify(left).localeCompare(JSON.stringify(right))
    );
  const approvals = authentication.approvals
    .map((approval): [string, string, string, string, string, string] => [
      approval.statement_digest,
      approval.witness_id,
      approval.witness_key,
      approval.digest,
      approval.signature,
      JSON.stringify(approval.key_authentication ?? null),
    ])
    .sort((left, right) =>
      JSON.stringify(left).localeCompare(JSON.stringify(right))
    );
  return JSON.stringify([
    boundary.protocol_version,
    boundary.purpose,
    boundary.manifest_digest,
    boundary.scope_id,
    boundary.unit_id,
    input.destinationId,
    input.epoch,
    input.previousCheckpoint,
    input.checkpointDigest,
    input.canonicalEnvelope,
    policy.producer_id,
    policy.producer_key,
    policy.required_approvals,
    witnesses,
    authentication.version,
    authentication.producer_id,
    authentication.producer_key,
    authentication.statement_digest,
    authentication.producer_signature,
    JSON.stringify(authentication.producer_key_authentication ?? null),
    approvals,
  ]);
}

export function checkpointDeliveryPartialAuthenticationMatches(
  capability: PartiallyAuthenticatedCheckpointDelivery,
  input: CheckpointDeliveryAuthenticationInput,
): boolean {
  return capability[partiallyAuthenticatedCheckpointDelivery] ===
    partialAuthenticationBinding(input);
}

function statementIsValid(
  input: CheckpointDeliveryStatementInput,
): boolean {
  const { boundary } = input;
  return Number.isSafeInteger(boundary.protocol_version) &&
    boundary.protocol_version > 0 &&
    boundary.purpose !== "" &&
    boundary.manifest_digest !== "" &&
    boundary.scope_id !== "" &&
    boundary.unit_id !== "" &&
    input.destinationId !== "" &&
    Number.isSafeInteger(input.epoch) &&
    input.epoch >= 0 &&
    input.previousCheckpoint !== "" &&
    input.checkpointDigest !== "" &&
    input.canonicalEnvelope !== "";
}

function requireProductionSigningBackend(backend: AuditCryptoBackend): void {
  const admission = cryptoRuntimeAdmission("production", backend.descriptor);
  if (!admission.ok) {
    throw new Error(`checkpoint_delivery_signing_refused:${admission.reason}`);
  }
}

function requireCompatibleSigner(
  signer: AsyncAuditSigner,
  backend: AuditCryptoBackend,
): void {
  if (
    signer.scheme !== backend.descriptor.signatureScheme ||
    !/^[0-9a-f]{64}$/.test(signer.publicKey)
  ) {
    throw new Error("checkpoint_delivery_signer_incompatible");
  }
}

export async function signCheckpointDeliveryAuthenticationStandard(
  runtime: LoadedCheckpointRuntime,
  statement: CheckpointDeliveryStatementInput,
  producerId: string,
  signer: AsyncAuditSigner,
  backend: AuditCryptoBackend,
  key: VerificationKeyRecord,
  issuedAtMs: number,
): Promise<CheckpointDeliveryAuthentication> {
  requireProductionSigningBackend(backend);
  requireCompatibleSigner(signer, backend);
  if (producerId === "" || !statementIsValid(statement)) {
    throw new Error("invalid_checkpoint_delivery_statement");
  }
  const statementDigest = await backend.hashString(
    serializeCheckpointDeliveryStatementSync(runtime, statement),
  );
  if (
    key.subjectId !== producerId ||
    key.purpose !== CHECKPOINT_DELIVERY_PRODUCER_PURPOSE ||
    key.scopeId !== statement.boundary.scope_id
  ) throw new Error("checkpoint_delivery_key_binding_mismatch");
  const keyAuthentication = await signKeyBoundStatementAsync({
    key,
    unitId: statement.boundary.unit_id,
    statementDigest,
    issuedAtMs,
    signer,
    digest: backend,
  });
  const keyBoundDigest = await backend.hashString(
    canonicalKeyBoundSignatureStatement(keyAuthentication),
  );
  if (!await backend.verify(
    signer.publicKey,
    keyBoundDigest,
    keyAuthentication.signature,
  )) {
    throw new Error("checkpoint_delivery_signer_self_check_failed");
  }
  return {
    version: 2,
    producer_id: producerId,
    producer_key: signer.publicKey,
    statement_digest: statementDigest,
    producer_signature: keyAuthentication.signature,
    producer_key_authentication: keyAuthentication,
    approvals: [],
  };
}

export async function signCheckpointDeliveryApprovalStandard(
  runtime: LoadedCheckpointRuntime,
  statementDigest: string,
  witnessId: string,
  signer: AsyncAuditSigner,
  backend: AuditCryptoBackend,
  key: VerificationKeyRecord,
  scopeId: string,
  unitId: string,
  issuedAtMs: number,
): Promise<CheckpointDeliveryApproval> {
  requireProductionSigningBackend(backend);
  requireCompatibleSigner(signer, backend);
  if (!/^[0-9a-f]{64}$/.test(statementDigest) || witnessId === "") {
    throw new Error("invalid_checkpoint_delivery_approval_statement");
  }
  const digest = await backend.hashString(
    serializeCheckpointDeliveryApprovalSync(
      runtime,
      statementDigest,
      witnessId,
    ),
  );
  if (
    key.subjectId !== witnessId ||
    key.purpose !== CHECKPOINT_DELIVERY_WITNESS_PURPOSE ||
    key.scopeId !== scopeId
  ) throw new Error("checkpoint_delivery_key_binding_mismatch");
  const keyAuthentication = await signKeyBoundStatementAsync({
    key,
    unitId,
    statementDigest: digest,
    issuedAtMs,
    signer,
    digest: backend,
  });
  const keyBoundDigest = await backend.hashString(
    canonicalKeyBoundSignatureStatement(keyAuthentication),
  );
  if (!await backend.verify(
    signer.publicKey,
    keyBoundDigest,
    keyAuthentication.signature,
  )) {
    throw new Error("checkpoint_delivery_signer_self_check_failed");
  }
  return {
    statement_digest: statementDigest,
    witness_id: witnessId,
    witness_key: signer.publicKey,
    digest,
    signature: keyAuthentication.signature,
    key_authentication: keyAuthentication,
  };
}

function policyIsValid(
  input: CheckpointDeliveryAuthenticationInput,
): boolean {
  const { policy } = input;
  if (
    policy.producer_id === "" ||
    policy.producer_key === "" ||
    !Array.isArray(policy.witnesses) ||
    policy.witnesses.length === 0 ||
    !Number.isSafeInteger(policy.required_approvals) ||
    policy.required_approvals <= 0 ||
    policy.required_approvals > policy.witnesses.length
  ) {
    return false;
  }
  const ids = new Set<string>();
  const keys = new Set<string>();
  for (const witness of policy.witnesses) {
    if (
      witness.witness_id === "" ||
      witness.witness_key === "" ||
      witness.witness_id === policy.producer_id ||
      witness.witness_key === policy.producer_key ||
      ids.has(witness.witness_id) ||
      keys.has(witness.witness_key)
    ) {
      return false;
    }
    ids.add(witness.witness_id);
    keys.add(witness.witness_key);
  }
  return true;
}

/**
 * Verify the MoonBit-defined checkpoint-delivery statement with the platform
 * SHA-256/Ed25519 implementation. This function is pure with respect to
 * checkpoint state: it performs no persistence or runtime mutation.
 */
export async function verifyCheckpointDeliveryAuthenticationStandard(
  runtime: LoadedCheckpointRuntime,
  input: CheckpointDeliveryAuthenticationInput,
  backend: AuditCryptoBackend,
  migration?: CheckpointDeliveryAuthenticationMigration,
): Promise<CheckpointDeliveryAuthenticationVerification> {
  const admission = cryptoRuntimeAdmission("production", backend.descriptor);
  if (!admission.ok) {
    return { ok: false, error: admission.reason };
  }
  if (!statementIsValid(input)) {
    return { ok: false, error: "invalid_statement" };
  }
  if (!policyIsValid(input)) {
    return { ok: false, error: "invalid_policy" };
  }

  const { authentication, policy } = input;
  if (authentication.producer_id !== policy.producer_id) {
    return { ok: false, error: "producer_identity_mismatch" };
  }

  const expectedStatementDigest = await backend.hashString(
    serializeCheckpointDeliveryStatementSync(runtime, input),
  );
  if (authentication.statement_digest !== expectedStatementDigest) {
    return { ok: false, error: "statement_digest_mismatch" };
  }
  if (authentication.version === 1) {
    const nowMs = migration?.nowMs ?? 0;
    const legacyAcceptUntilMs = migration?.legacyAcceptUntilMs ??
      Number.MAX_SAFE_INTEGER;
    if (nowMs >= legacyAcceptUntilMs) {
      return { ok: false, error: "legacy_authentication_expired" };
    }
    if (authentication.producer_key !== policy.producer_key) {
      return { ok: false, error: "producer_identity_mismatch" };
    }
    if (!await backend.verify(
      authentication.producer_key,
      authentication.statement_digest,
      authentication.producer_signature,
    )) {
      return { ok: false, error: "invalid_producer_signature" };
    }
  } else {
    if (!migration) {
      return { ok: false, error: "verification_key_history_unavailable" };
    }
    const keyAuthentication = authentication.producer_key_authentication;
    if (!flattenedKeyAuthenticationMatches(
      authentication.producer_key,
      authentication.producer_signature,
      keyAuthentication,
    )) {
      return { ok: false, error: "producer_key_authentication_mismatch" };
    }
    const verification = await verifyKeyBoundStatementAsync(
      keyAuthentication,
      {
        purpose: CHECKPOINT_DELIVERY_PRODUCER_PURPOSE,
        scopeId: input.boundary.scope_id,
        unitId: input.boundary.unit_id,
        subjectId: authentication.producer_id,
        statementDigest: expectedStatementDigest,
        nowMs: migration.nowMs,
        maxClockSkewMs: migration.maxClockSkewMs,
        history: migration.keyHistory,
        digest: backend,
        verifiers: {
          "ed25519-v1": backend,
          "moonbit-ed25519-v1": backend,
        },
      },
    );
    if (!verification.ok) {
      return {
        ok: false,
        error: `invalid_producer_key_authentication:${verification.reason}`,
      };
    }
  }

  const witnessKeys = new Map(
    policy.witnesses.map((witness) => [
      witness.witness_id,
      witness.witness_key,
    ]),
  );
  const approved = new Set<string>();
  for (const approval of authentication.approvals) {
    if (approval.statement_digest !== authentication.statement_digest) {
      return { ok: false, error: "approval_statement_mismatch" };
    }
    if (approved.has(approval.witness_id)) {
      return { ok: false, error: "duplicate_witness" };
    }
    const expectedKey = witnessKeys.get(approval.witness_id);
    if (expectedKey === undefined) {
      return { ok: false, error: "unknown_witness" };
    }
    const expectedApprovalDigest = await backend.hashString(
      serializeCheckpointDeliveryApprovalSync(
        runtime,
        approval.statement_digest,
        approval.witness_id,
      ),
    );
    if (approval.digest !== expectedApprovalDigest) {
      return { ok: false, error: "approval_digest_mismatch" };
    }
    if (approval.key_authentication === undefined) {
      if (authentication.version === 2) {
        return { ok: false, error: "witness_key_authentication_mismatch" };
      }
      const nowMs = migration?.nowMs ?? 0;
      const legacyAcceptUntilMs = migration?.legacyAcceptUntilMs ??
        Number.MAX_SAFE_INTEGER;
      if (nowMs >= legacyAcceptUntilMs) {
        return { ok: false, error: "legacy_authentication_expired" };
      }
      if (approval.witness_key !== expectedKey) {
        return { ok: false, error: "witness_key_mismatch" };
      }
      if (!await backend.verify(
        approval.witness_key,
        approval.digest,
        approval.signature,
      )) {
        return { ok: false, error: "invalid_witness_signature" };
      }
    } else {
      if (!migration) {
        return { ok: false, error: "verification_key_history_unavailable" };
      }
      if (!flattenedKeyAuthenticationMatches(
        approval.witness_key,
        approval.signature,
        approval.key_authentication,
      )) {
        return { ok: false, error: "witness_key_authentication_mismatch" };
      }
      const verification = await verifyKeyBoundStatementAsync(
        approval.key_authentication,
        {
          purpose: CHECKPOINT_DELIVERY_WITNESS_PURPOSE,
          scopeId: input.boundary.scope_id,
          unitId: input.boundary.unit_id,
          subjectId: approval.witness_id,
          statementDigest: expectedApprovalDigest,
          nowMs: migration.nowMs,
          maxClockSkewMs: migration.maxClockSkewMs,
          history: migration.keyHistory,
          digest: backend,
          verifiers: {
            "ed25519-v1": backend,
            "moonbit-ed25519-v1": backend,
          },
        },
      );
      if (!verification.ok) {
        return {
          ok: false,
          error: `invalid_witness_key_authentication:${verification.reason}`,
        };
      }
    }
    approved.add(approval.witness_id);
  }

  if (approved.size < policy.required_approvals) {
    return { ok: false, error: "under_quorum" };
  }
  return {
    ok: true,
    producer_id: authentication.producer_id,
    approval_count: approved.size,
  };
}

function flattenedKeyAuthenticationMatches(
  publicKey: string,
  signature: string,
  authentication: KeyBoundAuthentication | undefined,
): authentication is KeyBoundAuthentication {
  return authentication !== undefined &&
    authentication.publicKey === publicKey &&
    authentication.signature === signature;
}

/**
 * Migration capability: standard WebCrypto must accept first, then the
 * existing MoonBit verifier must independently reach the same capability.
 */
export async function verifyCheckpointDeliveryAuthenticationDual(
  runtime: LoadedCheckpointRuntime,
  input: CheckpointDeliveryAuthenticationInput,
  backend: AuditCryptoBackend,
  migration?: CheckpointDeliveryAuthenticationMigration,
): Promise<CheckpointDeliveryAuthenticationVerification> {
  const standard = await verifyCheckpointDeliveryAuthenticationStandard(
    runtime,
    input,
    backend,
    migration,
  );
  if (!standard.ok) return standard;

  const hasKeyBoundAuthentication = input.authentication.version === 2 ||
    input.authentication.approvals.some((approval) =>
      approval.key_authentication !== undefined
    );
  const moonbit = !hasKeyBoundAuthentication
    ? verifyCheckpointDeliveryAuthenticationSync(runtime, input)
    : verifyCheckpointDeliveryKeyBoundAuthenticationSync(
      runtime,
      input,
      migration,
    );
  if (!moonbit.ok) return moonbit;
  if (
    moonbit.producer_id !== standard.producer_id ||
    moonbit.approval_count !== standard.approval_count
  ) {
    return { ok: false, error: "backend_verification_mismatch" };
  }
  return standard;
}

/**
 * Authenticate a producer-only or partially approved delivery without
 * treating an otherwise valid under-quorum bundle as malformed. The returned
 * capability is required by witness-collection mutation APIs.
 */
export async function verifyCheckpointDeliveryAuthenticationPartialDual(
  runtime: LoadedCheckpointRuntime,
  input: CheckpointDeliveryAuthenticationInput,
  backend: AuditCryptoBackend,
  migration?: CheckpointDeliveryAuthenticationMigration,
): Promise<PartialCheckpointDeliveryAuthenticationVerification> {
  const standard = await verifyCheckpointDeliveryAuthenticationStandard(
    runtime,
    input,
    backend,
    migration,
  );
  if (!standard.ok && standard.error !== "under_quorum") return standard;

  const hasKeyBoundAuthentication = input.authentication.version === 2 ||
    input.authentication.approvals.some((approval) =>
      approval.key_authentication !== undefined
    );
  const moonbit = !hasKeyBoundAuthentication
    ? verifyCheckpointDeliveryAuthenticationSync(runtime, input)
    : verifyCheckpointDeliveryKeyBoundAuthenticationSync(
      runtime,
      input,
      migration,
    );
  if (!moonbit.ok && moonbit.error !== "under_quorum") return moonbit;
  if (standard.ok !== moonbit.ok) {
    return { ok: false, error: "backend_verification_mismatch" };
  }
  if (
    standard.ok && moonbit.ok &&
    (standard.producer_id !== moonbit.producer_id ||
      standard.approval_count !== moonbit.approval_count)
  ) {
    return { ok: false, error: "backend_verification_mismatch" };
  }

  const approvalCount = input.authentication.approvals.length;
  return {
    ok: true,
    producer_id: input.authentication.producer_id,
    approval_count: approvalCount,
    quorum_satisfied: standard.ok,
    capability: Object.freeze({
      [partiallyAuthenticatedCheckpointDelivery]:
        partialAuthenticationBinding(input),
    }),
  };
}

function verifyCheckpointDeliveryKeyBoundAuthenticationSync(
  runtime: LoadedCheckpointRuntime,
  input: CheckpointDeliveryAuthenticationInput,
  migration: CheckpointDeliveryAuthenticationMigration | undefined,
): CheckpointDeliveryAuthenticationVerification {
  if (!migration) {
    return { ok: false, error: "verification_key_history_unavailable" };
  }
  const authentication = input.authentication;
  const statementDigest = audit_browser_sha256(
    serializeCheckpointDeliveryStatementSync(runtime, input),
  );
  if (statementDigest !== authentication.statement_digest) {
    return { ok: false, error: "backend_verification_mismatch" };
  }
  if (authentication.version === 2) {
    if (!authentication.producer_key_authentication) {
      return { ok: false, error: "producer_key_authentication_mismatch" };
    }
    const producer = verifyKeyBoundStatement(
      authentication.producer_key_authentication,
      {
        purpose: CHECKPOINT_DELIVERY_PRODUCER_PURPOSE,
        scopeId: input.boundary.scope_id,
        unitId: input.boundary.unit_id,
        subjectId: authentication.producer_id,
        statementDigest,
        nowMs: migration.nowMs,
        maxClockSkewMs: migration.maxClockSkewMs,
        history: migration.keyHistory,
        digest: { hashString: audit_browser_sha256 },
        verifiers: {
          "ed25519-v1": { verify: audit_browser_ed25519_verify },
          "moonbit-ed25519-v1": { verify: audit_browser_ed25519_verify },
        },
      },
    );
    if (!producer.ok) {
      return {
        ok: false,
        error: `invalid_producer_key_authentication:${producer.reason}`,
      };
    }
  } else {
    const legacyProducer = verifyCheckpointDeliveryAuthenticationSync(
      runtime,
      {
        ...input,
        authentication: { ...authentication, approvals: [] },
      },
    );
    if (legacyProducer.ok || legacyProducer.error !== "under_quorum") {
      return legacyProducer;
    }
  }
  for (const approval of authentication.approvals) {
    const approvalDigest = audit_browser_sha256(
      serializeCheckpointDeliveryApprovalSync(
        runtime,
        statementDigest,
        approval.witness_id,
      ),
    );
    if (approvalDigest !== approval.digest) {
      return { ok: false, error: "backend_verification_mismatch" };
    }
    if (!approval.key_authentication) {
      const legacy = verifyCheckpointDeliveryAuthenticationSync(runtime, {
        ...input,
        authentication: { ...authentication, approvals: [approval] },
      });
      if (legacy.ok || legacy.error !== "under_quorum") return legacy;
      continue;
    }
    const witness = verifyKeyBoundStatement(approval.key_authentication, {
      purpose: CHECKPOINT_DELIVERY_WITNESS_PURPOSE,
      scopeId: input.boundary.scope_id,
      unitId: input.boundary.unit_id,
      subjectId: approval.witness_id,
      statementDigest: approvalDigest,
      nowMs: migration.nowMs,
      maxClockSkewMs: migration.maxClockSkewMs,
      history: migration.keyHistory,
      digest: { hashString: audit_browser_sha256 },
      verifiers: {
        "ed25519-v1": { verify: audit_browser_ed25519_verify },
        "moonbit-ed25519-v1": { verify: audit_browser_ed25519_verify },
      },
    });
    if (!witness.ok) {
      return {
        ok: false,
        error: `invalid_witness_key_authentication:${witness.reason}`,
      };
    }
  }
  if (authentication.approvals.length < input.policy.required_approvals) {
    return { ok: false, error: "under_quorum" };
  }
  return {
    ok: true,
    producer_id: authentication.producer_id,
    approval_count: authentication.approvals.length,
  };
}
