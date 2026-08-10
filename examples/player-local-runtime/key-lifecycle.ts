/**
 * Storage-neutral verification-key history for checkpoint and evidence
 * signatures. Private-key material is deliberately absent from every wire
 * type in this module.
 */
export interface VerificationKeyRecord {
  version: 1;
  /** Stable logical key slot across rotations. */
  keyId: string;
  /** Monotonic version within one key slot. */
  keyVersion: number;
  subjectId: string;
  purpose: string;
  scopeId: string;
  scheme: string;
  publicKey: string;
  /** Inclusive signing-time boundary. */
  validFromMs: number;
  /** Exclusive signing-time boundary. */
  validUntilMs: number;
  /** Inclusive effective invalidation boundary; null means not revoked. */
  revokedAtMs: number | null;
}

export interface VerificationKeyRecordWire {
  version: 1;
  key_id: string;
  key_version: number;
  subject_id: string;
  purpose: string;
  scope_id: string;
  scheme: string;
  public_key: string;
  valid_from_ms: number;
  valid_until_ms: number;
  revoked_at_ms: number | null;
}

export interface VerificationKeyHistoryWire {
  version: 1;
  keys: VerificationKeyRecordWire[];
}

export interface KeyBoundAuthentication {
  version: 1;
  purpose: string;
  scopeId: string;
  unitId: string;
  subjectId: string;
  keyId: string;
  keyVersion: number;
  scheme: string;
  publicKey: string;
  statementDigest: string;
  issuedAtMs: number;
  signature: string;
}

export interface KeyBoundSigner {
  readonly scheme: string;
  readonly publicKey: string;
  signDigest(digest: string): string;
}

export interface KeyLifecycleDigestAdapter {
  hashString(value: string): string;
}

export interface KeyLifecycleSignatureVerifier {
  verify(publicKey: string, digest: string, signature: string): boolean;
}

export type KeyLifecycleVerifierRegistry = Readonly<
  Record<string, KeyLifecycleSignatureVerifier>
>;

export type VerificationKeyHistoryValidation =
  | { ok: true }
  | {
    ok: false;
    reason:
      | "invalid_key_record"
      | "duplicate_key_version"
      | "key_identity_changed"
      | "non_monotonic_key_version"
      | "overlapping_key_versions";
  };

const compiledHistory = Symbol("compiled-verification-key-history");

/** Provision-time validated O(1) lookup used by the hot verification path. */
export interface CompiledVerificationKeyHistory {
  readonly records: readonly VerificationKeyRecord[];
  readonly [compiledHistory]: true;
  lookup(keyId: string, keyVersion: number): VerificationKeyRecord | undefined;
}

export type VerificationKeyHistoryCompilation =
  | { ok: true; history: CompiledVerificationKeyHistory }
  | Extract<VerificationKeyHistoryValidation, { ok: false }>;

export type KeyBoundVerification =
  | { ok: true; keyId: string; keyVersion: number }
  | {
    ok: false;
    reason:
      | "invalid_authentication"
      | "invalid_key_history"
      | "expected_binding_mismatch"
      | "unknown_key_version"
      | "key_record_binding_mismatch"
      | "statement_from_future"
      | "key_not_yet_valid_at_issuance"
      | "key_expired_at_issuance"
      | "key_revoked_at_issuance"
      | "unsupported_scheme"
      | "invalid_signature";
  };

export function canonicalKeyBoundSignatureStatement(
  authentication: Omit<KeyBoundAuthentication, "signature">,
): string {
  return JSON.stringify([
    "converge-audit-key-bound-signature-v1",
    authentication.version,
    authentication.purpose,
    authentication.scopeId,
    authentication.unitId,
    authentication.subjectId,
    authentication.keyId,
    authentication.keyVersion,
    authentication.scheme,
    authentication.publicKey,
    authentication.statementDigest,
    authentication.issuedAtMs,
  ]);
}

export function signKeyBoundStatement(input: {
  key: VerificationKeyRecord;
  unitId: string;
  statementDigest: string;
  issuedAtMs: number;
  signer: KeyBoundSigner;
  digest: KeyLifecycleDigestAdapter;
}): KeyBoundAuthentication {
  if (!validKeyRecord(input.key)) throw new Error("invalid verification key record");
  if (!boundedText(input.unitId, 256) || !boundedText(input.statementDigest, 4_096)) {
    throw new Error("invalid key-bound statement");
  }
  if (
    input.signer.scheme !== input.key.scheme ||
    input.signer.publicKey !== input.key.publicKey
  ) {
    throw new Error("signer does not match verification key record");
  }
  const timeRefusal = issuanceTimeRefusal(input.key, input.issuedAtMs);
  if (timeRefusal) throw new Error(timeRefusal);
  const unsigned: Omit<KeyBoundAuthentication, "signature"> = {
    version: 1,
    purpose: input.key.purpose,
    scopeId: input.key.scopeId,
    unitId: input.unitId,
    subjectId: input.key.subjectId,
    keyId: input.key.keyId,
    keyVersion: input.key.keyVersion,
    scheme: input.key.scheme,
    publicKey: input.key.publicKey,
    statementDigest: input.statementDigest,
    issuedAtMs: input.issuedAtMs,
  };
  const signature = input.signer.signDigest(
    input.digest.hashString(canonicalKeyBoundSignatureStatement(unsigned)),
  );
  if (!boundedText(signature, 16_384)) throw new Error("signing failed");
  return Object.freeze({ ...unsigned, signature });
}

export function verifyKeyBoundStatement(
  authentication: KeyBoundAuthentication,
  options: {
    purpose: string;
    scopeId: string;
    unitId: string;
    subjectId: string;
    statementDigest: string;
    nowMs: number;
    maxClockSkewMs: number;
    history: CompiledVerificationKeyHistory;
    digest: KeyLifecycleDigestAdapter;
    verifiers: KeyLifecycleVerifierRegistry;
  },
): KeyBoundVerification {
  if (!validAuthentication(authentication)) {
    return { ok: false, reason: "invalid_authentication" };
  }
  if (options.history?.[compiledHistory] !== true) {
    return { ok: false, reason: "invalid_key_history" };
  }
  if (
    authentication.purpose !== options.purpose ||
    authentication.scopeId !== options.scopeId ||
    authentication.unitId !== options.unitId ||
    authentication.subjectId !== options.subjectId ||
    authentication.statementDigest !== options.statementDigest
  ) {
    return { ok: false, reason: "expected_binding_mismatch" };
  }
  const key = options.history.lookup(
    authentication.keyId,
    authentication.keyVersion,
  );
  if (!key) return { ok: false, reason: "unknown_key_version" };
  if (
    key.subjectId !== authentication.subjectId ||
    key.purpose !== authentication.purpose ||
    key.scopeId !== authentication.scopeId ||
    key.scheme !== authentication.scheme ||
    key.publicKey !== authentication.publicKey
  ) {
    return { ok: false, reason: "key_record_binding_mismatch" };
  }
  const latestAcceptedIssuance = options.nowMs + options.maxClockSkewMs;
  if (
    !safeNonNegativeInteger(options.nowMs) ||
    !safeNonNegativeInteger(options.maxClockSkewMs) ||
    !safeNonNegativeInteger(latestAcceptedIssuance) ||
    authentication.issuedAtMs > latestAcceptedIssuance
  ) {
    return { ok: false, reason: "statement_from_future" };
  }
  const timeRefusal = issuanceTimeRefusal(key, authentication.issuedAtMs);
  if (timeRefusal) return { ok: false, reason: timeRefusal };
  const verifier = options.verifiers[authentication.scheme];
  if (!verifier) return { ok: false, reason: "unsupported_scheme" };
  const digest = options.digest.hashString(
    canonicalKeyBoundSignatureStatement(authentication),
  );
  if (!verifier.verify(key.publicKey, digest, authentication.signature)) {
    return { ok: false, reason: "invalid_signature" };
  }
  return {
    ok: true,
    keyId: authentication.keyId,
    keyVersion: authentication.keyVersion,
  };
}

export function validateVerificationKeyHistory(
  history: readonly VerificationKeyRecord[],
): VerificationKeyHistoryValidation {
  if (history.length === 0 || history.length > 1_024) {
    return { ok: false, reason: "invalid_key_record" };
  }
  const slots = new Map<string, VerificationKeyRecord[]>();
  const versions = new Set<string>();
  for (const key of history) {
    if (!validKeyRecord(key)) return { ok: false, reason: "invalid_key_record" };
    const versionId = `${key.keyId}\u0000${key.keyVersion}`;
    if (versions.has(versionId)) {
      return { ok: false, reason: "duplicate_key_version" };
    }
    versions.add(versionId);
    const slot = slots.get(key.keyId) ?? [];
    slot.push(key);
    slots.set(key.keyId, slot);
  }
  for (const slot of slots.values()) {
    const first = slot[0];
    if (slot.some((key) =>
      key.subjectId !== first.subjectId || key.purpose !== first.purpose ||
      key.scopeId !== first.scopeId
    )) {
      return { ok: false, reason: "key_identity_changed" };
    }
    const ordered = [...slot].sort((a, b) => a.keyVersion - b.keyVersion);
    for (let index = 1; index < ordered.length; index += 1) {
      const previous = ordered[index - 1];
      const current = ordered[index];
      if (current.keyVersion !== previous.keyVersion + 1) {
        return { ok: false, reason: "non_monotonic_key_version" };
      }
      if (previous.validUntilMs > current.validFromMs) {
        return { ok: false, reason: "overlapping_key_versions" };
      }
    }
  }
  return { ok: true };
}

export function compileVerificationKeyHistory(
  records: readonly VerificationKeyRecord[],
): VerificationKeyHistoryCompilation {
  const validation = validateVerificationKeyHistory(records);
  if (!validation.ok) return validation;
  const immutableRecords = records.map((record) => Object.freeze({ ...record }));
  const index = new Map<string, VerificationKeyRecord>();
  for (const key of immutableRecords) {
    index.set(keyVersionIndex(key.keyId, key.keyVersion), key);
  }
  return {
    ok: true,
    history: Object.freeze({
      records: Object.freeze(immutableRecords),
      [compiledHistory]: true as const,
      lookup(keyId: string, keyVersion: number) {
        return index.get(keyVersionIndex(keyId, keyVersion));
      },
    }),
  };
}

export function decodeVerificationKeyHistory(
  encoded: string | undefined,
): VerificationKeyRecord[] | undefined {
  if (!encoded || encoded.length > 1_048_576) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(encoded);
  } catch {
    return undefined;
  }
  const root = record(value);
  if (root?.version !== 1 || !Array.isArray(root.keys)) return undefined;
  const keys: VerificationKeyRecord[] = [];
  for (const candidate of root.keys) {
    const wire = record(candidate);
    if (!wire) return undefined;
    const key = {
      version: wire.version,
      keyId: wire.key_id,
      keyVersion: wire.key_version,
      subjectId: wire.subject_id,
      purpose: wire.purpose,
      scopeId: wire.scope_id,
      scheme: wire.scheme,
      publicKey: wire.public_key,
      validFromMs: wire.valid_from_ms,
      validUntilMs: wire.valid_until_ms,
      revokedAtMs: wire.revoked_at_ms,
    } as VerificationKeyRecord;
    if (!validKeyRecord(key)) return undefined;
    keys.push(key);
  }
  return validateVerificationKeyHistory(keys).ok ? keys : undefined;
}

function validKeyRecord(value: VerificationKeyRecord): boolean {
  return value !== null && typeof value === "object" && value.version === 1 &&
    identifier(value.keyId, 256) && safePositiveInteger(value.keyVersion) &&
    identifier(value.subjectId, 256) && identifier(value.purpose, 128) &&
    boundedText(value.scopeId, 256) && identifier(value.scheme, 128) &&
    boundedText(value.publicKey, 16_384) &&
    safeNonNegativeInteger(value.validFromMs) &&
    safeNonNegativeInteger(value.validUntilMs) &&
    value.validFromMs < value.validUntilMs &&
    (value.revokedAtMs === null ||
      (safeNonNegativeInteger(value.revokedAtMs) &&
        value.revokedAtMs >= value.validFromMs &&
        value.revokedAtMs <= value.validUntilMs));
}

function validAuthentication(value: KeyBoundAuthentication): boolean {
  return value !== null && typeof value === "object" && value.version === 1 &&
    identifier(value.purpose, 128) && boundedText(value.scopeId, 256) &&
    boundedText(value.unitId, 256) && identifier(value.subjectId, 256) &&
    identifier(value.keyId, 256) && safePositiveInteger(value.keyVersion) &&
    identifier(value.scheme, 128) && boundedText(value.publicKey, 16_384) &&
    boundedText(value.statementDigest, 4_096) &&
    safeNonNegativeInteger(value.issuedAtMs) &&
    boundedText(value.signature, 16_384);
}

function issuanceTimeRefusal(
  key: VerificationKeyRecord,
  issuedAtMs: number,
): Extract<KeyBoundVerification, { ok: false }>["reason"] | undefined {
  if (!safeNonNegativeInteger(issuedAtMs) || issuedAtMs < key.validFromMs) {
    return "key_not_yet_valid_at_issuance";
  }
  if (issuedAtMs >= key.validUntilMs) return "key_expired_at_issuance";
  if (key.revokedAtMs !== null && issuedAtMs >= key.revokedAtMs) {
    return "key_revoked_at_issuance";
  }
  return undefined;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function boundedText(value: unknown, maxLength: number): value is string {
  return typeof value === "string" && value.length > 0 &&
    value.length <= maxLength;
}

function identifier(value: unknown, maxLength: number): value is string {
  return boundedText(value, maxLength) &&
    /^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value);
}

function safePositiveInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}

function safeNonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function keyVersionIndex(keyId: string, keyVersion: number): string {
  return `${keyId}\u0000${keyVersion}`;
}
