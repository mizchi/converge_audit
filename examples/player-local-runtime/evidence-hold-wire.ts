import {
  isNonNegativeInteger,
  playerLocalEvidenceHoldValid,
  samePlayerLocalBoundary,
  type AuditBoundary,
  type Awaitable,
  type PlayerLocalEvidenceHold,
  type PlayerLocalEvidenceInboxOperation,
  type PlayerLocalEvidenceHoldResolution,
} from "./contracts.ts";

export type PlayerLocalEvidenceHoldOperation = PlayerLocalEvidenceInboxOperation;

export interface PlayerLocalEvidenceHoldUnsignedEnvelope {
  version: 1;
  source_id: string;
  message_id: string;
  sequence: number;
  previous_message_digest: string;
  operation: PlayerLocalEvidenceHoldOperation;
}

export interface PlayerLocalEvidenceHoldEnvelope
  extends PlayerLocalEvidenceHoldUnsignedEnvelope {
  message_digest: string;
  authentication: unknown;
}

export interface PlayerLocalEvidenceHoldAuthenticator {
  verify(input: {
    source_id: string;
    canonical_statement: string;
    message_digest: string;
    authentication: unknown;
  }): Awaitable<boolean>;
}

export type PlayerLocalEvidenceHoldEnvelopeDecodeResult =
  | { ok: true; envelope: PlayerLocalEvidenceHoldEnvelope }
  | {
      ok: false;
      reason: "invalid_envelope" | "source_mismatch" | "boundary_mismatch";
    };

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function boundedString(value: unknown, maxLength: number): value is string {
  return typeof value === "string" && value.length > 0 &&
    value.length <= maxLength;
}

function auditBoundary(value: unknown): AuditBoundary | undefined {
  if (!isRecord(value)) return undefined;
  const protocolVersion = value.protocol_version;
  const purpose = value.purpose;
  const manifestDigest = value.manifest_digest;
  const scopeId = value.scope_id;
  const unitId = value.unit_id;
  if (
    typeof protocolVersion !== "number" ||
    !Number.isSafeInteger(protocolVersion) ||
    protocolVersion <= 0 ||
    !boundedString(purpose, 256) ||
    !boundedString(manifestDigest, 4_096) ||
    !boundedString(scopeId, 4_096) ||
    !boundedString(unitId, 256)
  ) return undefined;
  return {
    protocol_version: protocolVersion,
    purpose,
    manifest_digest: manifestDigest,
    scope_id: scopeId,
    unit_id: unitId,
  };
}

function evidenceHold(value: unknown): PlayerLocalEvidenceHold | undefined {
  if (!isRecord(value)) return undefined;
  const boundary = auditBoundary(value.boundary);
  const state = value.state;
  if (
    !boundary ||
    !isRecord(state) ||
    state.kind !== "active" ||
    !boundedString(value.hold_id, 256) ||
    typeof value.epoch !== "number" ||
    !isNonNegativeInteger(value.epoch) ||
    !boundedString(value.checkpoint_digest, 4_096) ||
    (value.kind !== "fork" && value.kind !== "challenge" &&
      value.kind !== "appeal") ||
    !boundedString(value.reference_digest, 4_096)
  ) return undefined;
  const hold: PlayerLocalEvidenceHold = {
    boundary,
    hold_id: value.hold_id,
    epoch: value.epoch,
    checkpoint_digest: value.checkpoint_digest,
    kind: value.kind,
    reference_digest: value.reference_digest,
    state: { kind: "active" },
  };
  return playerLocalEvidenceHoldValid(boundary, hold) ? hold : undefined;
}

function evidenceHoldResolution(
  value: unknown,
): PlayerLocalEvidenceHoldResolution | undefined {
  if (!isRecord(value)) return undefined;
  const boundary = auditBoundary(value.boundary);
  if (
    !boundary ||
    !boundedString(value.hold_id, 256) ||
    typeof value.epoch !== "number" ||
    !isNonNegativeInteger(value.epoch) ||
    !boundedString(value.checkpoint_digest, 4_096) ||
    !boundedString(value.reference_digest, 4_096) ||
    (value.decision !== "upheld" && value.decision !== "dismissed") ||
    !boundedString(value.resolution_digest, 4_096)
  ) return undefined;
  return {
    boundary,
    hold_id: value.hold_id,
    epoch: value.epoch,
    checkpoint_digest: value.checkpoint_digest,
    reference_digest: value.reference_digest,
    decision: value.decision,
    resolution_digest: value.resolution_digest,
  };
}

export function decodePlayerLocalEvidenceHoldEnvelope(
  value: unknown,
  expectedBoundary: AuditBoundary,
  expectedSourceId: string,
): PlayerLocalEvidenceHoldEnvelopeDecodeResult {
  if (
    !isRecord(value) ||
    value.version !== 1 ||
    !boundedString(value.source_id, 256) ||
    !boundedString(value.message_id, 256) ||
    typeof value.sequence !== "number" ||
    !isNonNegativeInteger(value.sequence) ||
    !boundedString(value.previous_message_digest, 4_096) ||
    !boundedString(value.message_digest, 4_096) ||
    value.message_digest === value.previous_message_digest ||
    !Object.hasOwn(value, "authentication") ||
    !isRecord(value.operation)
  ) return { ok: false, reason: "invalid_envelope" };
  if (value.source_id !== expectedSourceId) {
    return { ok: false, reason: "source_mismatch" };
  }
  let operation: PlayerLocalEvidenceHoldOperation;
  if (value.operation.kind === "place") {
    const hold = evidenceHold(value.operation.hold);
    if (!hold) return { ok: false, reason: "invalid_envelope" };
    operation = { kind: "place", hold };
  } else if (value.operation.kind === "resolve") {
    const resolution = evidenceHoldResolution(value.operation.resolution);
    if (!resolution) return { ok: false, reason: "invalid_envelope" };
    operation = { kind: "resolve", resolution };
  } else {
    return { ok: false, reason: "invalid_envelope" };
  }
  const operationBoundary = operation.kind === "place"
    ? operation.hold.boundary
    : operation.resolution.boundary;
  const operationHoldId = operation.kind === "place"
    ? operation.hold.hold_id
    : operation.resolution.hold_id;
  if (value.message_id !== operationHoldId) {
    return { ok: false, reason: "invalid_envelope" };
  }
  if (!samePlayerLocalBoundary(expectedBoundary, operationBoundary)) {
    return { ok: false, reason: "boundary_mismatch" };
  }
  return {
    ok: true,
    envelope: {
      version: 1,
      source_id: value.source_id,
      message_id: value.message_id,
      sequence: value.sequence,
      previous_message_digest: value.previous_message_digest,
      operation,
      message_digest: value.message_digest,
      authentication: value.authentication,
    },
  };
}

function boundaryTuple(boundary: AuditBoundary): readonly unknown[] {
  return [
    boundary.protocol_version,
    boundary.purpose,
    boundary.manifest_digest,
    boundary.scope_id,
    boundary.unit_id,
  ];
}

/** Canonical bytes signed by the configured external evidence source. */
export function playerLocalEvidenceHoldEnvelopeStatement(
  envelope: PlayerLocalEvidenceHoldUnsignedEnvelope,
): string {
  const prefix = [
    "converge-player-local-evidence-hold-envelope-v1",
    envelope.version,
    envelope.source_id,
    envelope.message_id,
    envelope.sequence,
    envelope.previous_message_digest,
    envelope.operation.kind,
  ];
  if (envelope.operation.kind === "place") {
    const hold = envelope.operation.hold;
    return JSON.stringify([
      ...prefix,
      ...boundaryTuple(hold.boundary),
      hold.hold_id,
      hold.epoch,
      hold.checkpoint_digest,
      hold.kind,
      hold.reference_digest,
      "active",
    ]);
  }
  const resolution = envelope.operation.resolution;
  return JSON.stringify([
    ...prefix,
    ...boundaryTuple(resolution.boundary),
    resolution.hold_id,
    resolution.epoch,
    resolution.checkpoint_digest,
    resolution.reference_digest,
    resolution.decision,
    resolution.resolution_digest,
  ]);
}
