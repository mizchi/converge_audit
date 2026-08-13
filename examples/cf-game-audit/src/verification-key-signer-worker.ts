import { DurableObject } from "cloudflare:workers";
import {
  signKeyBoundStatementAsync,
  validateVerificationKeyHistory,
  type VerificationKeyRecord,
} from "../../player-local-runtime/key-lifecycle.ts";
import {
  createStandardWebCryptoBackend,
  type AsyncAuditSigner,
} from "../../player-local-runtime/crypto-backend.ts";
import { VerificationKeyLifecycleStore } from
  "./verification-key-lifecycle-store.ts";

export interface VerificationKeySignerEnv {
  KEY_SIGNER: DurableObjectNamespace<VerificationKeySigner>;
  SIGNER_CALLER_TOKEN: string;
  SIGNER_ADMIN_TOKEN: string;
  SIGNING_KEY_SEED_HEX: string;
  SIGNING_KEY_ID: string;
  SIGNING_KEY_VERSION: string;
  SIGNING_KEY_LIFECYCLE_REVISION: string;
  SIGNING_SUBJECT_ID: string;
  SIGNING_PURPOSE: string;
  SIGNING_SCOPE_ID: string;
  SIGNING_SCHEME: string;
  SIGNING_PUBLIC_KEY: string;
  SIGNING_VALID_FROM_MS: string;
  SIGNING_VALID_UNTIL_MS: string;
  SIGNING_REVOKED_AT_MS?: string;
  SIGNER_RUNTIME_PROFILE?: "production" | "test";
}

interface SignerConfiguration {
  key: VerificationKeyRecord;
  lifecycleRevision: number;
  seedHex: string;
}

const standardCrypto = createStandardWebCryptoBackend(crypto);

export class VerificationKeySigner extends DurableObject<
  VerificationKeySignerEnv
> {
  private readonly lifecycle: VerificationKeyLifecycleStore;
  private readonly signerEnv: VerificationKeySignerEnv;
  private signer: Promise<AsyncAuditSigner> | undefined;

  constructor(
    ctx: DurableObjectState,
    signerEnv: VerificationKeySignerEnv,
  ) {
    super(ctx, signerEnv);
    this.signerEnv = signerEnv;
    this.lifecycle = new VerificationKeyLifecycleStore(ctx.storage);
  }

  async fetch(request: Request): Promise<Response> {
    if (request.headers.get("x-audit-internal") !== "verification-key-signer") {
      return jsonError("not_found", 404);
    }
    const configuration = parseConfiguration(this.signerEnv);
    if (!configuration) return jsonError("invalid_signer_configuration", 503);
    const synchronized = await synchronizeConfiguredKey(
      this.lifecycle,
      configuration,
    );
    if (!synchronized) return jsonError("key_lifecycle_mismatch", 503);

    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/key-history") {
      return jsonResponse(this.lifecycle.image(configuration.key.keyId));
    }
    if (request.method !== "POST") return jsonError("not_found", 404);
    const body = await boundedJson(request, 65_536);
    if (!body) return jsonError("invalid_request", 400);
    const nowMs = Date.now();
    if (!keyCanSignAt(configuration.key, nowMs)) {
      return jsonError("signing_key_inactive", 409);
    }

    let signer: AsyncAuditSigner;
    try {
      signer = await this.loadSigner(configuration);
    } catch {
      return jsonError("signing_key_unavailable", 503);
    }
    if (url.pathname === "/key-bound-sign") {
      if (!keyBoundRequestMatches(body, configuration.key)) {
        return jsonError("signing_binding_mismatch", 403);
      }
      try {
        const authentication = await signKeyBoundStatementAsync({
          key: configuration.key,
          unitId: body.unit_id as string,
          statementDigest: body.statement_digest as string,
          issuedAtMs: nowMs,
          signer,
          digest: standardCrypto,
        });
        return jsonResponse({ ok: true, authentication });
      } catch {
        return jsonError("signing_failed", 503);
      }
    }
    if (url.pathname === "/sign") {
      if (!legacyRequestMatches(body, configuration.key)) {
        return jsonError("signing_binding_mismatch", 403);
      }
      try {
        const signature = await signer.signDigest(body.digest as string);
        return jsonResponse({
          ok: true,
          scheme: configuration.key.scheme,
          signature,
          key_id: configuration.key.keyId,
          key_version: configuration.key.keyVersion,
          public_key: configuration.key.publicKey,
          issued_at_ms: nowMs,
        });
      } catch {
        return jsonError("signing_failed", 503);
      }
    }
    return jsonError("not_found", 404);
  }

  private loadSigner(
    configuration: SignerConfiguration,
  ): Promise<AsyncAuditSigner> {
    this.signer ??= standardCrypto.importLegacySeed(
      configuration.seedHex,
      configuration.key.publicKey,
    ).then((generated) => generated.signer);
    return this.signer;
  }
}

const signerWorker = {
  async fetch(request: Request, env: VerificationKeySignerEnv) {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/health") {
      return jsonResponse({ ok: true, service: "verification-key-signer" });
    }
    const configuration = parseConfiguration(env);
    if (!configuration) return jsonError("invalid_signer_configuration", 503);
    const historyPrefix = "/v1/key-history/";
    const historyKeyId = url.pathname.startsWith(historyPrefix)
      ? decodeURIComponent(url.pathname.slice(historyPrefix.length))
      : undefined;
    if (historyKeyId !== undefined) {
      if (!authorized(request, env.SIGNER_ADMIN_TOKEN)) {
        return jsonError("unauthorized", 401);
      }
      if (historyKeyId !== configuration.key.keyId) {
        return jsonError("unknown_key", 404);
      }
      return signerStub(env, configuration.key.keyId).fetch(internalRequest(
        request,
        "/key-history",
      ));
    }
    if (
      request.method !== "POST" ||
      (url.pathname !== "/v1/sign" && url.pathname !== "/v1/key-bound-sign")
    ) return jsonError("not_found", 404);
    if (!authorized(request, env.SIGNER_CALLER_TOKEN)) {
      return jsonError("unauthorized", 401);
    }
    if (
      request.headers.get("x-audit-signing-purpose") !==
        configuration.key.purpose
    ) return jsonError("signing_binding_mismatch", 403);
    return signerStub(env, configuration.key.keyId).fetch(internalRequest(
      request,
      url.pathname === "/v1/sign" ? "/sign" : "/key-bound-sign",
    ));
  },
};

export default signerWorker;

async function synchronizeConfiguredKey(
  store: VerificationKeyLifecycleStore,
  configuration: SignerConfiguration,
): Promise<boolean> {
  const image = store.image(configuration.key.keyId);
  const revision = image.events.at(-1)?.lifecycleRevision ?? 0;
  const current = image.records.at(-1);
  if (!current) {
    if (
      configuration.key.keyVersion !== 1 ||
      configuration.lifecycleRevision !== 1
    ) return false;
    return (await store.provision({
      record: configuration.key,
      expectedRevision: 0,
      committedAtMs: Date.now(),
      digest: standardCrypto,
    })).decision === "committed";
  }
  if (
    configuration.key.keyVersion === current.keyVersion + 1 &&
    configuration.lifecycleRevision === revision + 1
  ) {
    return (await store.rotate({
      keyId: current.keyId,
      previousKeyVersion: current.keyVersion,
      nextRecord: configuration.key,
      cutoverMs: configuration.key.validFromMs,
      expectedRevision: revision,
      committedAtMs: Date.now(),
      digest: standardCrypto,
    })).decision === "committed";
  }
  const exact = image.records.find((record) =>
    record.keyVersion === configuration.key.keyVersion
  );
  if (!exact || !sameKeyExceptRevocation(exact, configuration.key)) return false;
  if (
    exact.revokedAtMs === null && configuration.key.revokedAtMs !== null &&
    configuration.lifecycleRevision === revision + 1
  ) {
    return (await store.revoke({
      keyId: exact.keyId,
      keyVersion: exact.keyVersion,
      revokedAtMs: configuration.key.revokedAtMs,
      expectedRevision: revision,
      committedAtMs: Date.now(),
      digest: standardCrypto,
    })).decision === "committed";
  }
  return exact.revokedAtMs === configuration.key.revokedAtMs &&
    configuration.lifecycleRevision === revision;
}

function parseConfiguration(
  env: VerificationKeySignerEnv,
): SignerConfiguration | undefined {
  if (
    env.SIGNER_RUNTIME_PROFILE !== "production" &&
    env.SIGNER_RUNTIME_PROFILE !== "test"
  ) return undefined;
  const keyVersion = positiveInteger(env.SIGNING_KEY_VERSION);
  const lifecycleRevision = positiveInteger(
    env.SIGNING_KEY_LIFECYCLE_REVISION,
  );
  const validFromMs = nonNegativeInteger(env.SIGNING_VALID_FROM_MS);
  const validUntilMs = nonNegativeInteger(env.SIGNING_VALID_UNTIL_MS);
  const revokedAtMs = env.SIGNING_REVOKED_AT_MS === undefined
    ? null
    : nonNegativeInteger(env.SIGNING_REVOKED_AT_MS);
  if (
    keyVersion === undefined || lifecycleRevision === undefined ||
    validFromMs === undefined || validUntilMs === undefined ||
    revokedAtMs === undefined ||
    !/^[0-9a-f]{64}$/.test(env.SIGNING_KEY_SEED_HEX ?? "") ||
    !/^[0-9a-f]{64}$/.test(env.SIGNING_PUBLIC_KEY ?? "") ||
    env.SIGNING_SCHEME !== "ed25519-v1" ||
    !secretToken(env.SIGNER_CALLER_TOKEN) ||
    !secretToken(env.SIGNER_ADMIN_TOKEN)
  ) return undefined;
  const key: VerificationKeyRecord = {
    version: 1,
    keyId: env.SIGNING_KEY_ID,
    keyVersion,
    subjectId: env.SIGNING_SUBJECT_ID,
    purpose: env.SIGNING_PURPOSE,
    scopeId: env.SIGNING_SCOPE_ID,
    scheme: env.SIGNING_SCHEME,
    publicKey: env.SIGNING_PUBLIC_KEY,
    validFromMs,
    validUntilMs,
    revokedAtMs,
  };
  if (!validateVerificationKeyHistory([key]).ok) return undefined;
  return { key, lifecycleRevision, seedHex: env.SIGNING_KEY_SEED_HEX };
}

function keyBoundRequestMatches(
  body: Record<string, unknown>,
  key: VerificationKeyRecord,
): boolean {
  return body.version === 1 && body.subject_id === key.subjectId &&
    body.purpose === key.purpose && body.scope_id === key.scopeId &&
    boundedString(body.unit_id, 256) &&
    lowerHexDigest(body.statement_digest);
}

function legacyRequestMatches(
  body: Record<string, unknown>,
  key: VerificationKeyRecord,
): boolean {
  return body.version === 1 && body.source_id === key.subjectId &&
    body.scheme === key.scheme && lowerHexDigest(body.digest);
}

function sameKeyExceptRevocation(
  left: VerificationKeyRecord,
  right: VerificationKeyRecord,
): boolean {
  return left.version === right.version && left.keyId === right.keyId &&
    left.keyVersion === right.keyVersion &&
    left.subjectId === right.subjectId && left.purpose === right.purpose &&
    left.scopeId === right.scopeId && left.scheme === right.scheme &&
    left.publicKey === right.publicKey &&
    left.validFromMs === right.validFromMs &&
    left.validUntilMs === right.validUntilMs;
}

function keyCanSignAt(key: VerificationKeyRecord, nowMs: number): boolean {
  return nowMs >= key.validFromMs && nowMs < key.validUntilMs &&
    (key.revokedAtMs === null || nowMs < key.revokedAtMs);
}

function signerStub(
  env: VerificationKeySignerEnv,
  keyId: string,
): DurableObjectStub<VerificationKeySigner> {
  return env.KEY_SIGNER.get(env.KEY_SIGNER.idFromName(keyId));
}

function internalRequest(request: Request, pathname: string): Request {
  const headers = new Headers(request.headers);
  headers.set("x-audit-internal", "verification-key-signer");
  headers.delete("authorization");
  return new Request(`https://signer.internal${pathname}`, {
    method: request.method,
    headers,
    body: request.method === "GET" ? undefined : request.body,
  });
}

async function boundedJson(
  request: Request,
  maxBytes: number,
): Promise<Record<string, unknown> | undefined> {
  const encoded = await request.text();
  if (encoded.length === 0 || encoded.length > maxBytes) return undefined;
  try {
    const value: unknown = JSON.parse(encoded);
    return typeof value === "object" && value !== null && !Array.isArray(value)
      ? value as Record<string, unknown>
      : undefined;
  } catch {
    return undefined;
  }
}

function authorized(request: Request, token: string): boolean {
  return secretToken(token) &&
    request.headers.get("authorization") === `Bearer ${token}`;
}

function secretToken(value: unknown): value is string {
  return typeof value === "string" && value.length >= 16 && value.length <= 512;
}

function boundedString(value: unknown, maxLength: number): value is string {
  return typeof value === "string" && value.length > 0 &&
    value.length <= maxLength;
}

function lowerHexDigest(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
}

function positiveInteger(value: unknown): number | undefined {
  const parsed = integer(value);
  return parsed !== undefined && parsed > 0 ? parsed : undefined;
}

function nonNegativeInteger(value: unknown): number | undefined {
  const parsed = integer(value);
  return parsed !== undefined && parsed >= 0 ? parsed : undefined;
}

function integer(value: unknown): number | undefined {
  if (typeof value !== "string" || !/^(0|[1-9][0-9]*)$/.test(value)) {
    return undefined;
  }
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

function jsonResponse(value: unknown, status = 200): Response {
  return Response.json(value, {
    status,
    headers: { "cache-control": "no-store" },
  });
}

function jsonError(error: string, status: number): Response {
  return jsonResponse({ ok: false, error }, status);
}
