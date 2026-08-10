import {
  decodePlayerLocalEvidenceHoldEnvelope,
  playerLocalEvidenceHoldEnvelopeStatement,
  type PlayerLocalEvidenceHoldEnvelope,
} from "./evidence-hold-wire.ts";
import type {
  AuditBoundary,
  Awaitable,
  PlayerLocalEvidenceHoldKind,
  PlayerLocalEvidenceHoldResolution,
} from "./contracts.ts";

export type EvidenceLineageCaseScope = "reference-game" | "verified-asset";
export type EvidenceLineageAncestorKind =
  | "origin"
  | "transfer"
  | "current_head";

export interface EvidenceLineageCaseReference {
  version: 1;
  scope: EvidenceLineageCaseScope;
  unit: string;
  assetId: string;
  ancestorId: string;
  ancestorKind: EvidenceLineageAncestorKind;
  boundary: AuditBoundary;
  sourceId: string;
  holdId: string;
  epoch: number;
  checkpointDigest: string;
  holdKind: PlayerLocalEvidenceHoldKind;
}

export interface EvidenceLineageCaseProposal {
  target: EvidenceLineageCaseReference;
  envelope: PlayerLocalEvidenceHoldEnvelope;
}

export interface EvidenceLineageCaseDigestAdapter {
  hashString(value: string): string;
}

export interface EvidenceLineageCaseSignatureVerifier {
  verify(
    publicKey: string,
    digest: string,
    signature: string,
  ): Awaitable<boolean>;
}

export interface EvidenceLineageCaseSource {
  scheme: string;
  publicKey: string;
}

export type EvidenceLineageCaseSourceRoster = Readonly<
  Record<string, EvidenceLineageCaseSource>
>;

export type EvidenceLineageCaseVerifierRegistry = Readonly<
  Record<string, EvidenceLineageCaseSignatureVerifier>
>;

export type EvidenceLineageCaseRejection =
  | "invalid_proposal"
  | "unknown_source"
  | "source_scheme_mismatch"
  | "unsupported_authentication_scheme"
  | "invalid_message_digest"
  | "invalid_signature"
  | "reference_mismatch";

export interface VerifyEvidenceLineageCaseProposalOptions {
  roster: EvidenceLineageCaseSourceRoster;
  verifiers: EvidenceLineageCaseVerifierRegistry;
  digest: EvidenceLineageCaseDigestAdapter;
}

export type VerifiedEvidenceLineageCaseProposal =
  | {
    ok: true;
    caseId: string;
    referenceDigest: string;
    proposal: EvidenceLineageCaseProposal;
  }
  | { ok: false; reason: EvidenceLineageCaseRejection };

export function parseEvidenceLineageCaseSourceRoster(
  encoded: string | undefined,
): EvidenceLineageCaseSourceRoster | undefined {
  if (!encoded || encoded.length > 65_536) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(encoded);
  } catch {
    return undefined;
  }
  const root = recordValue(parsed);
  if (!root) return undefined;
  const roster: Record<string, EvidenceLineageCaseSource> = {};
  for (const [sourceId, rawSource] of Object.entries(root)) {
    const source = recordValue(rawSource);
    if (
      !identity(sourceId) || !source ||
      !nonEmptyBounded(source.scheme, 128) ||
      !nonEmptyBounded(source.public_key, 16_384)
    ) return undefined;
    roster[sourceId] = {
      scheme: source.scheme,
      publicKey: source.public_key,
    };
  }
  return Object.keys(roster).length > 0 ? roster : undefined;
}

export function evidenceLineageCaseReferenceDigest(
  reference: EvidenceLineageCaseReference,
  digest: EvidenceLineageCaseDigestAdapter,
): string {
  return digest.hashString(JSON.stringify([
    "converge-audit-evidence-lineage-case-reference-v1",
    reference.version,
    reference.scope,
    reference.unit,
    reference.assetId,
    reference.ancestorId,
    reference.ancestorKind,
    reference.boundary.protocol_version,
    reference.boundary.purpose,
    reference.boundary.manifest_digest,
    reference.boundary.scope_id,
    reference.boundary.unit_id,
    reference.sourceId,
    reference.holdId,
    reference.epoch,
    reference.checkpointDigest,
    reference.holdKind,
  ]));
}

/**
 * Build the resolution payload an evidence source may authenticate in its next
 * hash-chain envelope. This draft is not authenticated and must never mutate a
 * player-local hold by itself.
 */
export function evidenceLineageCaseHoldResolutionDraft(
  reference: EvidenceLineageCaseReference,
  referenceDigest: string,
  decision: PlayerLocalEvidenceHoldResolution["decision"],
  resolutionDigest: string,
): PlayerLocalEvidenceHoldResolution {
  return {
    boundary: reference.boundary,
    hold_id: reference.holdId,
    epoch: reference.epoch,
    checkpoint_digest: reference.checkpointDigest,
    reference_digest: referenceDigest,
    decision,
    resolution_digest: resolutionDigest,
  };
}

export async function verifyEvidenceLineageCaseProposal(
  value: unknown,
  options: VerifyEvidenceLineageCaseProposalOptions,
): Promise<VerifiedEvidenceLineageCaseProposal> {
  const decoded = decodeProposal(value);
  if (!decoded) return { ok: false, reason: "invalid_proposal" };
  const source = options.roster[decoded.target.sourceId];
  if (!source) return { ok: false, reason: "unknown_source" };
  const authentication = recordValue(decoded.envelope.authentication);
  if (
    !authentication || !nonEmptyBounded(authentication.scheme, 128) ||
    typeof authentication.signature !== "string" ||
    authentication.signature.length > 16_384
  ) return { ok: false, reason: "invalid_proposal" };
  if (source.scheme !== authentication.scheme) {
    return { ok: false, reason: "source_scheme_mismatch" };
  }
  const verifier = options.verifiers[authentication.scheme];
  if (!verifier) {
    return { ok: false, reason: "unsupported_authentication_scheme" };
  }
  const canonical = playerLocalEvidenceHoldEnvelopeStatement(decoded.envelope);
  const messageDigest = options.digest.hashString(canonical);
  if (messageDigest !== decoded.envelope.message_digest) {
    return { ok: false, reason: "invalid_message_digest" };
  }
  if (!await verifier.verify(
    source.publicKey,
    messageDigest,
    authentication.signature,
  )) return { ok: false, reason: "invalid_signature" };
  const referenceDigest = evidenceLineageCaseReferenceDigest(
    decoded.target,
    options.digest,
  );
  const hold = decoded.envelope.operation.kind === "place"
    ? decoded.envelope.operation.hold
    : undefined;
  if (!hold || hold.reference_digest !== referenceDigest) {
    return { ok: false, reason: "reference_mismatch" };
  }
  const caseId = options.digest.hashString(JSON.stringify([
    "converge-audit-evidence-lineage-case-v1",
    referenceDigest,
    decoded.envelope.message_digest,
  ]));
  return {
    ok: true,
    caseId,
    referenceDigest,
    proposal: decoded,
  };
}

function decodeProposal(value: unknown): EvidenceLineageCaseProposal | undefined {
  const root = recordValue(value);
  const boundary = auditBoundary(root?.boundary);
  if (
    !root || root.version !== 1 ||
    (root.scope !== "reference-game" && root.scope !== "verified-asset") ||
    !nonEmptyBounded(root.unit, 256) ||
    !nonEmptyBounded(root.asset_id, 4_096) ||
    !nonEmptyBounded(root.ancestor_id, 4_096) ||
    (root.ancestor_kind !== "origin" && root.ancestor_kind !== "transfer" &&
      root.ancestor_kind !== "current_head") ||
    !boundary || !identity(root.source_id)
  ) return undefined;
  const envelope = decodePlayerLocalEvidenceHoldEnvelope(
    root.hold_envelope,
    boundary,
    root.source_id,
  );
  if (!envelope.ok || envelope.envelope.operation.kind !== "place") {
    return undefined;
  }
  const hold = envelope.envelope.operation.hold;
  return {
    target: {
      version: 1,
      scope: root.scope,
      unit: root.unit,
      assetId: root.asset_id,
      ancestorId: root.ancestor_id,
      ancestorKind: root.ancestor_kind,
      boundary,
      sourceId: root.source_id,
      holdId: hold.hold_id,
      epoch: hold.epoch,
      checkpointDigest: hold.checkpoint_digest,
      holdKind: hold.kind,
    },
    envelope: envelope.envelope,
  };
}

function auditBoundary(value: unknown): AuditBoundary | undefined {
  const root = recordValue(value);
  if (
    !root || !positiveSafeInteger(root.protocol_version) ||
    !nonEmptyBounded(root.purpose, 256) ||
    !nonEmptyBounded(root.manifest_digest, 4_096) ||
    !nonEmptyBounded(root.scope_id, 4_096) ||
    !nonEmptyBounded(root.unit_id, 256)
  ) return undefined;
  return {
    protocol_version: root.protocol_version,
    purpose: root.purpose,
    manifest_digest: root.manifest_digest,
    scope_id: root.scope_id,
    unit_id: root.unit_id,
  };
}

function identity(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9._:-]{1,256}$/.test(value);
}

function positiveSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function nonEmptyBounded(value: unknown, max: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= max;
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}
