import {
  isNonNegativeInteger,
  samePlayerLocalBoundary,
  type Awaitable,
  type PlayerLocalEvidenceHoldResolution,
  type PlayerLocalEvidenceInboxCursor,
} from "./contracts.ts";
import {
  playerLocalEvidenceHoldEnvelopeStatement,
  type PlayerLocalEvidenceHoldEnvelope,
  type PlayerLocalEvidenceHoldUnsignedEnvelope,
} from "./evidence-hold-wire.ts";
import {
  verifyKeyBoundStatementAsync,
  type CompiledVerificationKeyHistory,
  type KeyBoundAuthentication,
} from "./key-lifecycle.ts";

const EVIDENCE_CASE_RESOLUTION_PURPOSE = "evidence-case-resolution";

export interface EvidenceCaseResolutionNotice {
  version: 1;
  noticeSequence: number;
  scope: "reference-game" | "verified-asset";
  unit: string;
  caseId: string;
  sourceId: string;
  acceptedAtMs: number;
  resolution: PlayerLocalEvidenceHoldResolution;
  authorization: unknown;
}

export interface EvidenceCaseResolutionPollCursor {
  sourceId: string;
  sequence: number;
  resolutionId: string;
}

export interface EvidenceCaseResolutionPollRequest {
  version: 1 | 2;
  audience: string;
  unit: string;
  source_id: string;
  after_sequence: number;
  after_resolution_id: string;
  limit: number;
  authentication: EvidenceCaseResolutionAuthentication;
}

export type EvidenceCaseResolutionLegacyAuthentication = {
  scheme: string;
  signature: string;
};

export type EvidenceCaseResolutionAuthentication =
  | EvidenceCaseResolutionLegacyAuthentication
  | KeyBoundAuthentication;

export interface BuildEvidenceCaseResolutionPollRequestOptions {
  audience: string;
  unit: string;
  cursor: EvidenceCaseResolutionPollCursor;
  limit: number;
  digest: EvidenceCaseResolutionDigestAdapter;
  signer: EvidenceCaseResolutionSourceSigner;
  keyBoundScopeId?: string;
}

export interface EvidenceCaseResolutionPollSource {
  scheme: string;
  publicKey: string;
}

export interface EvidenceCaseResolutionPollVerifier {
  verify(
    publicKey: string,
    digest: string,
    signature: string,
  ): Awaitable<boolean>;
}

export interface VerifyEvidenceCaseResolutionPollRequestOptions {
  expectedAudience: string;
  expectedUnit: string;
  expectedKeyScopeId?: string;
  roster: Readonly<Record<string, EvidenceCaseResolutionPollSource>>;
  digest: EvidenceCaseResolutionDigestAdapter;
  verifiers: Readonly<Record<string, EvidenceCaseResolutionPollVerifier>>;
  keyHistory?: CompiledVerificationKeyHistory;
  nowMs?: number;
  maxClockSkewMs?: number;
  /** Exclusive cutoff for accepting protocol-v1 authentication. */
  legacyAcceptUntilMs?: number;
}

export type VerifyEvidenceCaseResolutionPollRequestResult =
  | {
    ok: true;
    cursor: EvidenceCaseResolutionPollCursor;
    limit: number;
    authenticationVersion?: 2;
  }
  | {
    ok: false;
    reason:
      | "invalid_request"
      | "expected_binding_mismatch"
      | "unknown_source"
      | "source_scheme_mismatch"
      | "legacy_authentication_expired"
      | "verification_key_history_unavailable"
      | "invalid_key_bound_authentication"
      | "unsupported_authentication_scheme"
      | "invalid_signature";
  };

export interface EvidenceCaseResolutionPollPage {
  sourceId: string;
  afterSequence: number;
  afterResolutionId: string;
  sourceCursor: PlayerLocalEvidenceInboxCursor;
  notices: EvidenceCaseResolutionNotice[];
}

export type DecodeEvidenceCaseResolutionPollPageResult =
  | { ok: true; page: EvidenceCaseResolutionPollPage }
  | { ok: false; reason: "invalid_page" | "page_limit_exceeded" };

export interface EvidenceCaseResolutionAuthorizationVerifier {
  verify(notice: EvidenceCaseResolutionNotice): Awaitable<boolean>;
}

export interface EvidenceCaseResolutionLegacySourceSigner {
  version?: 1;
  scheme: string;
  sign(digest: string): Awaitable<string>;
}

export interface EvidenceCaseResolutionKeyBoundSourceSigner {
  version: 2;
  authenticate(input: {
    purpose: typeof EVIDENCE_CASE_RESOLUTION_PURPOSE;
    scopeId: string;
    unitId: string;
    statementDigest: string;
  }): Awaitable<KeyBoundAuthentication>;
}

export type EvidenceCaseResolutionSourceSigner =
  | EvidenceCaseResolutionLegacySourceSigner
  | EvidenceCaseResolutionKeyBoundSourceSigner;

export interface EvidenceCaseResolutionDigestAdapter {
  hashString(value: string): Awaitable<string>;
}

export interface BuildEvidenceCaseResolutionEnvelopeOptions {
  cursor: PlayerLocalEvidenceInboxCursor;
  authorizationVerifier: EvidenceCaseResolutionAuthorizationVerifier;
  digest: EvidenceCaseResolutionDigestAdapter;
  signer: EvidenceCaseResolutionSourceSigner;
  keyBoundScopeId?: string;
}

export async function buildEvidenceCaseResolutionPollRequest(
  options: BuildEvidenceCaseResolutionPollRequestOptions,
): Promise<EvidenceCaseResolutionPollRequest> {
  const signer = options.signer;
  const unsigned = {
    version: signer.version === 2 ? 2 as const : 1 as const,
    audience: options.audience,
    unit: options.unit,
    source_id: options.cursor.sourceId,
    after_sequence: options.cursor.sequence,
    after_resolution_id: options.cursor.resolutionId,
    limit: options.limit,
  };
  if (!evidenceCaseResolutionPollRequestFieldsValid(unsigned)) {
    throw new Error("invalid evidence resolution poll request");
  }
  const digest = await options.digest.hashString(
    canonicalEvidenceCaseResolutionPollStatement(unsigned),
  );
  if (signer.version === 2) {
    const scopeId = options.keyBoundScopeId ?? options.unit;
    const authentication = await signer.authenticate({
      purpose: EVIDENCE_CASE_RESOLUTION_PURPOSE,
      scopeId,
      unitId: options.unit,
      statementDigest: digest,
    });
    if (!keyBoundAuthenticationMatches(authentication, {
      scopeId,
      unitId: options.unit,
      subjectId: options.cursor.sourceId,
      statementDigest: digest,
    })) throw new Error("invalid evidence resolution poll credential");
    return { ...unsigned, authentication };
  }
  const signature = await signer.sign(digest);
  if (
    !boundedString(signer.scheme, 128) ||
    !boundedString(signature, 16_384)
  ) throw new Error("invalid evidence resolution poll credential");
  return {
    ...unsigned,
    authentication: { scheme: signer.scheme, signature },
  };
}

export function canonicalEvidenceCaseResolutionPollStatement(
  request: Omit<EvidenceCaseResolutionPollRequest, "authentication"> |
    EvidenceCaseResolutionPollRequest,
): string {
  return JSON.stringify([
    request.version === 2
      ? "converge-audit-evidence-case-resolution-poll-v2"
      : "converge-audit-evidence-case-resolution-poll-v1",
    request.version,
    request.audience,
    request.unit,
    request.source_id,
    request.after_sequence,
    request.after_resolution_id,
    request.limit,
  ]);
}

export async function verifyEvidenceCaseResolutionPollRequest(
  value: unknown,
  options: VerifyEvidenceCaseResolutionPollRequestOptions,
): Promise<VerifyEvidenceCaseResolutionPollRequestResult> {
  const root = recordValue(value);
  const authentication = recordValue(root?.authentication);
  if (
    !root || !evidenceCaseResolutionPollRequestFieldsValid(root) ||
    !authentication
  ) return { ok: false, reason: "invalid_request" };
  if (
    root.audience !== options.expectedAudience ||
    root.unit !== options.expectedUnit
  ) return { ok: false, reason: "expected_binding_mismatch" };
  let accepted = false;
  const statementDigest = await options.digest.hashString(
    canonicalEvidenceCaseResolutionPollStatement(root as unknown as
      EvidenceCaseResolutionPollRequest),
  );
  if (root.version === 2) {
    if (!options.keyHistory) {
      return { ok: false, reason: "verification_key_history_unavailable" };
    }
    const verification = await verifyKeyBoundStatementAsync(
      authentication as unknown as KeyBoundAuthentication,
      {
        purpose: EVIDENCE_CASE_RESOLUTION_PURPOSE,
        scopeId: options.expectedKeyScopeId ?? options.expectedUnit,
        unitId: options.expectedUnit,
        subjectId: root.source_id as string,
        statementDigest,
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
    if (!verification.ok) {
      return { ok: false, reason: "invalid_key_bound_authentication" };
    }
    return {
      ok: true,
      cursor: {
        sourceId: root.source_id as string,
        sequence: root.after_sequence as number,
        resolutionId: root.after_resolution_id as string,
      },
      limit: root.limit as number,
      authenticationVersion: 2,
    };
  }
  const nowMs = options.nowMs ?? Date.now();
  const legacyAcceptUntilMs = options.legacyAcceptUntilMs ??
    Number.MAX_SAFE_INTEGER;
  if (nowMs >= legacyAcceptUntilMs) {
    return { ok: false, reason: "legacy_authentication_expired" };
  }
  if (
    !boundedString(authentication.scheme, 128) ||
    !boundedString(authentication.signature, 16_384)
  ) return { ok: false, reason: "invalid_request" };
  const source = options.roster[root.source_id as string];
  if (!source) return { ok: false, reason: "unknown_source" };
  if (source.scheme !== authentication.scheme) {
    return { ok: false, reason: "source_scheme_mismatch" };
  }
  const verifier = options.verifiers[authentication.scheme as string];
  if (!verifier) {
    return { ok: false, reason: "unsupported_authentication_scheme" };
  }
  try {
    accepted = await verifier.verify(
      source.publicKey,
      statementDigest,
      authentication.signature as string,
    );
  } catch {
    accepted = false;
  }
  if (!accepted) return { ok: false, reason: "invalid_signature" };
  return {
    ok: true,
    cursor: {
      sourceId: root.source_id as string,
      sequence: root.after_sequence as number,
      resolutionId: root.after_resolution_id as string,
    },
    limit: root.limit as number,
  };
}

export type BuildEvidenceCaseResolutionEnvelopeResult =
  | {
    ok: true;
    envelope: PlayerLocalEvidenceHoldEnvelope & {
      authentication: EvidenceCaseResolutionAuthentication;
    };
  }
  | {
    ok: false;
    reason:
      | "invalid_notice"
      | "cursor_mismatch"
      | "authorization_rejected"
      | "signing_failed";
  };

export function decodeEvidenceCaseResolutionPollPage(
  value: unknown,
  expectedCursor: EvidenceCaseResolutionPollCursor,
  maxNotices: number,
): DecodeEvidenceCaseResolutionPollPageResult {
  const root = recordValue(value);
  const rawSourceCursor = recordValue(root?.source_cursor);
  if (
    !root || root.version !== 1 ||
    !identity(root.source_id) ||
    !Number.isSafeInteger(root.after_sequence) ||
    (root.after_sequence as number) < -1 ||
    !boundedString(root.after_resolution_id, 4_096) ||
    !rawSourceCursor || !Array.isArray(root.notices) ||
    !Number.isSafeInteger(maxNotices) || maxNotices < 1 || maxNotices > 128
  ) return { ok: false, reason: "invalid_page" };
  if (root.notices.length > maxNotices) {
    return { ok: false, reason: "page_limit_exceeded" };
  }
  if (
    root.source_id !== expectedCursor.sourceId ||
    root.after_sequence !== expectedCursor.sequence ||
    root.after_resolution_id !== expectedCursor.resolutionId
  ) return { ok: false, reason: "invalid_page" };
  const sourceBoundary = boundaryValue(rawSourceCursor.boundary);
  if (
    !sourceBoundary || rawSourceCursor.source_id !== root.source_id ||
    !Number.isSafeInteger(rawSourceCursor.sequence) ||
    (rawSourceCursor.sequence as number) < -1 ||
    !boundedString(rawSourceCursor.message_digest, 4_096)
  ) return { ok: false, reason: "invalid_page" };
  const notices: EvidenceCaseResolutionNotice[] = [];
  for (const [offset, rawNotice] of root.notices.entries()) {
    const noticeRoot = recordValue(rawNotice);
    const resolutionRoot = recordValue(noticeRoot?.resolution);
    const resolutionBoundary = boundaryValue(resolutionRoot?.boundary);
    if (!noticeRoot || !resolutionRoot || !resolutionBoundary) {
      return { ok: false, reason: "invalid_page" };
    }
    const notice: EvidenceCaseResolutionNotice = {
      version: noticeRoot.version as 1,
      noticeSequence: noticeRoot.notice_sequence as number,
      scope: noticeRoot.scope as EvidenceCaseResolutionNotice["scope"],
      unit: noticeRoot.unit as string,
      caseId: noticeRoot.case_id as string,
      sourceId: noticeRoot.source_id as string,
      acceptedAtMs: noticeRoot.accepted_at_ms as number,
      resolution: {
        boundary: resolutionBoundary,
        hold_id: resolutionRoot.hold_id as string,
        epoch: resolutionRoot.epoch as number,
        checkpoint_digest: resolutionRoot.checkpoint_digest as string,
        reference_digest: resolutionRoot.reference_digest as string,
        decision: resolutionRoot.decision as
          PlayerLocalEvidenceHoldResolution["decision"],
        resolution_digest: resolutionRoot.resolution_digest as string,
      },
      authorization: noticeRoot.authorization,
    };
    if (
      !evidenceCaseResolutionNoticeValid(notice) ||
      notice.sourceId !== root.source_id ||
      notice.noticeSequence !== expectedCursor.sequence + offset + 1 ||
      !samePlayerLocalBoundary(sourceBoundary, notice.resolution.boundary)
    ) return { ok: false, reason: "invalid_page" };
    notices.push(notice);
  }
  return {
    ok: true,
    page: {
      sourceId: root.source_id,
      afterSequence: root.after_sequence as number,
      afterResolutionId: root.after_resolution_id,
      sourceCursor: {
        boundary: sourceBoundary,
        source_id: rawSourceCursor.source_id as string,
        sequence: rawSourceCursor.sequence as number,
        message_digest: rawSourceCursor.message_digest as string,
      },
      notices,
    },
  };
}

export async function buildEvidenceCaseResolutionEnvelope(
  notice: EvidenceCaseResolutionNotice,
  options: BuildEvidenceCaseResolutionEnvelopeOptions,
): Promise<BuildEvidenceCaseResolutionEnvelopeResult> {
  if (!evidenceCaseResolutionNoticeValid(notice)) {
    return { ok: false, reason: "invalid_notice" };
  }
  const cursor = options.cursor;
  if (
    cursor.source_id !== notice.sourceId ||
    !samePlayerLocalBoundary(cursor.boundary, notice.resolution.boundary) ||
    !Number.isSafeInteger(cursor.sequence) || cursor.sequence < -1 ||
    cursor.sequence >= Number.MAX_SAFE_INTEGER ||
    !boundedString(cursor.message_digest, 4_096)
  ) return { ok: false, reason: "cursor_mismatch" };
  let authorized = false;
  try {
    authorized = await options.authorizationVerifier.verify(notice);
  } catch {
    authorized = false;
  }
  if (!authorized) return { ok: false, reason: "authorization_rejected" };
  const unsigned: PlayerLocalEvidenceHoldUnsignedEnvelope = {
    version: 1,
    source_id: notice.sourceId,
    message_id: notice.resolution.hold_id,
    sequence: cursor.sequence + 1,
    previous_message_digest: cursor.message_digest,
    operation: { kind: "resolve", resolution: notice.resolution },
  };
  let messageDigest: string;
  let authentication: EvidenceCaseResolutionAuthentication;
  try {
    messageDigest = await options.digest.hashString(
      playerLocalEvidenceHoldEnvelopeStatement(unsigned),
    );
    if (options.signer.version === 2) {
      const scopeId = options.keyBoundScopeId ?? notice.unit;
      authentication = await options.signer.authenticate({
        purpose: EVIDENCE_CASE_RESOLUTION_PURPOSE,
        scopeId,
        unitId: notice.resolution.boundary.unit_id,
        statementDigest: messageDigest,
      });
    } else {
      authentication = {
        scheme: options.signer.scheme,
        signature: await options.signer.sign(messageDigest),
      };
    }
  } catch {
    return { ok: false, reason: "signing_failed" };
  }
  if (
    !boundedString(messageDigest, 4_096) ||
    messageDigest === cursor.message_digest ||
    (options.signer.version === 2
      ? !keyBoundAuthenticationMatches(
        authentication as KeyBoundAuthentication,
        {
        scopeId: options.keyBoundScopeId ?? notice.unit,
        unitId: notice.resolution.boundary.unit_id,
        subjectId: notice.sourceId,
        statementDigest: messageDigest,
        },
      )
      : !legacyAuthenticationValid(authentication!))
  ) return { ok: false, reason: "signing_failed" };
  return {
    ok: true,
    envelope: {
      ...unsigned,
      message_digest: messageDigest,
      authentication,
    },
  };
}

function evidenceCaseResolutionNoticeValid(
  notice: EvidenceCaseResolutionNotice,
): boolean {
  const resolution = notice.resolution;
  return notice !== null && typeof notice === "object" &&
    notice.version === 1 &&
    isNonNegativeInteger(notice.noticeSequence) &&
    (notice.scope === "reference-game" || notice.scope === "verified-asset") &&
    boundedString(notice.unit, 256) &&
    /^[0-9a-f]{64}$/.test(notice.caseId) &&
    identity(notice.sourceId) &&
    isNonNegativeInteger(notice.acceptedAtMs) &&
    resolution !== null && typeof resolution === "object" &&
    boundedString(resolution.hold_id, 256) &&
    isNonNegativeInteger(resolution.epoch) &&
    boundedString(resolution.checkpoint_digest, 4_096) &&
    boundedString(resolution.reference_digest, 4_096) &&
    (resolution.decision === "upheld" ||
      resolution.decision === "dismissed") &&
    boundedString(resolution.resolution_digest, 4_096) &&
    resolution.boundary.protocol_version > 0 &&
    Number.isSafeInteger(resolution.boundary.protocol_version) &&
    boundedString(resolution.boundary.purpose, 256) &&
    boundedString(resolution.boundary.manifest_digest, 4_096) &&
    boundedString(resolution.boundary.scope_id, 4_096) &&
    boundedString(resolution.boundary.unit_id, 256) &&
    notice.authorization !== undefined;
}

function identity(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9._:-]{1,256}$/.test(value);
}

function evidenceCaseResolutionPollRequestFieldsValid(
  value: Record<string, unknown>,
): boolean {
  if (
    (value.version !== 1 && value.version !== 2) ||
    !authorityAudience(value.audience) ||
    !boundedString(value.unit, 256) || !identity(value.source_id) ||
    !Number.isSafeInteger(value.after_sequence) ||
    (value.after_sequence as number) < -1 ||
    !boundedString(value.after_resolution_id, 4_096) || value.limit !== 1
  ) return false;
  return value.after_sequence === -1
    ? value.after_resolution_id === "resolution-genesis"
    : true;
}

function legacyAuthenticationValid(
  value: EvidenceCaseResolutionAuthentication,
): value is EvidenceCaseResolutionLegacyAuthentication {
  const authentication = recordValue(value);
  return !!authentication && boundedString(authentication.scheme, 128) &&
    boundedString(authentication.signature, 16_384);
}

function keyBoundAuthenticationMatches(
  value: KeyBoundAuthentication,
  expected: {
    scopeId: string;
    unitId: string;
    subjectId: string;
    statementDigest: string;
  },
): boolean {
  return value !== null && typeof value === "object" && value.version === 1 &&
    value.purpose === EVIDENCE_CASE_RESOLUTION_PURPOSE &&
    value.scopeId === expected.scopeId && value.unitId === expected.unitId &&
    value.subjectId === expected.subjectId &&
    value.statementDigest === expected.statementDigest &&
    boundedString(value.keyId, 256) && Number.isSafeInteger(value.keyVersion) &&
    value.keyVersion > 0 && boundedString(value.scheme, 128) &&
    boundedString(value.publicKey, 16_384) &&
    Number.isSafeInteger(value.issuedAtMs) && value.issuedAtMs >= 0 &&
    boundedString(value.signature, 16_384);
}

function authorityAudience(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 2_048) return false;
  try {
    const parsed = new URL(value);
    return (parsed.protocol === "https:" || parsed.protocol === "http:") &&
      parsed.origin === value;
  } catch {
    return false;
  }
}

function boundaryValue(value: unknown) {
  const root = recordValue(value);
  if (
    !root || !Number.isSafeInteger(root.protocol_version) ||
    (root.protocol_version as number) <= 0 ||
    !boundedString(root.purpose, 256) ||
    !boundedString(root.manifest_digest, 4_096) ||
    !boundedString(root.scope_id, 4_096) ||
    !boundedString(root.unit_id, 256)
  ) return undefined;
  return {
    protocol_version: root.protocol_version as number,
    purpose: root.purpose,
    manifest_digest: root.manifest_digest,
    scope_id: root.scope_id,
    unit_id: root.unit_id,
  };
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function boundedString(value: unknown, maximumLength: number): value is string {
  return typeof value === "string" && value.length > 0 &&
    value.length <= maximumLength;
}
