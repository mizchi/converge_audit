import type { AsyncAuditSigner, AuditCryptoBackend } from "../../../player-local-runtime/crypto-backend.ts";
import type { EncounterArchive } from "./archive.ts";
import type { EncounterLedgerRow } from "./contracts.ts";
import type { EncounterSql } from "./ledger.ts";
import { frame, isTime } from "./wire.ts";
import { generationSealFrame, type EncounterGenerationSeal } from "./generation.ts";
interface Options {
  sql: EncounterSql;
  signer: AsyncAuditSigner;
  backend: AuditCryptoBackend;
  archive?: EncounterArchive;
  transaction<T>(body: () => T): T;
  held(ticketId: string): boolean;
  now(): number;
}
/** One bounded hot epoch, durable original provenance, and a monotone low-water
 * mark. The host supplies one transaction across ledger, admissions and archive. */
export class SqliteEncounterGenerations {
  private readonly o: Options;
  constructor(options: Options) {
    this.o = { ...options };
    options.sql.exec(`CREATE TABLE IF NOT EXISTS encounter_generations_v1 (
      unit TEXT PRIMARY KEY, generation INTEGER NOT NULL, seal TEXT)`);
    // This fence survives deletion of every assetless origin. Upgrade existing
    // generation metadata once; a later missing head must not mean generation 0.
    options.sql.exec(`CREATE TABLE IF NOT EXISTS encounter_generation_floors_v1 (
      unit TEXT PRIMARY KEY, minimum_generation INTEGER NOT NULL)`);
    options.sql.exec(`INSERT OR IGNORE INTO encounter_generation_floors_v1
      SELECT unit, generation FROM encounter_generations_v1`);
    options.sql.exec(`CREATE TABLE IF NOT EXISTS encounter_admissions_v2 (
      unit TEXT NOT NULL, generation INTEGER NOT NULL, start_head TEXT NOT NULL, data TEXT NOT NULL,
      PRIMARY KEY (unit, generation, start_head))`);
    options.sql.exec(`CREATE INDEX IF NOT EXISTS encounter_admission_owner_v2 ON encounter_admissions_v2
      (unit, generation, json_extract(data, '$.ownerPublicKey'), start_head)`);
  }
  current(unit: string): number {
    const row = this.o.sql.exec("SELECT generation, seal FROM encounter_generations_v1 WHERE unit = ?", unit).toArray()[0];
    const floor = this.o.sql.exec("SELECT minimum_generation FROM encounter_generation_floors_v1 WHERE unit = ?", unit).toArray()[0]?.minimum_generation ?? 0;
    if (!isTime(floor)) throw new Error("invalid generation fence");
    if (!row) {
      if (floor > 0 || (this.o.archive?.minimumGeneration?.(unit) ?? 0) > 0 || this.o.sql.exec("SELECT id FROM encounter_origins_v1 WHERE json_extract(data, '$.ticket.unit') = ? LIMIT 1", unit).toArray().length)
        throw new Error("missing generation fence for retained origins");
      return 0;
    }
    if (!isTime(row.generation)) throw new Error("invalid generation fence");
    if (row.generation !== floor) throw new Error("generation fence changed");
    if (this.o.archive?.minimumGeneration && this.o.archive.minimumGeneration(unit) !== row.generation) throw new Error("archive generation fence changed");
    if (row.seal) {
      const seal = JSON.parse(row.seal as string) as EncounterGenerationSeal;
      if (seal.statement.nextGeneration !== row.generation || seal.statement.unit !== unit || seal.statement.authorityKey !== this.o.signer.publicKey) throw new Error("generation seal scope changed");
    } else if (row.generation !== 0) throw new Error("missing generation seal");
    return row.generation;
  }
  private seal(unit: string): EncounterGenerationSeal | null {
    const row = this.o.sql.exec("SELECT seal FROM encounter_generations_v1 WHERE unit = ?", unit).toArray()[0];
    return row?.seal ? JSON.parse(row.seal as string) : null;
  }
  private rows(unit: string): EncounterLedgerRow[] {
    const rows = this.o.sql.exec("SELECT data, revision FROM encounter_tickets_v1 WHERE json_extract(data, '$.ticket.unit') = ? ORDER BY id LIMIT 1025", unit).toArray();
    if (rows.length > 1_024) throw new Error("generation hot ledger exceeds bound");
    return rows.map((row) => { const parsed = JSON.parse(row.data as string) as EncounterLedgerRow;
      if (parsed.revision !== row.revision) throw new Error("ledger revision changed"); return parsed; });
  }
  private closed(unit: string, generation: number, rows: EncounterLedgerRow[]): boolean {
    const authorized = this.o.sql.exec("SELECT COUNT(*) AS n FROM encounter_admissions_v2 WHERE unit = ? AND generation = ?", unit, generation).toArray()[0].n;
    return authorized === rows.length && rows.every((r) => r.ticket.unit === unit && (r.ticket.generation ?? 0) === generation &&
      r.ticket.authorityKey === this.o.signer.publicKey && r.retentionReleased && !r.evidenceHold && !this.o.held(r.ticket.ticketId) &&
      ((r.phase === "settled" && !!r.receipt) || (r.phase === "forfeited" && !!r.termination)));
  }
  private archivesClosed(unit: string, generation: number, rows: EncounterLedgerRow[]): boolean {
    return !this.o.archive ? rows.every((r) => !r.archiveCustody) :
      this.o.archive.sharesGenerationStorage?.(this.o.sql) === true && !!this.o.archive.retireGenerationInTransaction && this.o.archive.canRetireGeneration?.(unit, generation) === true;
  }
  async roll(unit: string, expected: number): Promise<EncounterGenerationSeal> {
    if (!isTime(expected) || expected === Number.MAX_SAFE_INTEGER) throw new Error("invalid expected generation");
    // Lazy initialization is required by the generated worker's random module.
    const { audit_encounter_generation_roll_allowed: guard, audit_encounter_recovery_forget_allowed: forgetAllowed } =
      await import("../../../../_build/js/release/build/x/game_audit/worker/worker.js");
    const current = this.current(unit); const previous = this.seal(unit);
    if (current === expected + 1 && previous?.statement.generation === expected) return previous;
    const rows = this.rows(unit);
    if (!guard(current === expected, current < Number.MAX_SAFE_INTEGER, this.closed(unit, expected, rows), this.archivesClosed(unit, expected, rows))) throw new Error("generation still retained");
    const statement: EncounterGenerationSeal["statement"] = { version: 1, authorityKey: this.o.signer.publicKey, unit,
      generation: expected, nextGeneration: expected + 1, previousSealId: previous?.sealId ?? null,
      originsDigest: await this.o.backend.hashString(frame("encounter-generation-origins-v1", rows.map((r) =>
        [r.ticket.ticketId, r.startKey, r.ticket.ticketSignature, r.receipt?.receiptId ?? null, r.termination?.terminationId ?? null]))),
      ticketCount: rows.length, receiptCount: rows.filter((r) => !!r.receipt).length, closedAt: this.o.now() };
    if (!isTime(statement.closedAt)) throw new Error("generation clock unavailable");
    const sealId = await this.o.backend.hashString(generationSealFrame(statement));
    const seal = { statement, sealId, signature: await this.o.signer.signDigest(sealId) };
    return this.o.transaction(() => {
      const active = this.current(unit); const last = this.seal(unit);
      if (active === expected + 1 && last?.statement.generation === expected) return last;
      const fresh = this.rows(unit);
      if (!guard(active === expected, active < Number.MAX_SAFE_INTEGER, this.closed(unit, expected, fresh), this.archivesClosed(unit, expected, fresh)) ||
          JSON.stringify(fresh.map((r) => [r.ticket.ticketId, r.revision])) !== JSON.stringify(rows.map((r) => [r.ticket.ticketId, r.revision]))) throw new Error("generation changed during seal");
      this.o.archive?.retireGenerationInTransaction?.(unit, expected);
      for (const row of fresh) {
        // Keep the signed origin, root and closed-state recovery capabilities.
        // The hidden RNG output and replay reveal are no longer retained here.
        const noAssets = !row.receipt && !row.archiveCustody && row.admittedAssets.length === 0 &&
          (!row.recoveryReleased || this.o.sql.exec("SELECT ticket_id FROM encounter_inventory_members_v1 WHERE ticket_id = ?", row.ticket.ticketId).toArray().length === 0);
        // The generation advance below is in this same transaction. It replaces
        // the spent-start tombstone for an explicitly relinquished forfeit.
        if (!forgetAllowed(row.phase === "forfeited", row.retentionReleased, !row.evidenceHold && !this.o.held(row.ticket.ticketId), noAssets, row.recoveryReleased === true, true)) {
          const origin = { ...row, secret: "", reveal: undefined, archiveCustody: undefined };
          this.o.sql.exec("INSERT INTO encounter_origins_v1 (id, start_key, revision, data) VALUES (?, ?, ?, ?)", row.ticket.ticketId, row.startKey, row.revision, JSON.stringify(origin));
        }
        this.o.sql.exec("DELETE FROM encounter_tickets_v1 WHERE id = ? AND revision = ?", row.ticket.ticketId, row.revision);
      }
      this.o.sql.exec("DELETE FROM encounter_admissions_v2 WHERE unit = ? AND generation = ?", unit, expected);
      this.o.sql.exec("DELETE FROM encounter_admissions_v1 WHERE json_extract(data, '$.unit') = ?", unit);
      this.o.sql.exec(`INSERT INTO encounter_generation_floors_v1 VALUES (?, ?) ON CONFLICT(unit) DO UPDATE SET minimum_generation = excluded.minimum_generation`, unit, expected + 1);
      this.o.sql.exec(`INSERT INTO encounter_generations_v1 VALUES (?, ?, ?) ON CONFLICT(unit) DO UPDATE SET generation = excluded.generation, seal = excluded.seal`, unit, expected + 1, JSON.stringify(seal));
      return seal;
    });
  }
}
