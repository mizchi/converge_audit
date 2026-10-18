import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { createStandardWebCryptoBackend } from "../../player-local-runtime/crypto-backend.ts";
import { EncounterAuthority, SqliteEncounterLedger, createEncounterChunks, signEncounterCommit } from "../game/encounter/index.ts";
import { EncounterHttpApi } from "../src/encounter-api.ts";
import { HttpEncounterTransport } from "../web/src/audit/encounter-http.ts";
import { inventoryNextRoot, inventoryRetirementDigest, validInventoryPage, verifyInventoryCheckpoint, type InventoryCheckpoint } from "../game/encounter/inventory-checkpoint.ts";

const db = new DatabaseSync(":memory:"); const backend = createStandardWebCryptoBackend(crypto);
const signer = (await backend.generateSigningKey()).signer; const owner = (await backend.generateSigningKey()).signer; let now = 1_000;
const sql = { exec(query: string, ...args: (string | number | null)[]) { const rows = db.prepare(query).all(...args); return { toArray: () => rows }; } };
const transaction = <T>(body: () => T): T => { db.exec("BEGIN"); try { const r = body(); db.exec("COMMIT"); return r; } catch (e) { db.exec("ROLLBACK"); throw e; } };
const api = new EncounterHttpApi({ sql, transaction, signer, crypto, now: () => now, retentionMs: 0, adminToken: "bench" });
const authority = new EncounterAuthority({ ledger: new SqliteEncounterLedger(sql), signer, crypto, now: () => now, retentionMs: 0,
  currentGeneration: () => sql.exec("SELECT generation FROM encounter_generations_v1 WHERE unit = ?", "benchmark").toArray()[0]?.generation as number ?? 0 });
const transport = new HttpEncounterTransport({ endpoint: "https://test/v1/pve/benchmark/encounter", unit: "benchmark", owner, cryptoBackend: backend, now: () => now,
  fetch: async (url, init) => api.fetch(new Request(url, init)) });
const admin = async (action: string, body: unknown, expected = 200) => {
  const r = await api.fetch(new Request(`https://test/v1/pve/benchmark/${action}`, { method: "POST", headers: { authorization: "Bearer bench" }, body: JSON.stringify(body) }));
  assert.equal(r.status, expected); await r.text();
};
const stats = (samples: number[]) => { const s = [...samples].sort((a, b) => a - b); return { samples: s.length, p50Ms: s[Math.floor(s.length * .5)], p95Ms: s[Math.floor(s.length * .95)] }; };
const rounds = 20; const warmup = 1; const generationSize = 128; const batchSize = 16;
const retirement: number[] = []; const pages: number[] = []; let cp: InventoryCheckpoint | null = null;
let coldBytesBefore = 0; let maxCheckpointBytes = 0; let maxPageBytes = 0;
try {
  for (let generation = 0; generation < rounds + warmup; generation++) {
    const ids: string[] = [];
    for (let i = 0; i < generationSize; i++) {
      const auth = { unit: "benchmark", startHead: `earned-${i}`, playerId: "alice", ownerPublicKey: owner.publicKey, ...(generation ? { generation } : {}) };
      await admin("encounter-admissions", auth, 201); const ticket = await authority.issue(auth);
      const chunks = await createEncounterChunks(ticket, Array.from({ length: 60 }, (_, tick) => ({ tick: tick + 1, horizontal: 0 as const, vertical: 0 as const })), backend);
      now = ticket.commitNotBefore; await authority.commit(await signEncounterCommit(ticket, chunks, owner, backend));
      now = ticket.releaseAt; await authority.reveal(ticket.ticketId); const receipt = await authority.settle(ticket.ticketId, chunks);
      assert.equal(receipt.statement.items.length, 0); await authority.pruneGrant(ticket.ticketId, 0); ids.push(ticket.ticketId);
    }
    for (let i = 0; i < ids.length; i += batchSize) cp = await transport.compactInventory(cp?.checkpointId ?? null, ids.slice(i, i + batchSize));
    await admin("encounter-generation", { expectedGeneration: generation });
    coldBytesBefore = sql.exec("SELECT SUM(length(CAST(data AS BLOB))) AS n FROM encounter_origins_v1").toArray()[0].n as number;
    for (let i = 0; i < ids.length; i += batchSize) {
      const selected = ids.slice(i, i + batchSize); const previous = cp!; const start = performance.now();
      const next = await transport.retireEmptyInventory(previous.checkpointId, selected);
      assert.equal(await verifyInventoryCheckpoint(next, signer.publicKey, backend), true);
      assert.equal(next.statement.batchDigest, await inventoryRetirementDigest(selected, backend));
      assert.equal(next.statement.root, await inventoryNextRoot(previous, next.statement.batchDigest, backend, "retire-empty"));
      if (generation >= warmup) retirement.push(performance.now() - start);
      cp = next; maxCheckpointBytes = Math.max(maxCheckpointBytes, new TextEncoder().encode(JSON.stringify(cp)).byteLength);
    }
    const start = performance.now(); const page = await transport.inventoryPage(cp!.checkpointId); assert.equal(validInventoryPage(page, cp!, 0), true);
    if (generation >= warmup) pages.push(performance.now() - start);
    maxPageBytes = Math.max(maxPageBytes, new TextEncoder().encode(JSON.stringify(page)).byteLength);
    assert.equal(sql.exec("SELECT COUNT(*) AS n FROM encounter_origins_v1").toArray()[0].n, 0);
    assert.equal(sql.exec("SELECT COUNT(*) AS n FROM encounter_inventory_members_v1").toArray()[0].n, 0);
    assert.equal(sql.exec("SELECT COUNT(*) AS n FROM encounter_inventory_empty_ranges_v1").toArray()[0].n, 1);
  }
  console.log(JSON.stringify({ benchmark: "encounter-empty-inventory-v1", rounds, warmup, generationSize, batchSize, totalEmptySettlements: (rounds + warmup) * generationSize,
    environment: { node: process.version, platform: process.platform, arch: process.arch, storage: "SQLite :memory:", inProcessSignedHttpIncluded: true,
      clientCheckpointCryptoIncluded: true, networkIncluded: false, fsyncIncluded: false, indexedDbIncluded: false, workerSchedulingIncluded: false, caseBindings: 0 },
    retirement: stats(retirement), allEmptyPage: stats(pages), bytes: { coldJsonBeforeLastRetirement: coldBytesBefore, coldJsonAfter: 0, maxCheckpoint: maxCheckpointBytes, maxPage: maxPageBytes },
    final: { receiptCount: cp!.statement.receiptCount, itemCount: cp!.statement.itemCount, origins: 0, inventoryMembers: 0,
      emptyRanges: sql.exec("SELECT first, last FROM encounter_inventory_empty_ranges_v1").toArray(), checkpointHeads: 1 },
  }, null, 2));
} finally { db.close(); }
