import type {
  LineageDecisionArbiterRoster,
  LineageDecisionDigestAdapter,
  LineageDecisionScope,
  LineageDecisionVerifierRegistry,
} from "./lineage-decision-certificate";

export interface EvidenceCaseDismissalStatement {
  version: 1;
  scope: LineageDecisionScope;
  unit: string;
  evidenceCaseId: string;
  reasonCode: string;
  issuedAtMs: number;
  expiresAtMs: number;
}

export interface EvidenceCaseDismissalAuthentication {
  scheme: string;
  arbiterId: string;
  signature: string;
}

export interface EvidenceCaseDismissalCertificate {
  statement: EvidenceCaseDismissalStatement;
  authentication: EvidenceCaseDismissalAuthentication;
}

export type EvidenceCaseDismissalCertificateRejection =
  | "invalid_certificate"
  | "wrong_scope"
  | "wrong_unit"
  | "unknown_arbiter"
  | "arbiter_scheme_mismatch"
  | "unsupported_authentication_scheme"
  | "invalid_signature"
  | "certificate_from_future"
  | "certificate_expired";

export interface VerifyEvidenceCaseDismissalCertificateOptions {
  expectedScope: LineageDecisionScope;
  expectedUnit: string;
  nowMs: number;
  maxClockSkewMs: number;
  roster: LineageDecisionArbiterRoster;
  verifiers: LineageDecisionVerifierRegistry;
  digest: LineageDecisionDigestAdapter;
}

export type VerifiedEvidenceCaseDismissalCertificate =
  | {
    ok: true;
    dismissalId: string;
    certificate: EvidenceCaseDismissalCertificate;
  }
  | { ok: false; reason: EvidenceCaseDismissalCertificateRejection };

export function decodeEvidenceCaseDismissalCertificate(
  value: unknown,
): EvidenceCaseDismissalCertificate | undefined {
  const root = recordValue(value);
  const wireStatement = recordValue(root?.statement);
  const wireAuthentication = recordValue(root?.authentication);
  if (!root || !wireStatement || !wireAuthentication) return undefined;
  const statement = {
    version: wireStatement.version,
    scope: wireStatement.scope,
    unit: wireStatement.unit,
    evidenceCaseId: wireStatement.evidence_case_id,
    reasonCode: wireStatement.reason_code,
    issuedAtMs: wireStatement.issued_at_ms,
    expiresAtMs: wireStatement.expires_at_ms,
  } as EvidenceCaseDismissalStatement;
  const authentication = {
    scheme: wireAuthentication.scheme,
    arbiterId: wireAuthentication.arbiter_id,
    signature: wireAuthentication.signature,
  } as EvidenceCaseDismissalAuthentication;
  return validStatement(statement) && validAuthentication(authentication)
    ? { statement, authentication }
    : undefined;
}

export function evidenceCaseDismissalStatementDigest(
  statement: EvidenceCaseDismissalStatement,
  digest: LineageDecisionDigestAdapter,
): string {
  return digest.hashString(JSON.stringify([
    "converge-audit-evidence-case-dismissal-statement-v1",
    statement.version,
    statement.scope,
    statement.unit,
    statement.evidenceCaseId,
    statement.reasonCode,
    statement.issuedAtMs,
    statement.expiresAtMs,
  ]));
}

export function verifyEvidenceCaseDismissalCertificate(
  certificate: EvidenceCaseDismissalCertificate,
  options: VerifyEvidenceCaseDismissalCertificateOptions,
): VerifiedEvidenceCaseDismissalCertificate {
  const statement = certificate.statement;
  const authentication = certificate.authentication;
  if (!validStatement(statement) || !validAuthentication(authentication)) {
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
  const dismissalId = evidenceCaseDismissalStatementDigest(
    statement,
    options.digest,
  );
  if (
    !/^[0-9a-f]{128}$/.test(authentication.signature) ||
    !verifier.verify(arbiter.publicKey, dismissalId, authentication.signature)
  ) return { ok: false, reason: "invalid_signature" };
  const skew = Math.max(0, options.maxClockSkewMs);
  if (statement.issuedAtMs > options.nowMs + skew) {
    return { ok: false, reason: "certificate_from_future" };
  }
  if (statement.expiresAtMs < options.nowMs - skew) {
    return { ok: false, reason: "certificate_expired" };
  }
  return { ok: true, dismissalId, certificate };
}

function validStatement(value: EvidenceCaseDismissalStatement): boolean {
  return value !== null && typeof value === "object" && value.version === 1 &&
    (value.scope === "reference-game" || value.scope === "verified-asset") &&
    nonEmptyBounded(value.unit, 256) &&
    /^[0-9a-f]{64}$/.test(value.evidenceCaseId) &&
    /^[a-z0-9][a-z0-9._:-]{0,127}$/.test(value.reasonCode) &&
    nonNegativeSafeInteger(value.issuedAtMs) &&
    nonNegativeSafeInteger(value.expiresAtMs) &&
    value.expiresAtMs >= value.issuedAtMs;
}

function validAuthentication(
  value: EvidenceCaseDismissalAuthentication,
): boolean {
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

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}
