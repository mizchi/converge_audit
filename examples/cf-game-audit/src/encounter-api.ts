import { createStandardWebCryptoBackend } from "../../player-local-runtime/crypto-backend.ts";
import type { AsyncAuditSigner } from "../../player-local-runtime/crypto-backend.ts";
import { EncounterAuthority, SqliteEncounterLedger, ENCOUNTER_RULES, type EncounterSql, type EncounterAuthorization } from "../game/encounter/index.ts";
import { decodeEncounterRequest, decodePayload, encodePayload, encounterRequestFrame, exactKeys, identifier, readBoundedEncounterJson } from "../game/encounter/http-wire.ts";
import { encounterStartKey, isDigest, isTime } from "../game/encounter/wire.ts";
import { EncounterEvidenceCases } from "./encounter-evidence.ts";
import type { EncounterArchive } from "../game/encounter/archive.ts";
import { SqliteEncounterInventory } from "../game/encounter/inventory-store.ts";
import { SqliteEncounterGenerations } from "../game/encounter/generation-store.ts";
import { SqliteEncounterRecovery } from "../game/encounter/recovery-store.ts";

export interface EncounterApiOptions {
  sql: EncounterSql;
  signer: AsyncAuditSigner;
  crypto: Crypto;
  adminToken: string;
  now(): number;
  retentionMs: number;
  maxAdmissions?: number;
  archive?: EncounterArchive;
  transaction?<T>(body: () => T): T;
}
const json = (value: unknown, status = 200) => Response.json(value, { status,
  headers: { "cache-control": "no-store" } });
const error = (code: string, status: number) => json({ error: code }, status);

/** The admin authorizes a finite start resource; the public signed endpoint
can only consume that existing resource. Replay within the TTL is intentionally
idempotent, with no unbounded nonce ledger and no claim of single execution. */
export class EncounterHttpApi {
  readonly evidenceCases: EncounterEvidenceCases;
  private readonly options: EncounterApiOptions;
  private readonly ledger: SqliteEncounterLedger;
  private readonly authority: EncounterAuthority;
  private readonly backend;
  private readonly inventory?: SqliteEncounterInventory;
  private readonly generations?: SqliteEncounterGenerations;
  private readonly recovery?: SqliteEncounterRecovery;
  constructor(options: EncounterApiOptions) {
    if (!Number.isInteger(options.maxAdmissions ?? 1_024) || (options.maxAdmissions ?? 1_024) < 1 || (options.maxAdmissions ?? 1_024) > 1_024) throw new Error("invalid admission bound");
    this.options = { ...options };
    if (!options.transaction && options.sql.exec("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'encounter_generations_v1'").toArray().length)
      throw new Error("generation transaction required for upgraded database");
    this.ledger = new SqliteEncounterLedger(options.sql);
    this.evidenceCases = new EncounterEvidenceCases({ sql: options.sql, ledger: this.ledger, fence: (id) => this.authority.fenceEvidenceCase(id) });
    this.authority = new EncounterAuthority({ ...options, ledger: this.ledger, hasEvidenceCases: (id) => this.evidenceCases.hasHold(id), trustedArchiveKey: options.archive?.publicKey,
      currentGeneration: (unit) => this.generations?.current(unit) ?? 0 });
    this.backend = createStandardWebCryptoBackend(options.crypto);
    if (options.transaction) this.inventory = new SqliteEncounterInventory({ sql: options.sql, signer: options.signer, now: options.now,
      transaction: options.transaction, ledger: this.ledger, backend: this.backend,
      currentGeneration: (unit) => this.generations!.current(unit), held: (id) => this.evidenceCases.hasHold(id) });
    if (options.transaction) this.generations = new SqliteEncounterGenerations({ sql: options.sql, signer: options.signer, now: options.now, backend: this.backend,
      archive: options.archive, transaction: options.transaction, held: (id) => this.evidenceCases.hasHold(id) });
    if (options.transaction) this.recovery = new SqliteEncounterRecovery({ sql: options.sql, ledger: this.ledger, backend: this.backend,
      transaction: options.transaction, trustedKey: options.signer.publicKey, currentGeneration: (unit) => this.generations!.current(unit),
      held: (id) => this.evidenceCases.hasHold(id), now: options.now });
    options.sql.exec(`CREATE TABLE IF NOT EXISTS encounter_admissions_v1 (
      start_head TEXT PRIMARY KEY, data TEXT NOT NULL
    )`);
    if (this.generations) options.sql.exec(`INSERT OR IGNORE INTO encounter_admissions_v2 (unit, generation, start_head, data)
      SELECT json_extract(a.data, '$.unit'), 0, a.start_head, a.data FROM encounter_admissions_v1 a
      WHERE COALESCE((SELECT generation FROM encounter_generations_v1 g WHERE g.unit = json_extract(a.data, '$.unit')), 0) = 0`);
    options.sql.exec(`CREATE INDEX IF NOT EXISTS encounter_admission_owner_v1 ON encounter_admissions_v1
      (json_extract(data, '$.ownerPublicKey'), json_extract(data, '$.unit'), start_head)`);
    options.sql.exec(`CREATE INDEX IF NOT EXISTS encounter_ticket_start_v1 ON encounter_tickets_v1
      (json_extract(data, '$.ticket.unit'), json_extract(data, '$.ticket.startHead'))`);
  }
  private admission(unit: string, generation: number, startHead: string): EncounterAuthorization | undefined {
    const row = this.generations ? this.options.sql.exec("SELECT data FROM encounter_admissions_v2 WHERE unit = ? AND generation = ? AND start_head = ?", unit, generation, startHead).toArray()[0] :
      this.options.sql.exec("SELECT data FROM encounter_admissions_v1 WHERE start_head = ?", startHead).toArray()[0];
    return row ? JSON.parse(row.data as string) : undefined;
  }
  async fetch(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname.split("/").filter(Boolean);
    if (path.length !== 4 || path[0] !== "v1" || path[1] !== "pve" || !identifier(path[2]) ||
        !["encounter", "encounter-admissions", "encounter-configuration", "encounter-generation"].includes(path[3])) return error("not_found", 404);
    if (path[3] === "encounter-configuration") {
      if (request.method !== "GET") return error("method_not_allowed", 405);
      const serverNow = this.options.now();
      if (!isTime(serverNow)) return error("authority_clock_unavailable", 503);
      return json({ version: 1, unit: path[2], rulesId: ENCOUNTER_RULES, authorityKey: this.options.signer.publicKey, archiveKey: this.options.archive?.publicKey, generation: this.generations?.current(path[2]) ?? 0, serverNow });
    }
    if (request.method !== "POST") return error("method_not_allowed", 405);
    const unit = path[2];
    const admin = path[3] === "encounter-admissions" || path[3] === "encounter-generation";
    if (admin && (!this.options.adminToken || request.headers.get("authorization") !== `Bearer ${this.options.adminToken}`)) return error("unauthorized", 401);
    let value: unknown;
    try { value = await readBoundedEncounterJson(request); }
    catch (e) { return e instanceof Error && e.message === "body_too_large" ? error("body_too_large", 413) : error("invalid_json", 400); }
    if (path[3] === "encounter-generation") {
      if (!this.generations) return error("generation_unavailable", 503);
      if (!exactKeys(value, ["expectedGeneration"]) || !isTime(value.expectedGeneration)) return error("invalid_generation", 400);
      try { return json(await this.generations.roll(unit, value.expectedGeneration)); } catch { return error("generation_state_refused", 409); }
    }
    if (admin) return this.provision(value, unit);
    const decoded = decodeEncounterRequest(value);
    if (!decoded) return error("invalid_request", 400);
    const now = this.options.now();
    if (!isTime(now)) return error("authority_clock_unavailable", 503);
    if (decoded.unit !== unit || decoded.issuedAt > now || now >= decoded.expiresAt ||
        !await this.backend.verify(decoded.ownerPublicKey, await this.backend.hashString(encounterRequestFrame(decoded)), decoded.signature)) return error("unauthorized", 401);
    const c = decoded.command;
    if (c.op === "release-recovery") {
      if (!this.recovery) return error("recovery_release_unavailable", 503);
      try { return json(await this.recovery.release(unit, decoded.ownerPublicKey, { ticket: c.ticket, termination: c.termination })); }
      catch { return error("recovery_release_refused", 409); }
    }
    if (c.op === "inventory-compact" || c.op === "inventory-page" || c.op === "inventory-retire-empty") {
      if (!this.inventory) return error("inventory_unavailable", 503);
      try {
        if (c.op === "inventory-retire-empty") return json(await this.inventory.retireEmpty(unit, decoded.ownerPublicKey,
          { expectedCheckpointId: c.expectedCheckpointId, ticketIds: c.ticketIds }));
        return json(c.op === "inventory-compact" ? await this.inventory.compact(unit, decoded.ownerPublicKey,
          { expectedCheckpointId: c.expectedCheckpointId, ticketIds: c.ticketIds }) :
          this.inventory.page(unit, decoded.ownerPublicKey, c.checkpointId, c.after));
      } catch { return error("inventory_state_refused", 409); }
    }
    if (c.op === "admissions") {
      const generation = this.generations?.current(unit) ?? 0;
      const rows = this.generations ? this.options.sql.exec(`SELECT a.data FROM encounter_admissions_v2 a
        WHERE a.unit = ? AND a.generation = ? AND json_extract(a.data, '$.ownerPublicKey') = ?
          AND NOT EXISTS (SELECT 1 FROM encounter_tickets_v1 t WHERE json_extract(t.data, '$.ticket.unit') = a.unit
            AND COALESCE(json_extract(t.data, '$.ticket.generation'), 0) = a.generation AND json_extract(t.data, '$.ticket.startHead') = a.start_head)
        ORDER BY a.start_head LIMIT 32`, unit, generation, decoded.ownerPublicKey).toArray() : this.options.sql.exec(`SELECT a.data FROM encounter_admissions_v1 a
        WHERE json_extract(a.data, '$.ownerPublicKey') = ? AND json_extract(a.data, '$.unit') = ?
          AND NOT EXISTS (SELECT 1 FROM encounter_tickets_v1 t
            WHERE json_extract(t.data, '$.ticket.unit') = ? AND json_extract(t.data, '$.ticket.startHead') = a.start_head)
        ORDER BY a.start_head LIMIT 32`, decoded.ownerPublicKey, unit, unit).toArray();
      return json(rows.map((row) => JSON.parse(row.data as string)));
    }
    if (c.op === "start") {
      const generation = c.generation ?? 0;
      const active = this.generations?.current(unit) ?? 0;
      if (generation < active) {
        const old = this.ledger.byStart(await encounterStartKey(unit, c.startHead, this.backend, generation));
        if (!old || !old.retentionReleased || old.ticket.unit !== unit || old.ticket.ownerPublicKey !== decoded.ownerPublicKey ||
            (old.ticket.generation ?? 0) !== generation || !["settled", "forfeited"].includes(old.phase)) return error("start_not_authorized", 403);
        return json(old.ticket);
      }
      if (generation !== active) return error("start_not_authorized", 403);
      const authorization = this.admission(unit, generation, c.startHead);
      if (!authorization || authorization.unit !== unit || authorization.ownerPublicKey !== decoded.ownerPublicKey) return error("start_not_authorized", 403);
      try { return json(await this.authority.issue(authorization)); } catch { return error("encounter_state_refused", 409); }
    }
    const ticketId = c.op === "commit" ? c.commitment.ticketId : c.op === "market" ? c.listing.ticketId : c.ticketId;
    const row = this.ledger.byId(ticketId);
    if (!row || row.ticket.unit !== unit || row.ticket.ownerPublicKey !== decoded.ownerPublicKey) return error("ticket_not_authorized", 403);
    try {
      switch (c.op) {
        case "status": return json(this.authority.status(c.ticketId));
        case "commit": return json(await this.authority.commit(c.commitment));
        case "reveal": return json(await this.authority.reveal(c.ticketId));
        case "settle": return json(await this.authority.settle(c.ticketId, c.chunks.map((x) => ({ ...x, payload: decodePayload(x.payload) }))));
        case "receipt": return json(await this.authority.settle(c.ticketId, []));
        case "market": return json(await this.authority.admitToMarket(c.listing));
        case "prune": return json(await this.authority.pruneGrant(c.ticketId, c.expectedRevision));
        case "terminate": return json(await this.authority.terminate(c.ticketId, c.reason));
        case "closure": return json(await this.authority.closureGrant(c.ticketId, c.expectedRevision, c.nextSequence));
        case "archive-upload": {
          if (!this.options.archive) return error("archive_unavailable", 503);
          if (row.retentionReleased || !row.receipt || !row.reveal || !row.commitment) return error("settled_archive_required", 409);
          const custody = await this.options.archive.store({ ticket: row.ticket, commitment: row.commitment, reveal: row.reveal,
            receipt: row.receipt, chunks: c.chunks.map((x) => ({ ...x, payload: decodePayload(x.payload) })) });
          await this.authority.acceptArchive(c.ticketId, custody); return json(custody);
        }
        case "archive-handoff": return json(await this.authority.archiveHandoff(c.ticketId, c.expectedRevision, c.nextSequence));
        case "archive-read": {
          if (!this.options.archive) return error("archive_unavailable", 503);
          const object = this.options.archive.read(c.ticketId);
          return object ? json({ ...object, bundle: object.bundle ? { ...object.bundle, chunks: object.bundle.chunks.map((x) => ({ ...x, payload: encodePayload(x.payload) })) } : null }) : error("archive_not_found", 404);
        }
        case "archive-release": {
          if (!this.options.archive) return error("archive_unavailable", 503);
          return json(await this.options.archive.release(await this.authority.archiveRelease(c.ticketId)));
        }
      }
    } catch { return error("encounter_state_refused", 409); }
  }
  private provision(value: unknown, unit: string): Response {
    if (!(exactKeys(value, ["unit", "startHead", "playerId", "ownerPublicKey"]) || exactKeys(value, ["unit", "startHead", "playerId", "ownerPublicKey", "generation"]) && isTime(value.generation)) || value.unit !== unit ||
        !identifier(value.startHead) || !identifier(value.playerId) || !isDigest(value.ownerPublicKey)) return error("invalid_admission", 400);
    const generation = (value.generation as number | undefined) ?? 0;
    if (generation !== (this.generations?.current(unit) ?? 0)) return error("admission_generation_refused", 409);
    const authorization: EncounterAuthorization = { unit, startHead: value.startHead, playerId: value.playerId, ownerPublicKey: value.ownerPublicKey, ...(generation > 0 ? { generation } : {}) };
    const existing = this.admission(unit, generation, authorization.startHead);
    if (existing) return JSON.stringify(existing) === JSON.stringify(authorization) ? json({ accepted: true }) : error("admission_conflict", 409);
    const count = (this.generations ? this.options.sql.exec("SELECT COUNT(*) AS count FROM encounter_admissions_v2 WHERE unit = ? AND generation = ?", unit, generation) : this.options.sql.exec("SELECT COUNT(*) AS count FROM encounter_admissions_v1")).toArray()[0].count as number;
    if (count >= (this.options.maxAdmissions ?? 1_024)) return error("admission_capacity_exhausted", 429);
    if (this.generations) this.options.sql.exec("INSERT INTO encounter_admissions_v2 VALUES (?, ?, ?, ?)", unit, generation, authorization.startHead, JSON.stringify(authorization));
    else this.options.sql.exec("INSERT INTO encounter_admissions_v1 (start_head, data) VALUES (?, ?)", authorization.startHead, JSON.stringify(authorization));
    return json({ accepted: true }, 201);
  }
}
