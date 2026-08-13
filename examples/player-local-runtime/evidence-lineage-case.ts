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
import {
  verifyKeyBoundStatementAsync,
  type CompiledVerificationKeyHistory,
  type KeyBoundAuthentication,
} from "./key-lifecycle.ts";

const EVIDENCE_CASE_RESOLUTION_PURPOSE = "evidence-case-resolution";

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

export interface AsyncEvidenceLineageCaseDigestAdapter {
  hashString(value: string): Promise<string>;
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
  | "legacy_authentication_expired"
  | "verification_key_history_unavailable"
  | "invalid_key_bound_authentication"
  | "unsupported_authentication_scheme"
  | "invalid_message_digest"
  | "invalid_signature"
  | "reference_mismatch";

export interface VerifyEvidenceLineageCaseProposalOptions {
  roster: EvidenceLineageCaseSourceRoster;
  verifiers: EvidenceLineageCaseVerifierRegistry;
  digest: EvidenceLineageCaseDigestAdapter;
  keyHistory?: CompiledVerificationKeyHistory;
  keyBoundScopeId?: string;
  keyBoundUnitId?: string;
  nowMs?: number;
  maxClockSkewMs?: number;
  legacyAcceptUntilMs?: number;
}

export interface VerifyEvidenceLineageCaseProposalAsyncOptions {
  roster: EvidenceLineageCaseSourceRoster;
  verifiers: EvidenceLineageCaseVerifierRegistry;
  digest: AsyncEvidenceLineageCaseDigestAdapter;
  keyHistory?: CompiledVerificationKeyHistory;
  keyBoundScopeId?: string;
  keyBoundUnitId?: string;
  nowMs?: number;
  maxClockSkewMs?: number;
  legacyAcceptUntilMs?: number;
}

interface VerifyEvidenceLineageCaseProposalAwaitableOptions {
  roster: EvidenceLineageCaseSourceRoster;
  verifiers: EvidenceLineageCaseVerifierRegistry;
  digest: { hashString(value: string): Awaitable<string> };
  keyHistory?: CompiledVerificationKeyHistory;
  keyBoundScopeId?: string;
  keyBoundUnitId?: string;
  nowMs?: number;
  maxClockSkewMs?: number;
  legacyAcceptUntilMs?: number;
}

export type VerifiedEvidenceLineageCaseProposal =
  | {
    ok: true;
    caseId: string;
    referenceDigest: string;
    proposal: EvidenceLineageCaseProposal;
  }
  | { ok: false; reason: EvidenceLineageCaseRejection };

export type VerifiedEvidenceLineageCaseSourceEnvelope =
  | { ok: true; envelope: PlayerLocalEvidenceHoldEnvelope }
  | { ok: false; reason: EvidenceLineageCaseRejection };

export type DualVerifiedEvidenceLineageCaseProposal =
  | VerifiedEvidenceLineageCaseProposal
  | { ok: false; reason: "crypto_backend_mismatch" };

export type DualVerifiedEvidenceLineageCaseSourceEnvelope =
  | VerifiedEvidenceLineageCaseSourceEnvelope
  | { ok: false; reason: "crypto_backend_mismatch" };

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

export function canonicalEvidenceLineageCaseReference(
  reference: EvidenceLineageCaseReference,
): string {
  return JSON.stringify([
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
  ]);
}

export function evidenceLineageCaseReferenceDigest(
  reference: EvidenceLineageCaseReference,
  digest: EvidenceLineageCaseDigestAdapter,
): string {
  return digest.hashString(canonicalEvidenceLineageCaseReference(reference));
}

export function evidenceLineageCaseReferenceDigestAsync(
  reference: EvidenceLineageCaseReference,
  digest: AsyncEvidenceLineageCaseDigestAdapter,
): Promise<string> {
  return digest.hashString(canonicalEvidenceLineageCaseReference(reference));
}

export async function verifyEvidenceLineageCaseSourceEnvelope(
  value: unknown,
  expectedBoundary: AuditBoundary,
  expectedSourceId: string,
  options: VerifyEvidenceLineageCaseProposalOptions,
): Promise<VerifiedEvidenceLineageCaseSourceEnvelope> {
  return verifyEvidenceLineageCaseSourceEnvelopeWithCrypto(
    value,
    expectedBoundary,
    expectedSourceId,
    options,
  );
}

export async function verifyEvidenceLineageCaseSourceEnvelopeAsync(
  value: unknown,
  expectedBoundary: AuditBoundary,
  expectedSourceId: string,
  options: VerifyEvidenceLineageCaseProposalAsyncOptions,
): Promise<VerifiedEvidenceLineageCaseSourceEnvelope> {
  return verifyEvidenceLineageCaseSourceEnvelopeWithCrypto(
    value,
    expectedBoundary,
    expectedSourceId,
    options,
  );
}

async function verifyEvidenceLineageCaseSourceEnvelopeWithCrypto(
  value: unknown,
  expectedBoundary: AuditBoundary,
  expectedSourceId: string,
  options: VerifyEvidenceLineageCaseProposalAwaitableOptions,
): Promise<VerifiedEvidenceLineageCaseSourceEnvelope> {
  const decoded = decodePlayerLocalEvidenceHoldEnvelope(
    value,
    expectedBoundary,
    expectedSourceId,
  );
  if (!decoded.ok) return { ok: false, reason: "invalid_proposal" };
  const authentication = recordValue(decoded.envelope.authentication);
  if (!authentication) return { ok: false, reason: "invalid_proposal" };
  const canonical = playerLocalEvidenceHoldEnvelopeStatement(decoded.envelope);
  const messageDigest = await options.digest.hashString(canonical);
  if (messageDigest !== decoded.envelope.message_digest) {
    return { ok: false, reason: "invalid_message_digest" };
  }
  if (authentication.version === 1) {
    if (
      !options.keyHistory || !options.keyBoundScopeId ||
      !options.keyBoundUnitId
    ) {
      return { ok: false, reason: "verification_key_history_unavailable" };
    }
    const verified = await verifyKeyBoundStatementAsync(
      authentication as unknown as KeyBoundAuthentication,
      {
        purpose: EVIDENCE_CASE_RESOLUTION_PURPOSE,
        scopeId: options.keyBoundScopeId,
        unitId: options.keyBoundUnitId,
        subjectId: expectedSourceId,
        statementDigest: messageDigest,
        nowMs: options.nowMs ?? Date.now(),
        maxClockSkewMs: options.maxClockSkewMs ?? 0,
        history: options.keyHistory,
        digest: {
          hashString: async (input) => await options.digest.hashString(input),
        },
        verifiers: Object.fromEntries(
          Object.entries(options.verifiers).map(([scheme, verifier]) => [
            scheme,
            {
              verify: async (
                publicKey: string,
                digest: string,
                signature: string,
              ) => await verifier.verify(publicKey, digest, signature),
            },
          ]),
        ),
      },
    );
    return verified.ok
      ? { ok: true, envelope: decoded.envelope }
      : { ok: false, reason: "invalid_key_bound_authentication" };
  }
  const nowMs = options.nowMs ?? Date.now();
  const legacyAcceptUntilMs = options.legacyAcceptUntilMs ??
    Number.MAX_SAFE_INTEGER;
  if (nowMs >= legacyAcceptUntilMs) {
    return { ok: false, reason: "legacy_authentication_expired" };
  }
  const source = options.roster[expectedSourceId];
  if (!source) return { ok: false, reason: "unknown_source" };
  if (
    !nonEmptyBounded(authentication.scheme, 128) ||
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
  if (!await verifier.verify(
    source.publicKey,
    messageDigest,
    authentication.signature,
  )) return { ok: false, reason: "invalid_signature" };
  return { ok: true, envelope: decoded.envelope };
}

export async function verifyEvidenceLineageCaseSourceEnvelopeDual(
  value: unknown,
  expectedBoundary: AuditBoundary,
  expectedSourceId: string,
  synchronous: VerifyEvidenceLineageCaseProposalOptions,
  asynchronous: VerifyEvidenceLineageCaseProposalAsyncOptions,
): Promise<DualVerifiedEvidenceLineageCaseSourceEnvelope> {
  const first = await verifyEvidenceLineageCaseSourceEnvelope(
    value,
    expectedBoundary,
    expectedSourceId,
    synchronous,
  );
  if (!first.ok) return first;
  const second = await verifyEvidenceLineageCaseSourceEnvelopeAsync(
    value,
    expectedBoundary,
    expectedSourceId,
    asynchronous,
  );
  return second.ok
    ? first
    : { ok: false, reason: "crypto_backend_mismatch" };
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
  return verifyEvidenceLineageCaseProposalWithCrypto(value, options);
}

export async function verifyEvidenceLineageCaseProposalAsync(
  value: unknown,
  options: VerifyEvidenceLineageCaseProposalAsyncOptions,
): Promise<VerifiedEvidenceLineageCaseProposal> {
  return verifyEvidenceLineageCaseProposalWithCrypto(value, options);
}

async function verifyEvidenceLineageCaseProposalWithCrypto(
  value: unknown,
  options: VerifyEvidenceLineageCaseProposalAwaitableOptions,
): Promise<VerifiedEvidenceLineageCaseProposal> {
  const decoded = decodeProposal(value);
  if (!decoded) return { ok: false, reason: "invalid_proposal" };
  const authenticated = await verifyEvidenceLineageCaseSourceEnvelopeWithCrypto(
    decoded.envelope,
    decoded.target.boundary,
    decoded.target.sourceId,
    options,
  );
  if (!authenticated.ok) return authenticated;
  const referenceDigest = await options.digest.hashString(
    canonicalEvidenceLineageCaseReference(decoded.target),
  );
  const hold = decoded.envelope.operation.kind === "place"
    ? decoded.envelope.operation.hold
    : undefined;
  if (!hold || hold.reference_digest !== referenceDigest) {
    return { ok: false, reason: "reference_mismatch" };
  }
  const caseId = await options.digest.hashString(JSON.stringify([
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

export async function verifyEvidenceLineageCaseProposalDual(
  value: unknown,
  synchronous: VerifyEvidenceLineageCaseProposalOptions,
  asynchronous: VerifyEvidenceLineageCaseProposalAsyncOptions,
): Promise<DualVerifiedEvidenceLineageCaseProposal> {
  const first = await verifyEvidenceLineageCaseProposal(value, synchronous);
  if (!first.ok) return first;
  const second = await verifyEvidenceLineageCaseProposalAsync(
    value,
    asynchronous,
  );
  if (
    !second.ok || second.caseId !== first.caseId ||
    second.referenceDigest !== first.referenceDigest
  ) {
    return { ok: false, reason: "crypto_backend_mismatch" };
  }
  return first;
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
