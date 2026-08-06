export type LineageDecisionScope = "reference-game" | "verified-asset";
export type LineageAncestorKind = "origin" | "transfer" | "current_head";
export type LineageDecisionOutcome = "eligible" | "revoked";
export type LineageDecisionLifecycle = "appeal_open" | "finalized";

export interface LineageDecisionStatement {
  version: 1;
  scope: LineageDecisionScope;
  unit: string;
  assetId: string;
  ancestorId: string;
  ancestorKind: LineageAncestorKind;
  expectedRevision: number;
  revision: number;
  outcome: LineageDecisionOutcome;
  reasonCode: string;
  issuedAtMs: number;
  expiresAtMs: number;
  appealDeadlineAtMs: number | null;
  appealOfDecisionId: string | null;
  finalizedAtMs: number | null;
}

export interface LineageDecisionAuthentication {
  scheme: string;
  arbiterId: string;
  signature: string;
}

export interface LineageDecisionCertificate {
  statement: LineageDecisionStatement;
  authentication: LineageDecisionAuthentication;
}

export interface LineageDecisionDigestAdapter {
  hashString(value: string): string;
}

export interface LineageDecisionSignatureVerifier {
  verify(publicKey: string, digest: string, signature: string): boolean;
}

export interface LineageDecisionArbiter {
  scheme: string;
  publicKey: string;
}

export type LineageDecisionArbiterRoster = Readonly<
  Record<string, LineageDecisionArbiter>
>;

export type LineageDecisionVerifierRegistry = Readonly<
  Record<string, LineageDecisionSignatureVerifier>
>;

export type LineageDecisionCertificateRejection =
  | "invalid_certificate"
  | "wrong_scope"
  | "wrong_unit"
  | "unknown_arbiter"
  | "arbiter_scheme_mismatch"
  | "unsupported_authentication_scheme"
  | "invalid_signature"
  | "invalid_revision"
  | "certificate_from_future"
  | "certificate_expired"
  | "invalid_lifecycle";

export type VerifiedLineageDecisionCertificate =
  | {
    ok: true;
    decisionId: string;
    lifecycle: LineageDecisionLifecycle;
    certificate: LineageDecisionCertificate;
  }
  | { ok: false; reason: LineageDecisionCertificateRejection };

export interface VerifyLineageDecisionCertificateOptions {
  expectedScope: LineageDecisionScope;
  expectedUnit: string;
  nowMs: number;
  maxClockSkewMs: number;
  roster: LineageDecisionArbiterRoster;
  verifiers: LineageDecisionVerifierRegistry;
  digest: LineageDecisionDigestAdapter;
}

export function decodeLineageDecisionCertificate(
  value: unknown,
): LineageDecisionCertificate | undefined {
  const root = recordValue(value);
  const wireStatement = recordValue(root?.statement);
  const wireAuthentication = recordValue(root?.authentication);
  if (!root || !wireStatement || !wireAuthentication) return undefined;
  const statement = {
    version: wireStatement.version,
    scope: wireStatement.scope,
    unit: wireStatement.unit,
    assetId: wireStatement.asset_id,
    ancestorId: wireStatement.ancestor_id,
    ancestorKind: wireStatement.ancestor_kind,
    expectedRevision: wireStatement.expected_revision,
    revision: wireStatement.revision,
    outcome: wireStatement.outcome,
    reasonCode: wireStatement.reason_code,
    issuedAtMs: wireStatement.issued_at_ms,
    expiresAtMs: wireStatement.expires_at_ms,
    appealDeadlineAtMs: wireStatement.appeal_deadline_at_ms,
    appealOfDecisionId: wireStatement.appeal_of_decision_id,
    finalizedAtMs: wireStatement.finalized_at_ms,
  } as LineageDecisionStatement;
  const authentication = {
    scheme: wireAuthentication.scheme,
    arbiterId: wireAuthentication.arbiter_id,
    signature: wireAuthentication.signature,
  } as LineageDecisionAuthentication;
  return validStatementShape(statement) && validAuthentication(authentication)
    ? { statement, authentication }
    : undefined;
}

export function parseLineageDecisionArbiterRoster(
  encoded: string | undefined,
): LineageDecisionArbiterRoster | undefined {
  if (!encoded || encoded.length > 65_536) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(encoded);
  } catch {
    return undefined;
  }
  const root = recordValue(parsed);
  if (!root) return undefined;
  const roster: Record<string, LineageDecisionArbiter> = {};
  for (const [arbiterId, rawArbiter] of Object.entries(root)) {
    const arbiter = recordValue(rawArbiter);
    if (
      !/^[A-Za-z0-9._:-]{1,256}$/.test(arbiterId) || !arbiter ||
      !nonEmptyBounded(arbiter.scheme, 128) ||
      !nonEmptyBounded(arbiter.public_key, 16_384)
    ) return undefined;
    roster[arbiterId] = {
      scheme: arbiter.scheme,
      publicKey: arbiter.public_key,
    };
  }
  return Object.keys(roster).length > 0 ? roster : undefined;
}

export function lineageDecisionStatementDigest(
  statement: LineageDecisionStatement,
  digest: LineageDecisionDigestAdapter,
): string {
  return digest.hashString(JSON.stringify([
    "converge-audit-lineage-decision-statement-v1",
    statement.version,
    statement.scope,
    statement.unit,
    statement.assetId,
    statement.ancestorId,
    statement.ancestorKind,
    statement.expectedRevision,
    statement.revision,
    statement.outcome,
    statement.reasonCode,
    statement.issuedAtMs,
    statement.expiresAtMs,
    statement.appealDeadlineAtMs,
    statement.appealOfDecisionId,
    statement.finalizedAtMs,
  ]));
}

export function verifyLineageDecisionCertificate(
  certificate: LineageDecisionCertificate,
  options: VerifyLineageDecisionCertificateOptions,
): VerifiedLineageDecisionCertificate {
  const statement = certificate.statement;
  const authentication = certificate.authentication;
  if (!validStatementShape(statement) || !validAuthentication(authentication)) {
    return { ok: false, reason: "invalid_certificate" };
  }
  if (statement.scope !== options.expectedScope) {
    return { ok: false, reason: "wrong_scope" };
  }
  if (statement.unit !== options.expectedUnit) {
    return { ok: false, reason: "wrong_unit" };
  }
  const arbiter = options.roster[authentication.arbiterId];
  if (!arbiter) return { ok: false, reason: "unknown_arbiter" };
  if (arbiter.scheme !== authentication.scheme) {
    return { ok: false, reason: "arbiter_scheme_mismatch" };
  }
  const verifier = options.verifiers[authentication.scheme];
  if (!verifier) {
    return { ok: false, reason: "unsupported_authentication_scheme" };
  }
  const decisionId = lineageDecisionStatementDigest(statement, options.digest);
  if (
    !/^[0-9a-f]{128}$/.test(authentication.signature) ||
    !verifier.verify(arbiter.publicKey, decisionId, authentication.signature)
  ) {
    return { ok: false, reason: "invalid_signature" };
  }
  if (statement.revision !== statement.expectedRevision + 1) {
    return { ok: false, reason: "invalid_revision" };
  }
  const skew = Math.max(0, options.maxClockSkewMs);
  if (statement.issuedAtMs > options.nowMs + skew) {
    return { ok: false, reason: "certificate_from_future" };
  }
  if (statement.expiresAtMs < options.nowMs - skew) {
    return { ok: false, reason: "certificate_expired" };
  }
  const lifecycle = certificateLifecycle(statement);
  if (!lifecycle) return { ok: false, reason: "invalid_lifecycle" };
  return { ok: true, decisionId, lifecycle, certificate };
}

function certificateLifecycle(
  statement: LineageDecisionStatement,
): LineageDecisionLifecycle | undefined {
  if (statement.expiresAtMs < statement.issuedAtMs) return undefined;
  if (statement.outcome === "revoked") {
    return statement.appealDeadlineAtMs !== null &&
        statement.appealDeadlineAtMs > statement.issuedAtMs &&
        statement.appealOfDecisionId === null &&
        statement.finalizedAtMs === null
      ? "appeal_open"
      : undefined;
  }
  return statement.appealDeadlineAtMs === null &&
      statement.appealOfDecisionId !== null &&
      /^[0-9a-f]{64}$/.test(statement.appealOfDecisionId) &&
      statement.finalizedAtMs !== null &&
      statement.finalizedAtMs <= statement.issuedAtMs
    ? "finalized"
    : undefined;
}

function validStatementShape(value: LineageDecisionStatement): boolean {
  return value !== null && typeof value === "object" &&
    value.version === 1 &&
    (value.scope === "reference-game" || value.scope === "verified-asset") &&
    nonEmptyBounded(value.unit, 256) &&
    nonEmptyBounded(value.assetId, 4_096) &&
    nonEmptyBounded(value.ancestorId, 4_096) &&
    (value.ancestorKind === "origin" || value.ancestorKind === "transfer" ||
      value.ancestorKind === "current_head") &&
    nonNegativeSafeInteger(value.expectedRevision) &&
    value.expectedRevision <= 2_147_483_646 &&
    nonNegativeSafeInteger(value.revision) && value.revision <= 2_147_483_647 &&
    (value.outcome === "eligible" || value.outcome === "revoked") &&
    typeof value.reasonCode === "string" &&
    /^[a-z0-9][a-z0-9._:-]{0,127}$/.test(value.reasonCode) &&
    nonNegativeSafeInteger(value.issuedAtMs) &&
    nonNegativeSafeInteger(value.expiresAtMs) &&
    nullableNonNegativeSafeInteger(value.appealDeadlineAtMs) &&
    (value.appealOfDecisionId === null ||
      (typeof value.appealOfDecisionId === "string" &&
        /^[0-9a-f]{64}$/.test(value.appealOfDecisionId))) &&
    nullableNonNegativeSafeInteger(value.finalizedAtMs);
}

function validAuthentication(value: LineageDecisionAuthentication): boolean {
  return value !== null && typeof value === "object" &&
    nonEmptyBounded(value.scheme, 128) &&
    nonEmptyBounded(value.arbiterId, 256) &&
    typeof value.signature === "string" && value.signature.length <= 16_384;
}

function nonEmptyBounded(value: unknown, max: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= max;
}

function nonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function nullableNonNegativeSafeInteger(value: unknown): boolean {
  return value === null || nonNegativeSafeInteger(value);
}

function recordValue(
  value: unknown,
): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}
