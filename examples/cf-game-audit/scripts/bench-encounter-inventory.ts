import { DatabaseSync } from "node:sqlite";
import { createStandardWebCryptoBackend } from "../../player-local-runtime/crypto-backend.ts";
import { EncounterAuthority, SqliteEncounterLedger, createEncounterChunks, signEncounterCommit, signEncounterListing,
  verifyEncounterReceipt, verifyEncounterTicket } from "../game/encounter/index.ts";
import { SqliteEncounterInventory } from "../game/encounter/inventory-store.ts";
import { verifyInventoryCheckpoint, type InventoryReceiptRecord } from "../game/encounter/inventory-checkpoint.ts";

// Service CPU with real Ed25519 and SQLite, excluding HTTP, fsync and IndexedDB.
const backend = createStandardWebCryptoBackend(crypto);
const signer = (await backend.generateSigningKey()).signer; const owner = (await backend.generateSigningKey()).signer;
const rounds = 100; const warmup = 10;
const samples: Record<string, number[]> = {}; let measured = false;
async function timed<T>(name: string, operation: () => T | Promise<T>): Promise<T> {
  const start = performance.now(); const value = await operation();
  if (measured) (samples[name] ??= []).push(performance.now() - start); return value;
}
const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).byteLength;
const inputs = Array.from({ length: 60 }, (_, i) => ({ tick: i + 1, horizontal: (i >= 30 && i < 40 ? 1 : 0) as 0 | 1, vertical: 0 as const }));
let sizes = {};
for (let round = 0; round < rounds + warmup; round++) {
  const db = new DatabaseSync(":memory:"); let now = 1_000;
  try {
    const sql = { exec(query: string, ...args: (string | number | null)[]) { const rows = db.prepare(query).all(...args); return { toArray: () => rows }; } };
    const ledger = new SqliteEncounterLedger(sql);
    const authority = new EncounterAuthority({ ledger, signer, crypto, now: () => now, retentionMs: 10_000 });
    const inventory = new SqliteEncounterInventory({ sql, ledger, signer, backend, now: () => now, transaction: (body) => {
      db.exec("BEGIN"); try { const result = body(); db.exec("COMMIT"); return result; } catch (e) { db.exec("ROLLBACK"); throw e; }
    } });
    const records: InventoryReceiptRecord[] = [];
    for (let i = 0; i < 16; i++) {
      const ticket = await authority.issue({ unit: "benchmark", playerId: "alice", startHead: `start-${i}`, ownerPublicKey: owner.publicKey });
      const chunks = await createEncounterChunks(ticket, inputs, backend);
      now = ticket.commitNotBefore; await authority.commit(await signEncounterCommit(ticket, chunks, owner, backend));
      now = ticket.releaseAt; await authority.reveal(ticket.ticketId);
      const receipt = await authority.settle(ticket.ticketId, chunks); records.push({ ticket, receipt, admittedAssets: [] });
    }
    measured = round >= warmup;
    const command = { expectedCheckpointId: null, ticketIds: records.map((r) => r.ticket.ticketId) };
    await timed("clientVerify16TicketsAndReceipts", async () => {
      for (const r of records) if (!await verifyEncounterTicket(r.ticket, signer.publicKey, backend) || !await verifyEncounterReceipt(r.receipt, signer.publicKey, backend)) throw new Error("invalid receipt");
    });
    const checkpoint = await timed("serverCompact16", () => inventory.compact("benchmark", owner.publicKey, command));
    await timed("serverRetry16", () => inventory.compact("benchmark", owner.publicKey, command));
    const page = await timed("serverCatalogPage3", () => inventory.page("benchmark", owner.publicKey, checkpoint.checkpointId, 0));
    await timed("clientVerifyCheckpoint", async () => { if (!await verifyInventoryCheckpoint(checkpoint, signer.publicKey, backend)) throw new Error("invalid checkpoint"); });
    const listing = await signEncounterListing(records[0].receipt, records[0].receipt.statement.items[0].assetId, owner, backend);
    await timed("serverMarketOldItem", () => authority.admitToMarket(listing));
    const base = { version: 1, revision: 0, current: null, pendingCompaction: null };
    sizes = { localControlBefore: bytes({ ...base, checkpoint: null, history: records }),
      localControlAfter: bytes({ ...base, checkpoint, history: [] }), checkpoint: bytes(checkpoint), catalogPage3: bytes(page),
      compactionCommand: bytes({ op: "inventory-compact", ...command }), listing: bytes(listing) };
  } finally { db.close(); }
}
const timings = Object.fromEntries(Object.entries(samples).map(([name, values]) => {
  const ordered = [...values].sort((a, b) => a - b);
  return [name, { p50Ms: ordered[Math.floor(ordered.length * 0.5)], p95Ms: ordered[Math.floor(ordered.length * 0.95)] }];
}));
console.log(JSON.stringify({ benchmark: "encounter-inventory-compaction-v1", rounds, warmup, batchSize: 16, receiptsPerDatabase: 16,
  environment: { node: process.version, platform: process.platform, arch: process.arch, storage: "SQLite :memory:",
    networkIncluded: false, fsyncIncluded: false, httpAuthenticationIncluded: false, indexedDbIncluded: false }, timings, bytes: sizes }, null, 2));
