import {
  cryptoRuntimeAdmission,
  type AsyncAuditSigner,
  type AuditCryptoBackend,
} from "../../player-local-runtime/crypto-backend";
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
    .map((approval): [string, string, string, string, string] => [
      approval.statement_digest,
      approval.witness_id,
      approval.witness_key,
      approval.digest,
      approval.signature,
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
): Promise<CheckpointDeliveryAuthentication> {
  requireProductionSigningBackend(backend);
  requireCompatibleSigner(signer, backend);
  if (producerId === "" || !statementIsValid(statement)) {
    throw new Error("invalid_checkpoint_delivery_statement");
  }
  const statementDigest = await backend.hashString(
    serializeCheckpointDeliveryStatementSync(runtime, statement),
  );
  const producerSignature = await signer.signDigest(statementDigest);
  if (!await backend.verify(
    signer.publicKey,
    statementDigest,
    producerSignature,
  )) {
    throw new Error("checkpoint_delivery_signer_self_check_failed");
  }
  return {
    version: 1,
    producer_id: producerId,
    producer_key: signer.publicKey,
    statement_digest: statementDigest,
    producer_signature: producerSignature,
    approvals: [],
  };
}

export async function signCheckpointDeliveryApprovalStandard(
  runtime: LoadedCheckpointRuntime,
  statementDigest: string,
  witnessId: string,
  signer: AsyncAuditSigner,
  backend: AuditCryptoBackend,
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
  const signature = await signer.signDigest(digest);
  if (!await backend.verify(signer.publicKey, digest, signature)) {
    throw new Error("checkpoint_delivery_signer_self_check_failed");
  }
  return {
    statement_digest: statementDigest,
    witness_id: witnessId,
    witness_key: signer.publicKey,
    digest,
    signature,
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
  if (
    authentication.producer_id !== policy.producer_id ||
    authentication.producer_key !== policy.producer_key
  ) {
    return { ok: false, error: "producer_identity_mismatch" };
  }

  const expectedStatementDigest = await backend.hashString(
    serializeCheckpointDeliveryStatementSync(runtime, input),
  );
  if (authentication.statement_digest !== expectedStatementDigest) {
    return { ok: false, error: "statement_digest_mismatch" };
  }
  if (!await backend.verify(
    authentication.producer_key,
    authentication.statement_digest,
    authentication.producer_signature,
  )) {
    return { ok: false, error: "invalid_producer_signature" };
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
    if (approval.witness_key !== expectedKey) {
      return { ok: false, error: "witness_key_mismatch" };
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
    if (!await backend.verify(
      approval.witness_key,
      approval.digest,
      approval.signature,
    )) {
      return { ok: false, error: "invalid_witness_signature" };
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

/**
 * Migration capability: standard WebCrypto must accept first, then the
 * existing MoonBit verifier must independently reach the same capability.
 */
export async function verifyCheckpointDeliveryAuthenticationDual(
  runtime: LoadedCheckpointRuntime,
  input: CheckpointDeliveryAuthenticationInput,
  backend: AuditCryptoBackend,
): Promise<CheckpointDeliveryAuthenticationVerification> {
  const standard = await verifyCheckpointDeliveryAuthenticationStandard(
    runtime,
    input,
    backend,
  );
  if (!standard.ok) return standard;

  const moonbit = verifyCheckpointDeliveryAuthenticationSync(runtime, input);
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
): Promise<PartialCheckpointDeliveryAuthenticationVerification> {
  const standard = await verifyCheckpointDeliveryAuthenticationStandard(
    runtime,
    input,
    backend,
  );
  if (!standard.ok && standard.error !== "under_quorum") return standard;

  const moonbit = verifyCheckpointDeliveryAuthenticationSync(runtime, input);
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
