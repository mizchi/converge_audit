import { createStandardWebCryptoBackend, type AsyncAuditSigner } from "../../../player-local-runtime/crypto-backend.ts";
import type { EncounterSql } from "./ledger.ts";
import { archiveCustodyFrame, archiveReleaseFrame, encodeArchiveBundle, decodeArchiveBundle, type EncounterArchive, type EncounterArchiveBundle, type ArchiveCustody, type ArchiveCustodyStatement, type ArchiveRelease } from "./archive.ts";
import { commitFrame, decodeEncounterLog, isDigest, isTime, verifyEncounterReceipt, verifyEncounterReveal, verifyEncounterTicket } from "./wire.ts";

export interface EncounterArchiveOptions {
  sql: EncounterSql;
  transaction<T>(body: () => T): T;
  signer: AsyncAuditSigner;
  trustedAuthorityKey: string;
  crypto: Crypto;
  now(): number;
  maxBytes?: number;
  maxObjects?: number;
  injectWriteFault?(): void;
}
/** Stores all replay evidence atomically BEFORE acknowledging custody. Payload
may be deleted only by a scoped authority release, never by elapsed time alone.
Released tombstones keep retry identity within their generation. Slots are only
reclaimed with a durable generation fence in the authority's shared transaction. */
export class SqliteEncounterArchive implements EncounterArchive {
  readonly publicKey: string;
  private readonly o: EncounterArchiveOptions;
  private readonly backend;
  constructor(options: EncounterArchiveOptions) {
    const maxBytes = options.maxBytes ?? 1_048_576; const maxObjects = options.maxObjects ?? 128;
    if (!isDigest(options.signer.publicKey) || !isDigest(options.trustedAuthorityKey) || !isTime(maxBytes) || maxBytes < 1 || maxBytes > 1_048_576 ||
        !isTime(maxObjects) || maxObjects < 1 || maxObjects > 1_024) throw new Error("invalid archive limits");
    this.o = { ...options, maxBytes, maxObjects }; this.publicKey = options.signer.publicKey;
    this.backend = createStandardWebCryptoBackend(options.crypto);
    options.sql.exec(`CREATE TABLE IF NOT EXISTS encounter_archive_objects_v1 (
      ticket_id TEXT PRIMARY KEY, custody TEXT NOT NULL, bundle TEXT, stored_bytes INTEGER NOT NULL, release TEXT
    )`);
    options.sql.exec(`CREATE TABLE IF NOT EXISTS encounter_archive_budget_v1 (
      id INTEGER PRIMARY KEY CHECK(id = 1), used_bytes INTEGER NOT NULL, total_objects INTEGER NOT NULL
    )`);
    if (!options.sql.exec("PRAGMA table_info(encounter_archive_objects_v1)").toArray().some((c) => c.name === "generation"))
      options.sql.exec("ALTER TABLE encounter_archive_objects_v1 ADD COLUMN generation INTEGER NOT NULL DEFAULT 0");
    options.sql.exec(`CREATE TABLE IF NOT EXISTS encounter_archive_generations_v1 (unit TEXT PRIMARY KEY, minimum_generation INTEGER NOT NULL)`);
    options.sql.exec(`CREATE INDEX IF NOT EXISTS encounter_archive_generation_v1 ON encounter_archive_objects_v1
      (json_extract(custody, '$.statement.unit'), generation)`);
    options.transaction(() => {
      const actual = options.sql.exec("SELECT COUNT(*) AS n, COALESCE(SUM(stored_bytes), 0) AS used FROM encounter_archive_objects_v1").toArray()[0];
      const stored = options.sql.exec("SELECT used_bytes, total_objects FROM encounter_archive_budget_v1 WHERE id = 1").toArray()[0];
      if (!stored) {
        if (actual.n !== 0 || actual.used !== 0) throw new Error("missing archive accounting for retained evidence");
        options.sql.exec("INSERT INTO encounter_archive_budget_v1 VALUES (1, 0, 0)");
      } else if (stored.used_bytes !== actual.used || stored.total_objects !== actual.n) throw new Error("inconsistent archive accounting");
      const budget = this.snapshot();
      if (budget.usedBytes > maxBytes || budget.totalObjects > maxObjects) throw new Error("archive accounting exceeds configured capacity");
    });
  }
  minimumGeneration(unit: string): number {
    const row = this.o.sql.exec("SELECT minimum_generation FROM encounter_archive_generations_v1 WHERE unit = ?", unit).toArray()[0];
    if (row && !isTime(row.minimum_generation)) throw new Error("invalid archive generation");
    return row?.minimum_generation as number ?? 0;
  }
  sharesGenerationStorage(storage: unknown): boolean { return storage === this.o.sql; }
  canRetireGeneration(unit: string, generation: number): boolean {
    return isTime(generation) && generation < Number.MAX_SAFE_INTEGER && this.minimumGeneration(unit) === generation &&
      this.o.sql.exec(`SELECT ticket_id FROM encounter_archive_objects_v1 WHERE json_extract(custody, '$.statement.unit') = ?
        AND generation <= ? AND bundle IS NOT NULL LIMIT 1`, unit, generation).toArray().length === 0;
  }
  retireGenerationInTransaction(unit: string, generation: number): void {
    if (!this.canRetireGeneration(unit, generation)) throw new Error("archive generation still retained");
    const count = this.o.sql.exec(`SELECT COUNT(*) AS n FROM encounter_archive_objects_v1
      WHERE json_extract(custody, '$.statement.unit') = ? AND generation <= ?`, unit, generation).toArray()[0].n as number;
    const budget = this.snapshot();
    if (count > budget.totalObjects) throw new Error("invalid archive accounting");
    this.o.sql.exec(`DELETE FROM encounter_archive_objects_v1 WHERE json_extract(custody, '$.statement.unit') = ? AND generation <= ?`, unit, generation);
    this.o.sql.exec("UPDATE encounter_archive_budget_v1 SET total_objects = ? WHERE id = 1", budget.totalObjects - count);
    this.o.sql.exec(`INSERT INTO encounter_archive_generations_v1 VALUES (?, ?) ON CONFLICT(unit) DO UPDATE SET minimum_generation = excluded.minimum_generation`, unit, generation + 1);
  }
  snapshot() {
    const row = this.o.sql.exec("SELECT used_bytes, total_objects FROM encounter_archive_budget_v1 WHERE id = 1").toArray()[0];
    if (!row || !isTime(row.used_bytes) || !isTime(row.total_objects)) throw new Error("invalid archive accounting");
    return { usedBytes: row.used_bytes, totalObjects: row.total_objects };
  }
  read(ticketId: string): ReturnType<EncounterArchive["read"]> {
    const row = this.o.sql.exec("SELECT custody, bundle, release FROM encounter_archive_objects_v1 WHERE ticket_id = ?", ticketId).toArray()[0];
    if (!row) return undefined;
    const custody = JSON.parse(row.custody as string) as ArchiveCustody;
    if (custody.statement.archiveKey !== this.publicKey || custody.statement.authorityKey !== this.o.trustedAuthorityKey) throw new Error("archive key changed");
    return { custody, bundle: row.bundle === null ? null : decodeArchiveBundle(row.bundle as string), release: row.release ? JSON.parse(row.release as string) : undefined };
  }
  async store(input: EncounterArchiveBundle): Promise<ArchiveCustody> {
    const text = encodeArchiveBundle(input); const bundle = decodeArchiveBundle(text);
    const { ticket, commitment, receipt, reveal, chunks } = bundle;
    const generation = ticket.generation ?? 0;
    if (!isTime(generation) || generation < this.minimumGeneration(ticket.unit)) throw new Error("archive generation retired");
    const bundleDigest = await this.backend.hashString(text);
    const existing = this.read(ticket.ticketId);
    if (existing) return this.retry(existing, bundleDigest);
    if (!await verifyEncounterTicket(ticket, this.o.trustedAuthorityKey, this.backend) ||
        !await verifyEncounterReceipt(receipt, this.o.trustedAuthorityKey, this.backend) ||
        !await verifyEncounterReveal(ticket, commitment, reveal, this.backend) ||
        !await this.backend.verify(ticket.ownerPublicKey, await this.backend.hashString(commitFrame(commitment)), commitment.ownerSignature) ||
        commitment.ticketId !== ticket.ticketId || receipt.statement.ticketId !== ticket.ticketId || receipt.statement.root !== commitment.root ||
        receipt.statement.unit !== ticket.unit || receipt.statement.ownerPublicKey !== ticket.ownerPublicKey || receipt.statement.playerId !== ticket.playerId) throw new Error("invalid archive evidence");
    await decodeEncounterLog(ticket, commitment, chunks, this.backend);
    const storedAt = this.o.now(); if (!isTime(storedAt) || storedAt < receipt.statement.settledAt) throw new Error("invalid archive clock");
    const statement: ArchiveCustodyStatement = { version: 1, archiveKey: this.publicKey, authorityKey: ticket.authorityKey,
      ticketId: ticket.ticketId, unit: ticket.unit, queueId: ticket.queueId, root: commitment.root, receiptId: receipt.receiptId,
      chunkDigests: [...commitment.chunkDigests], bundleDigest, storedBytes: new TextEncoder().encode(text).byteLength, storedAt,
      minRetainUntil: receipt.statement.retentionUntil, policy: "authority-release-v1" };
    const custodyId = await this.backend.hashString(archiveCustodyFrame(statement));
    const custody = { statement, custodyId, signature: await this.o.signer.signDigest(custodyId) };
    return this.o.transaction(() => {
      if (generation < this.minimumGeneration(ticket.unit)) throw new Error("archive generation retired");
      const old = this.read(ticket.ticketId);
      if (old) return this.retry(old, bundleDigest);
      const budget = this.snapshot();
      if (budget.usedBytes + statement.storedBytes > this.o.maxBytes! || budget.totalObjects >= this.o.maxObjects!) throw new Error("archive capacity exhausted");
      this.o.sql.exec("INSERT INTO encounter_archive_objects_v1 (ticket_id, custody, bundle, stored_bytes, release, generation) VALUES (?, ?, ?, ?, NULL, ?)", ticket.ticketId, JSON.stringify(custody), text, statement.storedBytes, generation);
      this.o.sql.exec("UPDATE encounter_archive_budget_v1 SET used_bytes = ?, total_objects = ? WHERE id = 1", budget.usedBytes + statement.storedBytes, budget.totalObjects + 1);
      this.o.injectWriteFault?.(); return custody;
    });
  }
  private retry(old: NonNullable<ReturnType<EncounterArchive["read"]>>, bundleDigest: string): ArchiveCustody {
    if (!old.bundle) throw new Error("archive already released");
    if (old.custody.statement.bundleDigest !== bundleDigest) throw new Error("archive evidence cannot change");
    return old.custody;
  }
  async release(input: ArchiveRelease): Promise<ArchiveRelease> {
    const certificate = structuredClone(input); const s = certificate.statement;
    if (s.version !== 1 || s.authorityKey !== this.o.trustedAuthorityKey || !isTime(s.closedAt) ||
        certificate.releaseId !== await this.backend.hashString(archiveReleaseFrame(s)) ||
        !await this.backend.verify(this.o.trustedAuthorityKey, certificate.releaseId, certificate.signature)) throw new Error("invalid archive release");
    return this.o.transaction(() => {
      const old = this.read(s.ticketId); const c = old?.custody;
      if (!old || !c || c.custodyId !== s.custodyId || c.statement.queueId !== s.queueId || c.statement.root !== s.root ||
          s.closedAt < c.statement.minRetainUntil) throw new Error("archive release binding or deadline mismatch");
      if (old.release) return old.release;
      const budget = this.snapshot();
      if (!old.bundle || budget.usedBytes < c.statement.storedBytes) throw new Error("invalid archive accounting");
      this.o.sql.exec("UPDATE encounter_archive_objects_v1 SET bundle = NULL, stored_bytes = 0, release = ? WHERE ticket_id = ?", JSON.stringify(certificate), s.ticketId);
      this.o.sql.exec("UPDATE encounter_archive_budget_v1 SET used_bytes = ? WHERE id = 1", budget.usedBytes - c.statement.storedBytes);
      this.o.injectWriteFault?.(); return certificate;
    });
  }
}
