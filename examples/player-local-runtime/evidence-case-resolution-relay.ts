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

export interface EvidenceCaseResolutionSourceSigner {
  scheme: string;
  sign(digest: string): Awaitable<string>;
}

export interface EvidenceCaseResolutionDigestAdapter {
  hashString(value: string): string;
}

export interface BuildEvidenceCaseResolutionEnvelopeOptions {
  cursor: PlayerLocalEvidenceInboxCursor;
  authorizationVerifier: EvidenceCaseResolutionAuthorizationVerifier;
  digest: EvidenceCaseResolutionDigestAdapter;
  signer: EvidenceCaseResolutionSourceSigner;
}

export type BuildEvidenceCaseResolutionEnvelopeResult =
  | {
    ok: true;
    envelope: PlayerLocalEvidenceHoldEnvelope & {
      authentication: { scheme: string; signature: string };
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
  let signature: string;
  try {
    messageDigest = options.digest.hashString(
      playerLocalEvidenceHoldEnvelopeStatement(unsigned),
    );
    signature = await options.signer.sign(messageDigest);
  } catch {
    return { ok: false, reason: "signing_failed" };
  }
  if (
    !boundedString(messageDigest, 4_096) ||
    messageDigest === cursor.message_digest ||
    !boundedString(options.signer.scheme, 128) ||
    !boundedString(signature, 16_384)
  ) return { ok: false, reason: "signing_failed" };
  return {
    ok: true,
    envelope: {
      ...unsigned,
      message_digest: messageDigest,
      authentication: { scheme: options.signer.scheme, signature },
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
