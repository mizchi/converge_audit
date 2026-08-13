import { DurableObject } from "cloudflare:workers";
import {
  buildEvidenceCaseResolutionEnvelope,
  buildEvidenceCaseResolutionPollRequest,
  decodeEvidenceCaseResolutionPollPage,
  type EvidenceCaseResolutionNotice,
  type EvidenceCaseResolutionPollCursor,
  type EvidenceCaseResolutionSourceSigner,
} from "../../player-local-runtime/evidence-case-resolution-relay";
import {
  createStandardWebCryptoBackend,
} from "../../player-local-runtime/crypto-backend";
import type {
  KeyBoundAuthentication,
} from "../../player-local-runtime/key-lifecycle";
import {
  createAsyncReferenceGameEvidenceResolutionAuthorizationVerifier,
} from "./evidence-case-resolution-authorization";
import {
  parseLineageDecisionArbiterRoster,
} from "./lineage-decision-certificate";

export interface EvidenceResolutionRelayEnv {
  SOURCE_RELAY: DurableObjectNamespace<EvidenceResolutionRelay>;
  AUTHORITY: Fetcher;
  SOURCE_SIGNER: Fetcher;
  SOURCE_SIGNER_TOKEN: string;
  RELAY_ADMIN_TOKEN: string;
  AUTHORITY_ORIGIN: string;
  EVIDENCE_SOURCE_ID: string;
  EVIDENCE_SOURCE_SCHEME: string;
  EVIDENCE_SOURCE_KEY_SCOPE_ID: string;
  EVIDENCE_UNIT: string;
  LINEAGE_ARBITER_ROSTER?: string;
  LINEAGE_DECISION_MAX_CLOCK_SKEW_MS?: string;
  RELAY_SUCCESS_INTERVAL_MS?: string;
  RELAY_BASE_BACKOFF_MS?: string;
  RELAY_MAX_BACKOFF_MS?: string;
  RELAY_LEASE_DURATION_MS?: string;
  RELAY_REQUEST_TIMEOUT_MS?: string;
  RELAY_RUNTIME_PROFILE?: "production" | "test";
}

interface EvidenceResolutionRelayConfiguration {
  authorityOrigin: string;
  sourceId: string;
  sourceScheme: string;
  sourceKeyScopeId: string;
  unit: string;
  successIntervalMs: number;
  baseBackoffMs: number;
  maxBackoffMs: number;
  leaseDurationMs: number;
  requestTimeoutMs: number;
}

interface EvidenceResolutionRelayPending {
  caseId: string;
  noticeSequence: number;
  resolutionId: string;
  envelope: unknown;
}

interface EvidenceResolutionRelayJob {
  cursor: EvidenceCaseResolutionPollCursor;
  nextPollAtMs: number;
  failures: number;
  attemptCount: number;
  leaseExpiresAtMs: number | null;
  pending: EvidenceResolutionRelayPending | null;
}

interface EvidenceResolutionRelayClaim {
  attemptCount: number;
  leaseExpiresAtMs: number;
  job: EvidenceResolutionRelayJob;
}

interface EvidenceResolutionRelayRow extends Record<string, SqlStorageValue> {
  authority_origin: string;
  source_id: string;
  source_scheme: string;
  source_key_scope_id: string;
  unit: string;
  cursor_sequence: number;
  cursor_resolution_id: string;
  next_poll_at_ms: number;
  failures: number;
  attempt_count: number;
  lease_expires_at_ms: number | null;
  pending_case_id: string | null;
  pending_notice_sequence: number | null;
  pending_resolution_id: string | null;
  pending_envelope_json: string | null;
}

export type EvidenceResolutionRelayRunResult =
  | { decision: "idle"; reason: "not_due" | "lease_active" }
  | {
    decision: "completed";
    outcome: "no_change" | "delivered" | "retry_scheduled";
    failures: number;
    next_poll_at_ms: number;
  }
  | { decision: "lost_lease" }
  | { decision: "refused"; reason: string };

const standardCrypto = createStandardWebCryptoBackend(crypto);
const MAX_AUTHORITY_RESPONSE_BYTES = 65_536;

function parseConfiguration(
  env: EvidenceResolutionRelayEnv,
): EvidenceResolutionRelayConfiguration | undefined {
  if (
    env.RELAY_RUNTIME_PROFILE !== "production" &&
    env.RELAY_RUNTIME_PROFILE !== "test"
  ) return undefined;
  let origin: string;
  try {
    const parsed = new URL(env.AUTHORITY_ORIGIN);
    origin = parsed.origin;
    if (parsed.protocol !== "https:" || origin !== env.AUTHORITY_ORIGIN) {
      return undefined;
    }
  } catch {
    return undefined;
  }
  const sourceId = identity(env.EVIDENCE_SOURCE_ID);
  const sourceScheme = boundedString(env.EVIDENCE_SOURCE_SCHEME, 128);
  const unit = boundedString(env.EVIDENCE_UNIT, 256);
  const sourceKeyScopeId = boundedString(
    env.EVIDENCE_SOURCE_KEY_SCOPE_ID,
    256,
  );
  const signerToken = boundedString(env.SOURCE_SIGNER_TOKEN, 512);
  const successIntervalMs = positiveEnvInteger(
    env.RELAY_SUCCESS_INTERVAL_MS,
    15_000,
  );
  const baseBackoffMs = positiveEnvInteger(env.RELAY_BASE_BACKOFF_MS, 1_000);
  const maxBackoffMs = positiveEnvInteger(env.RELAY_MAX_BACKOFF_MS, 60_000);
  const leaseDurationMs = positiveEnvInteger(
    env.RELAY_LEASE_DURATION_MS,
    30_000,
  );
  const requestTimeoutMs = positiveEnvInteger(
    env.RELAY_REQUEST_TIMEOUT_MS,
    10_000,
  );
  if (
    !sourceId || !sourceScheme || !unit || !sourceKeyScopeId || !signerToken ||
    signerToken.length < 16 || successIntervalMs === undefined ||
    baseBackoffMs === undefined || maxBackoffMs === undefined ||
    leaseDurationMs === undefined || requestTimeoutMs === undefined ||
    maxBackoffMs < baseBackoffMs || requestTimeoutMs > leaseDurationMs ||
    requestTimeoutMs > 60_000
  ) return undefined;
  if (
    env.RELAY_RUNTIME_PROFILE === "production" &&
    sourceScheme !== "ed25519-v1"
  ) return undefined;
  return {
    authorityOrigin: origin,
    sourceId,
    sourceScheme,
    sourceKeyScopeId,
    unit,
    successIntervalMs,
    baseBackoffMs,
    maxBackoffMs,
    leaseDurationMs,
    requestTimeoutMs,
  };
}

export async function runEvidenceResolutionRelayOnce(
  relay: EvidenceResolutionRelay,
  env: EvidenceResolutionRelayEnv,
  configuration: EvidenceResolutionRelayConfiguration,
  nowMs: number,
): Promise<EvidenceResolutionRelayRunResult> {
  const claim = await relay.claim(configuration, nowMs);
  if (claim.decision !== "claimed") return claim;
  const token = {
    attemptCount: claim.claim.attemptCount,
    leaseExpiresAtMs: claim.claim.leaseExpiresAtMs,
  };
  try {
    if (claim.claim.job.pending) {
      return await publishPending(
        relay,
        env,
        configuration,
        token,
        claim.claim.job.pending,
        nowMs,
      );
    }
    const signer = sourceSigner(env, configuration);
    const poll = await buildEvidenceCaseResolutionPollRequest({
      audience: configuration.authorityOrigin,
      unit: configuration.unit,
      cursor: claim.claim.job.cursor,
      limit: 1,
      digest: standardCrypto,
      signer,
      keyBoundScopeId: configuration.sourceKeyScopeId,
    });
    const pollResponse = await boundedFetchJson(
      env.AUTHORITY,
      new Request(
        `${configuration.authorityOrigin}/v1/pve/${encodeURIComponent(configuration.unit)}/game-evidence-case-resolution-polls`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(poll),
        },
      ),
      configuration.requestTimeoutMs,
    );
    if (!pollResponse.ok) {
      return await scheduleFailure(
        relay,
        configuration,
        token,
        claim.claim.job.failures,
        nowMs,
        pollResponse.reason,
      );
    }
    const decoded = decodeEvidenceCaseResolutionPollPage(
      pollResponse.value,
      claim.claim.job.cursor,
      1,
    );
    if (!decoded.ok) {
      return await scheduleFailure(
        relay,
        configuration,
        token,
        claim.claim.job.failures,
        nowMs,
        decoded.reason,
      );
    }
    const notice = decoded.page.notices[0];
    if (!notice) {
      const nextPollAtMs = safeAdd(nowMs, configuration.successIntervalMs);
      if (nextPollAtMs === undefined) {
        return { decision: "refused", reason: "invalid_next_poll" };
      }
      const completed = await relay.completeNoChange(token, nextPollAtMs);
      return completed
        ? {
          decision: "completed",
          outcome: "no_change",
          failures: 0,
          next_poll_at_ms: nextPollAtMs,
        }
        : { decision: "lost_lease" };
    }
    const authorizationVerifier = authorizationVerifierFromEnv(env);
    if (!authorizationVerifier) {
      return await scheduleFailure(
        relay,
        configuration,
        token,
        claim.claim.job.failures,
        nowMs,
        "arbiter_roster_not_configured",
      );
    }
    const envelope = await buildEvidenceCaseResolutionEnvelope(notice, {
      cursor: decoded.page.sourceCursor,
      authorizationVerifier,
      digest: standardCrypto,
      signer,
      keyBoundScopeId: configuration.sourceKeyScopeId,
    });
    if (!envelope.ok) {
      return await scheduleFailure(
        relay,
        configuration,
        token,
        claim.claim.job.failures,
        nowMs,
        envelope.reason,
      );
    }
    const pending: EvidenceResolutionRelayPending = {
      caseId: notice.caseId,
      noticeSequence: notice.noticeSequence,
      resolutionId: notice.resolution.resolution_digest,
      envelope: envelope.envelope,
    };
    if (!await relay.persistPending(token, pending)) {
      return { decision: "lost_lease" };
    }
    return await publishPending(
      relay,
      env,
      configuration,
      token,
      pending,
      nowMs,
    );
  } catch (error) {
    return await scheduleFailure(
      relay,
      configuration,
      token,
      claim.claim.job.failures,
      nowMs,
      error instanceof Error ? error.message : "relay_failed",
    );
  }
}

async function publishPending(
  relay: EvidenceResolutionRelay,
  env: EvidenceResolutionRelayEnv,
  configuration: EvidenceResolutionRelayConfiguration,
  token: { attemptCount: number; leaseExpiresAtMs: number },
  pending: EvidenceResolutionRelayPending,
  nowMs: number,
): Promise<EvidenceResolutionRelayRunResult> {
  const response = await boundedFetchJson(
    env.AUTHORITY,
    new Request(
      `${configuration.authorityOrigin}/v1/pve/${encodeURIComponent(configuration.unit)}/game-evidence-case-resolution-envelopes`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          version: 1,
          case_id: pending.caseId,
          envelope: pending.envelope,
        }),
      },
    ),
    configuration.requestTimeoutMs,
  );
  if (!response.ok) {
    const row = relay.image();
    return await scheduleFailure(
      relay,
      configuration,
      token,
      row?.failures ?? 0,
      nowMs,
      response.reason,
    );
  }
  const result = recordValue(response.value);
  if (
    result?.ok !== true ||
    (result.decision !== "published" && result.decision !== "duplicate")
  ) {
    const row = relay.image();
    return await scheduleFailure(
      relay,
      configuration,
      token,
      row?.failures ?? 0,
      nowMs,
      "publish_refused",
    );
  }
  const nextPollAtMs = safeAdd(nowMs, configuration.successIntervalMs);
  if (nextPollAtMs === undefined) {
    return { decision: "refused", reason: "invalid_next_poll" };
  }
  const completed = await relay.completeDelivered(
    token,
    pending,
    nextPollAtMs,
  );
  return completed
    ? {
      decision: "completed",
      outcome: "delivered",
      failures: 0,
      next_poll_at_ms: nextPollAtMs,
    }
    : { decision: "lost_lease" };
}

async function scheduleFailure(
  relay: EvidenceResolutionRelay,
  configuration: EvidenceResolutionRelayConfiguration,
  token: { attemptCount: number; leaseExpiresAtMs: number },
  previousFailures: number,
  nowMs: number,
  _reason: string,
): Promise<EvidenceResolutionRelayRunResult> {
  const failures = previousFailures + 1;
  const exponent = Math.min(previousFailures, 30);
  const delay = Math.min(
    configuration.maxBackoffMs,
    configuration.baseBackoffMs * (2 ** exponent),
  );
  const nextPollAtMs = safeAdd(nowMs, delay);
  if (!Number.isSafeInteger(failures) || nextPollAtMs === undefined) {
    return { decision: "refused", reason: "invalid_backoff" };
  }
  const completed = await relay.completeFailure(
    token,
    failures,
    nextPollAtMs,
  );
  return completed
    ? {
      decision: "completed",
      outcome: "retry_scheduled",
      failures,
      next_poll_at_ms: nextPollAtMs,
    }
    : { decision: "lost_lease" };
}

function sourceSigner(
  env: EvidenceResolutionRelayEnv,
  configuration: EvidenceResolutionRelayConfiguration,
): EvidenceCaseResolutionSourceSigner {
  return Object.freeze({
    version: 2 as const,
    async authenticate(input: {
      purpose: "evidence-case-resolution";
      scopeId: string;
      unitId: string;
      statementDigest: string;
    }): Promise<KeyBoundAuthentication> {
      const response = await boundedFetchJson(
        env.SOURCE_SIGNER,
        new Request("https://source-signer.internal/v1/key-bound-sign", {
          method: "POST",
          headers: {
            authorization: `Bearer ${env.SOURCE_SIGNER_TOKEN}`,
            "content-type": "application/json",
            "x-audit-signing-purpose": "evidence-case-resolution",
          },
          body: JSON.stringify({
            version: 1,
            subject_id: configuration.sourceId,
            purpose: input.purpose,
            scope_id: input.scopeId,
            unit_id: input.unitId,
            statement_digest: input.statementDigest,
          }),
        }),
        configuration.requestTimeoutMs,
      );
      const body = response.ok ? recordValue(response.value) : undefined;
      const authentication = recordValue(body?.authentication);
      if (
        !body || body.ok !== true || !authentication ||
        authentication.scheme !== configuration.sourceScheme
      ) throw new Error("source_signer_refused");
      return authentication as unknown as KeyBoundAuthentication;
    },
  });
}

function authorizationVerifierFromEnv(env: EvidenceResolutionRelayEnv) {
  const roster = parseLineageDecisionArbiterRoster(env.LINEAGE_ARBITER_ROSTER);
  if (!roster) return undefined;
  const verifiers: Record<string, typeof standardCrypto> = {};
  for (const arbiter of Object.values(roster)) {
    verifiers[arbiter.scheme] = standardCrypto;
  }
  const maxClockSkewMs = nonNegativeEnvInteger(
    env.LINEAGE_DECISION_MAX_CLOCK_SKEW_MS,
    30_000,
  );
  if (maxClockSkewMs === undefined) return undefined;
  return createAsyncReferenceGameEvidenceResolutionAuthorizationVerifier({
    roster,
    verifiers,
    digest: standardCrypto,
    maxClockSkewMs,
  });
}

export class EvidenceResolutionRelay extends DurableObject<
  EvidenceResolutionRelayEnv
> {
  constructor(
    ctx: DurableObjectState,
    env: EvidenceResolutionRelayEnv,
  ) {
    super(ctx, env);
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS evidence_resolution_relay (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        authority_origin TEXT NOT NULL,
        source_id TEXT NOT NULL,
        source_scheme TEXT NOT NULL,
        source_key_scope_id TEXT NOT NULL DEFAULT '',
        unit TEXT NOT NULL,
        cursor_sequence INTEGER NOT NULL CHECK (cursor_sequence >= -1),
        cursor_resolution_id TEXT NOT NULL,
        next_poll_at_ms INTEGER NOT NULL CHECK (next_poll_at_ms >= 0),
        failures INTEGER NOT NULL CHECK (failures >= 0),
        attempt_count INTEGER NOT NULL CHECK (attempt_count >= 0),
        lease_expires_at_ms INTEGER CHECK (lease_expires_at_ms >= 0),
        pending_case_id TEXT,
        pending_notice_sequence INTEGER,
        pending_resolution_id TEXT,
        pending_envelope_json TEXT,
        CHECK (
          (pending_case_id IS NULL AND pending_notice_sequence IS NULL AND
           pending_resolution_id IS NULL AND pending_envelope_json IS NULL) OR
          (pending_case_id IS NOT NULL AND pending_notice_sequence IS NOT NULL AND
           pending_resolution_id IS NOT NULL AND pending_envelope_json IS NOT NULL)
        )
      );
    `);
    const columns = this.ctx.storage.sql.exec<{ name: string }>(
      "PRAGMA table_info(evidence_resolution_relay)",
    ).toArray();
    if (!columns.some((column) => column.name === "source_key_scope_id")) {
      this.ctx.storage.sql.exec(
        "ALTER TABLE evidence_resolution_relay ADD COLUMN source_key_scope_id TEXT NOT NULL DEFAULT ''",
      );
    }
  }

  async fetch(request: Request): Promise<Response> {
    if (request.headers.get("x-audit-internal") !== "source-relay") {
      return jsonError("not_found", 404);
    }
    const configuration = parseConfiguration(this.env);
    if (!configuration) return jsonError("invalid_relay_configuration", 503);
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/status") {
      return jsonResponse({ ok: true, job: this.image() });
    }
    if (request.method !== "POST" || url.pathname !== "/run") {
      return jsonError("not_found", 404);
    }
    let nowMs = Date.now();
    if (this.env.RELAY_RUNTIME_PROFILE === "test") {
      const value = await request.json().catch(() => undefined) as
        | { now_ms?: unknown }
        | undefined;
      if (Number.isSafeInteger(value?.now_ms) && (value?.now_ms as number) >= 0) {
        nowMs = value!.now_ms as number;
      }
    }
    const result = await runEvidenceResolutionRelayOnce(
      this,
      this.env,
      configuration,
      nowMs,
    );
    return jsonResponse({ ok: result.decision !== "refused", ...result });
  }

  async alarm(): Promise<void> {
    const configuration = parseConfiguration(this.env);
    if (!configuration) throw new Error("invalid relay configuration");
    const result = await runEvidenceResolutionRelayOnce(
      this,
      this.env,
      configuration,
      Date.now(),
    );
    if (result.decision === "refused") {
      throw new Error(`evidence resolution relay refused: ${result.reason}`);
    }
  }

  async claim(
    configuration: EvidenceResolutionRelayConfiguration,
    nowMs: number,
  ): Promise<
    | { decision: "claimed"; claim: EvidenceResolutionRelayClaim }
    | { decision: "idle"; reason: "not_due" | "lease_active" }
    | { decision: "refused"; reason: string }
  > {
    const leaseExpiresAtMs = safeAdd(nowMs, configuration.leaseDurationMs);
    if (leaseExpiresAtMs === undefined) {
      return { decision: "refused", reason: "invalid_lease" };
    }
    const result = this.ctx.storage.transactionSync(() => {
      let row = this.row();
      if (!row) {
        this.ctx.storage.sql.exec(
          `INSERT INTO evidence_resolution_relay
           (singleton, authority_origin, source_id, source_scheme,
            source_key_scope_id, unit,
            cursor_sequence, cursor_resolution_id, next_poll_at_ms, failures,
            attempt_count, lease_expires_at_ms, pending_case_id,
            pending_notice_sequence, pending_resolution_id, pending_envelope_json)
           VALUES (1, ?, ?, ?, ?, ?, -1, 'resolution-genesis', 0, 0, 0, NULL,
                   NULL, NULL, NULL, NULL)`,
          configuration.authorityOrigin,
          configuration.sourceId,
          configuration.sourceScheme,
          configuration.sourceKeyScopeId,
          configuration.unit,
        );
        row = this.row()!;
      }
      if (row.source_key_scope_id === "") {
        this.ctx.storage.sql.exec(
          `UPDATE evidence_resolution_relay SET source_key_scope_id = ?
           WHERE singleton = 1 AND source_key_scope_id = ''`,
          configuration.sourceKeyScopeId,
        );
        row = this.row()!;
      }
      if (!sameConfiguration(row, configuration)) {
        return { decision: "refused" as const, reason: "configuration_changed" };
      }
      if (row.lease_expires_at_ms !== null && row.lease_expires_at_ms > nowMs) {
        return { decision: "idle" as const, reason: "lease_active" as const };
      }
      if (row.next_poll_at_ms > nowMs) {
        return { decision: "idle" as const, reason: "not_due" as const };
      }
      const attemptCount = row.attempt_count + 1;
      if (!Number.isSafeInteger(attemptCount)) {
        return { decision: "refused" as const, reason: "attempt_overflow" };
      }
      this.ctx.storage.sql.exec(
        `UPDATE evidence_resolution_relay
         SET attempt_count = ?, lease_expires_at_ms = ? WHERE singleton = 1`,
        attemptCount,
        leaseExpiresAtMs,
      );
      const job = relayJob({
        ...row,
        attempt_count: attemptCount,
        lease_expires_at_ms: leaseExpiresAtMs,
      });
      return {
        decision: "claimed" as const,
        claim: { attemptCount, leaseExpiresAtMs, job },
      };
    });
    if (result.decision === "claimed") {
      if (this.env.RELAY_RUNTIME_PROFILE !== "test") {
        await this.ctx.storage.setAlarm(leaseExpiresAtMs);
      }
      await this.ctx.storage.sync();
    }
    return result;
  }

  async persistPending(
    token: { attemptCount: number; leaseExpiresAtMs: number },
    pending: EvidenceResolutionRelayPending,
  ): Promise<boolean> {
    const encoded = JSON.stringify(pending.envelope);
    const row = this.row();
    if (!row || !tokenMatches(row, token)) return false;
    if (row.pending_envelope_json !== null) {
      return row.pending_case_id === pending.caseId &&
        row.pending_notice_sequence === pending.noticeSequence &&
        row.pending_resolution_id === pending.resolutionId &&
        row.pending_envelope_json === encoded;
    }
    this.ctx.storage.sql.exec(
      `UPDATE evidence_resolution_relay
       SET pending_case_id = ?, pending_notice_sequence = ?,
           pending_resolution_id = ?, pending_envelope_json = ?
       WHERE singleton = 1 AND attempt_count = ? AND lease_expires_at_ms = ?
         AND pending_envelope_json IS NULL`,
      pending.caseId,
      pending.noticeSequence,
      pending.resolutionId,
      encoded,
      token.attemptCount,
      token.leaseExpiresAtMs,
    );
    await this.ctx.storage.sync();
    return this.changes() === 1;
  }

  async completeNoChange(
    token: { attemptCount: number; leaseExpiresAtMs: number },
    nextPollAtMs: number,
  ): Promise<boolean> {
    return this.complete(token, nextPollAtMs, 0, false, undefined);
  }

  async completeFailure(
    token: { attemptCount: number; leaseExpiresAtMs: number },
    failures: number,
    nextPollAtMs: number,
  ): Promise<boolean> {
    return this.complete(token, nextPollAtMs, failures, false, undefined);
  }

  async completeDelivered(
    token: { attemptCount: number; leaseExpiresAtMs: number },
    pending: EvidenceResolutionRelayPending,
    nextPollAtMs: number,
  ): Promise<boolean> {
    return this.complete(token, nextPollAtMs, 0, true, pending);
  }

  image(): EvidenceResolutionRelayJob | undefined {
    const row = this.row();
    return row ? relayJob(row) : undefined;
  }

  private async complete(
    token: { attemptCount: number; leaseExpiresAtMs: number },
    nextPollAtMs: number,
    failures: number,
    delivered: boolean,
    pending: EvidenceResolutionRelayPending | undefined,
  ): Promise<boolean> {
    if (delivered && pending) {
      this.ctx.storage.sql.exec(
        `UPDATE evidence_resolution_relay
         SET cursor_sequence = ?, cursor_resolution_id = ?,
             next_poll_at_ms = ?, failures = ?, lease_expires_at_ms = NULL,
             pending_case_id = NULL, pending_notice_sequence = NULL,
             pending_resolution_id = NULL, pending_envelope_json = NULL
         WHERE singleton = 1 AND attempt_count = ? AND lease_expires_at_ms = ?
           AND pending_case_id = ? AND pending_notice_sequence = ?
           AND pending_resolution_id = ?`,
        pending.noticeSequence,
        pending.resolutionId,
        nextPollAtMs,
        failures,
        token.attemptCount,
        token.leaseExpiresAtMs,
        pending.caseId,
        pending.noticeSequence,
        pending.resolutionId,
      );
    } else {
      this.ctx.storage.sql.exec(
        `UPDATE evidence_resolution_relay
         SET next_poll_at_ms = ?, failures = ?, lease_expires_at_ms = NULL
         WHERE singleton = 1 AND attempt_count = ? AND lease_expires_at_ms = ?`,
        nextPollAtMs,
        failures,
        token.attemptCount,
        token.leaseExpiresAtMs,
      );
    }
    const changed = this.changes() === 1;
    if (changed) {
      if (this.env.RELAY_RUNTIME_PROFILE !== "test") {
        await this.ctx.storage.setAlarm(nextPollAtMs);
      }
      await this.ctx.storage.sync();
    }
    return changed;
  }

  private row(): EvidenceResolutionRelayRow | undefined {
    return this.ctx.storage.sql.exec<EvidenceResolutionRelayRow>(
      `SELECT authority_origin, source_id, source_scheme, source_key_scope_id,
              unit,
              cursor_sequence, cursor_resolution_id, next_poll_at_ms, failures,
              attempt_count, lease_expires_at_ms, pending_case_id,
              pending_notice_sequence, pending_resolution_id,
              pending_envelope_json
       FROM evidence_resolution_relay WHERE singleton = 1`,
    ).toArray()[0];
  }

  private changes(): number {
    return this.ctx.storage.sql.exec<{ changed: number }>(
      "SELECT changes() AS changed",
    ).toArray()[0]?.changed ?? 0;
  }
}

const relayWorker = {
  async fetch(request: Request, env: EvidenceResolutionRelayEnv) {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/health") {
      return jsonResponse({ ok: true, service: "evidence-resolution-relay" });
    }
    if (!authorized(request, env.RELAY_ADMIN_TOKEN)) {
      return jsonError("unauthorized", 401);
    }
    const configuration = parseConfiguration(env);
    if (!configuration) return jsonError("invalid_relay_configuration", 503);
    const stub = env.SOURCE_RELAY.get(
      env.SOURCE_RELAY.idFromName(configuration.sourceId),
    );
    if (request.method === "GET" && url.pathname === "/v1/relay/status") {
      return stub.fetch(new Request("https://relay.internal/status", {
        headers: { "x-audit-internal": "source-relay" },
      }));
    }
    if (request.method === "POST" && url.pathname === "/v1/relay/run") {
      const body = env.RELAY_RUNTIME_PROFILE === "test"
        ? await request.text()
        : "";
      return stub.fetch(new Request("https://relay.internal/run", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-audit-internal": "source-relay",
        },
        body: body || "{}",
      }));
    }
    return jsonError("not_found", 404);
  },

  async scheduled(
    _controller: ScheduledController,
    env: EvidenceResolutionRelayEnv,
    ctx: ExecutionContext,
  ): Promise<void> {
    const configuration = parseConfiguration(env);
    if (!configuration) throw new Error("invalid relay configuration");
    const stub = env.SOURCE_RELAY.get(
      env.SOURCE_RELAY.idFromName(configuration.sourceId),
    );
    ctx.waitUntil(stub.fetch(new Request("https://relay.internal/run", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-audit-internal": "source-relay",
      },
      body: "{}",
    })).then(async (response) => {
      if (!response.ok) throw new Error(await response.text());
      await response.body?.cancel();
    }));
  },
} satisfies ExportedHandler<EvidenceResolutionRelayEnv>;

export default relayWorker;

function relayJob(row: EvidenceResolutionRelayRow): EvidenceResolutionRelayJob {
  let pending: EvidenceResolutionRelayPending | null = null;
  if (
    row.pending_case_id !== null && row.pending_notice_sequence !== null &&
    row.pending_resolution_id !== null && row.pending_envelope_json !== null
  ) {
    pending = {
      caseId: row.pending_case_id,
      noticeSequence: row.pending_notice_sequence,
      resolutionId: row.pending_resolution_id,
      envelope: JSON.parse(row.pending_envelope_json),
    };
  }
  return {
    cursor: {
      sourceId: row.source_id,
      sequence: row.cursor_sequence,
      resolutionId: row.cursor_resolution_id,
    },
    nextPollAtMs: row.next_poll_at_ms,
    failures: row.failures,
    attemptCount: row.attempt_count,
    leaseExpiresAtMs: row.lease_expires_at_ms,
    pending,
  };
}

function sameConfiguration(
  row: EvidenceResolutionRelayRow,
  configuration: EvidenceResolutionRelayConfiguration,
): boolean {
  return row.authority_origin === configuration.authorityOrigin &&
    row.source_id === configuration.sourceId &&
    row.source_scheme === configuration.sourceScheme &&
    row.source_key_scope_id === configuration.sourceKeyScopeId &&
    row.unit === configuration.unit;
}

function tokenMatches(
  row: EvidenceResolutionRelayRow,
  token: { attemptCount: number; leaseExpiresAtMs: number },
): boolean {
  return row.attempt_count === token.attemptCount &&
    row.lease_expires_at_ms === token.leaseExpiresAtMs;
}

async function boundedFetchJson(
  fetcher: Fetcher,
  request: Request,
  timeoutMs: number,
): Promise<
  | { ok: true; value: unknown }
  | { ok: false; reason: string }
> {
  let response: Response;
  try {
    response = await fetcher.fetch(new Request(request, {
      signal: AbortSignal.timeout(timeoutMs),
    }));
  } catch {
    return { ok: false, reason: "transport_error" };
  }
  if (!response.ok) {
    await response.body?.cancel();
    return { ok: false, reason: `http_${response.status}` };
  }
  const declared = response.headers.get("content-length");
  if (declared && Number(declared) > MAX_AUTHORITY_RESPONSE_BYTES) {
    await response.body?.cancel();
    return { ok: false, reason: "response_too_large" };
  }
  const bytes = await response.arrayBuffer();
  if (bytes.byteLength > MAX_AUTHORITY_RESPONSE_BYTES) {
    return { ok: false, reason: "response_too_large" };
  }
  try {
    return {
      ok: true,
      value: JSON.parse(new TextDecoder().decode(bytes)),
    };
  } catch {
    return { ok: false, reason: "invalid_json" };
  }
}

function authorized(request: Request, token: string | undefined): boolean {
  return typeof token === "string" && token.length >= 16 &&
    request.headers.get("authorization") === `Bearer ${token}`;
}

function safeAdd(left: number, right: number): number | undefined {
  const value = left + right;
  return Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function positiveEnvInteger(
  value: string | undefined,
  fallback: number,
): number | undefined {
  if (value === undefined) return fallback;
  if (!/^[1-9][0-9]*$/.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

function nonNegativeEnvInteger(
  value: string | undefined,
  fallback: number,
): number | undefined {
  if (value === undefined) return fallback;
  if (!/^(0|[1-9][0-9]*)$/.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

function identity(value: string): string | undefined {
  return /^[A-Za-z0-9._:-]{1,256}$/.test(value) ? value : undefined;
}

function boundedString(value: unknown, maximum: number): string | undefined {
  return typeof value === "string" && value.length > 0 &&
      value.length <= maximum
    ? value
    : undefined;
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function jsonResponse(value: unknown, status = 200): Response {
  return Response.json(value, { status });
}

function jsonError(error: string, status: number): Response {
  return jsonResponse({ ok: false, error }, status);
}
