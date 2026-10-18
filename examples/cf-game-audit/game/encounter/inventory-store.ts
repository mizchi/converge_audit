import type { AsyncAuditSigner, AuditCryptoBackend } from "../../../player-local-runtime/crypto-backend.ts";
import type { EncounterLedger, EncounterLedgerRow } from "./contracts.ts";
import { ENCOUNTER_RULES } from "./contracts.ts";
import type { EncounterSql } from "./ledger.ts";
import { isTime } from "./wire.ts";
import { INVENTORY_PAGE_SIZE, MAX_INVENTORY_RECEIPTS, inventoryBatchDigest, inventoryCheckpointFrame, inventoryNextRoot, inventoryRetirementDigest, inventoryRetiredCount,
  validInventoryCompaction, validInventoryCheckpoint, type InventoryCheckpoint, type InventoryCheckpointStatement, type InventoryCompaction, type InventoryPage, type InventoryReceiptRecord } from "./inventory-checkpoint.ts";
import { SqliteInventoryEmptyRanges } from "./inventory-ranges.ts";

interface Options {
  sql: EncounterSql;
  ledger: EncounterLedger;
  signer: AsyncAuditSigner;
  backend: AuditCryptoBackend;
  transaction<T>(body: () => T): T;
  now(): number;
  injectWriteFault?(): void;
  currentGeneration?(unit: string): number;
  held?(ticketId: string): boolean;
}
/** A bounded incremental index over the authority's existing settled receipts.
 * The root commits batches; catalog authenticity uses original signed receipts,
 * not a claimed Merkle inclusion proof. No game ticks are run here. */
export class SqliteEncounterInventory {
  private readonly o: Options;
  private readonly ranges: SqliteInventoryEmptyRanges;
  constructor(options: Options) {
    this.o = { ...options };
    this.ranges = new SqliteInventoryEmptyRanges(options.sql);
    options.sql.exec(`CREATE TABLE IF NOT EXISTS encounter_inventory_heads_v1 (
      unit TEXT NOT NULL, owner TEXT NOT NULL, checkpoint TEXT NOT NULL, PRIMARY KEY (unit, owner))`);
    options.sql.exec(`CREATE TABLE IF NOT EXISTS encounter_inventory_members_v1 (
      unit TEXT NOT NULL, owner TEXT NOT NULL, ordinal INTEGER NOT NULL, ticket_id TEXT NOT NULL UNIQUE,
      receipt_id TEXT NOT NULL, PRIMARY KEY (unit, owner, ordinal))`);
  }
  head(unit: string, owner: string): InventoryCheckpoint | null {
    const row = this.o.sql.exec("SELECT checkpoint FROM encounter_inventory_heads_v1 WHERE unit = ? AND owner = ?", unit, owner).toArray()[0];
    if (!row) return null;
    const checkpoint: unknown = JSON.parse(row.checkpoint as string);
    if (!validInventoryCheckpoint(checkpoint) || checkpoint.statement.authorityKey !== this.o.signer.publicKey ||
        checkpoint.statement.unit !== unit || checkpoint.statement.ownerPublicKey !== owner) throw new Error("inventory head scope changed");
    return checkpoint;
  }
  private record(unit: string, owner: string, id: string): InventoryReceiptRecord {
    const row = this.o.ledger.byId(id);
    if (!row || row.phase !== "settled" || !row.receipt || row.ticket.unit !== unit || row.ticket.ownerPublicKey !== owner ||
        row.ticket.authorityKey !== this.o.signer.publicKey || row.receipt.statement.authorityKey !== this.o.signer.publicKey ||
        row.ticket.rulesId !== ENCOUNTER_RULES || row.receipt.statement.rulesId !== ENCOUNTER_RULES ||
        row.receipt.statement.unit !== unit || row.receipt.statement.ownerPublicKey !== owner || row.receipt.statement.ticketId !== id ||
        row.receipt.statement.items.length > 1) throw new Error("inventory receipt unavailable");
    const record = { ticket: row.ticket, receipt: row.receipt, admittedAssets: row.admittedAssets };
    if (new TextEncoder().encode(JSON.stringify(record)).byteLength > 4_096) throw new Error("inventory record exceeds bound");
    return record;
  }
  async compact(unit: string, owner: string, input: InventoryCompaction): Promise<InventoryCheckpoint> {
    if (!validInventoryCompaction(input)) throw new Error("invalid inventory batch");
    // Snapshot caller-owned inputs before the first asynchronous hash/sign.
    const command = structuredClone(input);
    const records = command.ticketIds.map((id) => this.record(unit, owner, id));
    const batchDigest = await inventoryBatchDigest(records, this.o.backend);
    const old = this.head(unit, owner);
    if (old && (old.statement.version === 1 || old.statement.operation === "append") && old.statement.previousId === command.expectedCheckpointId && old.statement.batchDigest === batchDigest) return old;
    if ((old?.checkpointId ?? null) !== command.expectedCheckpointId) throw new Error("inventory head changed");
    for (const id of command.ticketIds) if (this.o.sql.exec("SELECT ticket_id FROM encounter_inventory_members_v1 WHERE ticket_id = ?", id).toArray().length) throw new Error("receipt already compacted");
    const statement: InventoryCheckpointStatement = { ...(old?.statement.version === 2 ? { version: 2 as const, operation: "append" as const, retiredEmptyCount: old.statement.retiredEmptyCount } : { version: 1 as const }), authorityKey: this.o.signer.publicKey, unit, ownerPublicKey: owner,
      rulesId: ENCOUNTER_RULES, revision: (old?.statement.revision ?? 0) + 1, previousId: command.expectedCheckpointId,
      batchDigest, root: await inventoryNextRoot(old, batchDigest, this.o.backend),
      receiptCount: (old?.statement.receiptCount ?? 0) + records.length,
      itemCount: (old?.statement.itemCount ?? 0) + records.reduce((n, r) => n + r.receipt.statement.items.length, 0), createdAt: this.o.now() };
    if (!isTime(statement.createdAt) || !isTime(statement.revision) || statement.receiptCount > MAX_INVENTORY_RECEIPTS) throw new Error("inventory capacity exhausted");
    const checkpointId = await this.o.backend.hashString(inventoryCheckpointFrame(statement));
    const checkpoint = { statement, checkpointId, signature: await this.o.signer.signDigest(checkpointId) };
    return this.o.transaction(() => {
      const current = this.head(unit, owner);
      if (current && (current.statement.version === 1 || current.statement.operation === "append") && current.statement.previousId === command.expectedCheckpointId && current.statement.batchDigest === batchDigest) return current;
      if ((current?.checkpointId ?? null) !== command.expectedCheckpointId) throw new Error("inventory head changed");
      for (let i = 0; i < records.length; i++) this.o.sql.exec(`INSERT INTO encounter_inventory_members_v1
        (unit, owner, ordinal, ticket_id, receipt_id) VALUES (?, ?, ?, ?, ?)`, unit, owner, (old?.statement.receiptCount ?? 0) + i + 1, records[i].ticket.ticketId, records[i].receipt.receiptId);
      this.o.sql.exec(`INSERT INTO encounter_inventory_heads_v1 (unit, owner, checkpoint) VALUES (?, ?, ?)
        ON CONFLICT(unit, owner) DO UPDATE SET checkpoint = excluded.checkpoint`, unit, owner, JSON.stringify(checkpoint));
      this.o.injectWriteFault?.(); return checkpoint;
    });
  }
  page(unit: string, owner: string, checkpointId: string, after: number): InventoryPage {
    const head = this.head(unit, owner);
    if (!head || head.checkpointId !== checkpointId || !isTime(after) || after >= head.statement.receiptCount) throw new Error("inventory snapshot unavailable");
    if (head.statement.version === 2) return this.sparsePage(unit, owner, head, after);
    const rows = this.o.sql.exec(`SELECT ordinal, ticket_id, receipt_id FROM encounter_inventory_members_v1
      WHERE unit = ? AND owner = ? AND ordinal > ? AND ordinal <= ? ORDER BY ordinal LIMIT ?`,
    unit, owner, after, head.statement.receiptCount, INVENTORY_PAGE_SIZE).toArray();
    const records = rows.map((row, i) => {
      if (row.ordinal !== after + i + 1) throw new Error("inventory index gap");
      const record = this.record(unit, owner, row.ticket_id as string);
      if (record.receipt.receiptId !== row.receipt_id) throw new Error("inventory receipt changed");
      return record;
    });
    if (records.length !== Math.min(INVENTORY_PAGE_SIZE, head.statement.receiptCount - after)) throw new Error("inventory index gap");
    const end = after + records.length;
    return { checkpointId, after, next: end < head.statement.receiptCount ? end : null, records };
  }
  private sparsePage(unit: string, owner: string, head: InventoryCheckpoint, after: number): InventoryPage {
    const records: InventoryReceiptRecord[] = []; const positions: number[] = []; const emptyRanges: { first: number; last: number }[] = [];
    let cursor = after;
    for (let step = 0; step < INVENTORY_PAGE_SIZE && cursor < head.statement.receiptCount; step++) {
      const ordinal = cursor + 1;
      const row = this.o.sql.exec("SELECT ticket_id, receipt_id FROM encounter_inventory_members_v1 WHERE unit = ? AND owner = ? AND ordinal = ?", unit, owner, ordinal).toArray()[0];
      if (row) {
        const record = this.record(unit, owner, row.ticket_id as string);
        if (record.receipt.receiptId !== row.receipt_id) throw new Error("inventory receipt changed");
        records.push(record); positions.push(ordinal); cursor = ordinal;
      } else {
        const range = this.ranges.predecessor(unit, owner, ordinal);
        if (!range || range.last < ordinal || range.last > head.statement.receiptCount) throw new Error("inventory index gap");
        emptyRanges.push({ first: ordinal, last: range.last }); cursor = range.last;
      }
    }
    return { checkpointId: head.checkpointId, after, next: cursor < head.statement.receiptCount ? cursor : null, records, positions, emptyRanges };
  }
  async retireEmpty(unit: string, owner: string, input: InventoryCompaction): Promise<InventoryCheckpoint> {
    if (!validInventoryCompaction(input) || input.expectedCheckpointId === null || !this.o.currentGeneration || !this.o.held) throw new Error("invalid empty retirement");
    const command = structuredClone(input); const batchDigest = await inventoryRetirementDigest(command.ticketIds, this.o.backend);
    const isRetry = (cp: InventoryCheckpoint | null) => cp?.statement.version === 2 && cp.statement.operation === "retire-empty" &&
      cp.statement.previousId === command.expectedCheckpointId && cp.statement.batchDigest === batchDigest;
    const old = this.head(unit, owner);
    // Check the bounded latest operation before reading sources: an exact retry
    // remains possible after the original empty receipts have been deleted.
    if (isRetry(old)) return old!;
    if (!old || old.checkpointId !== command.expectedCheckpointId) throw new Error("inventory head changed");
    const guard = (await import("../../../../_build/js/release/build/x/game_audit/worker/worker.js")).audit_encounter_empty_receipt_retire_allowed;
    const sources = () => command.ticketIds.map((id) => {
      const record = this.record(unit, owner, id); const row = this.o.ledger.byId(id)!;
      const member = this.o.sql.exec("SELECT ordinal, receipt_id FROM encounter_inventory_members_v1 WHERE unit = ? AND owner = ? AND ticket_id = ?", unit, owner, id).toArray()[0];
      const now = this.o.now();
      if (!guard(row.phase === "settled", record.receipt.statement.items.length === 0 && row.admittedAssets.length === 0 && !row.archiveCustody,
        row.retentionReleased && isTime(now) && now >= record.receipt.statement.retentionUntil, !row.evidenceHold && !this.o.held!(id),
        (row.ticket.generation ?? 0) < this.o.currentGeneration!(unit), !!member && member.receipt_id === record.receipt.receiptId && isTime(member.ordinal) && member.ordinal > 0 && member.ordinal <= old.statement.receiptCount)) throw new Error("empty retirement refused");
      return { row, ordinal: member.ordinal as number };
    });
    const initial = sources();
    const statement: InventoryCheckpointStatement = { ...old.statement, version: 2, operation: "retire-empty", retiredEmptyCount: inventoryRetiredCount(old) + command.ticketIds.length,
      revision: old.statement.revision + 1, previousId: old.checkpointId, batchDigest, root: await inventoryNextRoot(old, batchDigest, this.o.backend, "retire-empty"), createdAt: this.o.now() };
    if (!validInventoryCheckpoint({ statement, checkpointId: "0".repeat(64), signature: "0".repeat(128) })) throw new Error("invalid retirement checkpoint");
    const checkpointId = await this.o.backend.hashString(inventoryCheckpointFrame(statement));
    const cp = { statement, checkpointId, signature: await this.o.signer.signDigest(checkpointId) };
    return this.o.transaction(() => {
      const current = this.head(unit, owner);
      if (isRetry(current)) return current!;
      if (current?.checkpointId !== command.expectedCheckpointId) throw new Error("inventory head changed");
      const fresh = sources();
      const identity = (rows: { row: EncounterLedgerRow; ordinal: number }[]) => rows.map(({ row, ordinal }) => [row.ticket.ticketId, row.receipt!.receiptId, row.revision, ordinal]);
      if (JSON.stringify(identity(fresh)) !== JSON.stringify(identity(initial))) throw new Error("empty retirement source changed");
      for (const { row, ordinal } of fresh) {
        this.ranges.add(unit, owner, ordinal);
        if (this.o.sql.exec("DELETE FROM encounter_origins_v1 WHERE id = ? AND revision = ? RETURNING id", row.ticket.ticketId, row.revision).toArray().length !== 1) throw new Error("empty retirement origin changed");
        this.o.sql.exec("DELETE FROM encounter_inventory_members_v1 WHERE unit = ? AND owner = ? AND ordinal = ?", unit, owner, ordinal);
      }
      this.o.sql.exec("UPDATE encounter_inventory_heads_v1 SET checkpoint = ? WHERE unit = ? AND owner = ?", JSON.stringify(cp), unit, owner);
      this.o.injectWriteFault?.(); return cp;
    });
  }
}
