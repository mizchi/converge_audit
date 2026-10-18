import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { createStandardWebCryptoBackend } from "../../player-local-runtime/crypto-backend.ts";
import { EncounterHttpApi } from "../src/encounter-api.ts";
import { HttpEncounterTransport } from "../web/src/audit/encounter-http.ts";
import { createEncounterChunks, signEncounterCommit, signEncounterListing } from "../game/encounter/wire.ts";
import { inventoryRetiredCount, validInventoryPage, verifyInventoryCheckpoint } from "../game/encounter/inventory-checkpoint.ts";
import { SqliteEncounterLedger } from "../game/encounter/ledger.ts";
import { SqliteEncounterInventory } from "../game/encounter/inventory-store.ts";

async function fixture() {
  const db = new DatabaseSync(":memory:"); const backend = createStandardWebCryptoBackend(crypto);
  const signer = (await backend.generateSigningKey()).signer; const owner = (await backend.generateSigningKey()).signer; let now = 1_000; let fail = false;
  const sql = { exec(query: string, ...args: (string | number | null)[]) { const rows = db.prepare(query).all(...args); return { toArray: () => rows }; } };
  const transaction = <T>(body: () => T): T => { db.exec("BEGIN"); try { const r = body(); if (fail) throw new Error("retirement write fault"); db.exec("COMMIT"); return r; } catch (e) { db.exec("ROLLBACK"); throw e; } };
  let api = new EncounterHttpApi({ sql, transaction, signer, crypto, now: () => now, retentionMs: 0, adminToken: "admin" });
  const transport = new HttpEncounterTransport({ endpoint: "https://test/v1/pve/demo/encounter", unit: "demo", owner, cryptoBackend: backend, now: () => now,
    fetch: async (url, init) => api.fetch(new Request(url, init)) });
  const admin = (action: string, body: unknown) => api.fetch(new Request(`https://test/v1/pve/demo/${action}`, { method: "POST", headers: { authorization: "Bearer admin" }, body: JSON.stringify(body) }));
  const settle = async (head: string, item = false, generation = 0) => {
    assert.equal((await admin("encounter-admissions", { unit: "demo", startHead: head, playerId: "alice", ownerPublicKey: owner.publicKey, ...(generation ? { generation } : {}) })).status, 201);
    const ticket = await transport.start(head, generation);
    const frames = Array.from({ length: 60 }, (_, i) => ({ tick: i + 1, horizontal: (item && i >= 30 && i < 40 ? 1 : 0) as 0 | 1, vertical: 0 as const }));
    const chunks = await createEncounterChunks(ticket, frames, backend);
    now = ticket.commitNotBefore; await transport.commit(await signEncounterCommit(ticket, chunks, owner, backend));
    now = ticket.releaseAt; await transport.reveal(ticket.ticketId); const receipt = await transport.settle(ticket.ticketId, chunks);
    assert.equal(receipt.statement.items.length, item ? 1 : 0); await transport.pruneGrant(ticket.ticketId, 0);
    return { ticket, receipt };
  };
  return { db, sql, transaction, signer, owner, backend, transport, settle, get api() { return api; }, admin,
    roll: (expectedGeneration = 0) => admin("encounter-generation", { expectedGeneration }), setFault(value: boolean) { fail = value; },
    reopen() { api = new EncounterHttpApi({ sql, transaction, signer, crypto, now: () => now, retentionMs: 0, adminToken: "admin" }); } };
}

test("retiring empty receipts preserves historical ordinals, current item provenance and exact retry after source deletion", async () => {
  const f = await fixture();
  try {
    const first = await f.settle("empty-1"); const reward = await f.settle("item", true); const last = await f.settle("empty-3");
    const cp = await f.transport.compactInventory(null, [first.ticket.ticketId, reward.ticket.ticketId, last.ticket.ticketId]);
    await assert.rejects(f.transport.retireEmptyInventory(cp.checkpointId, [first.ticket.ticketId]), /409/);
    assert.equal((await f.roll()).status, 200);
    await assert.rejects(f.transport.retireEmptyInventory(cp.checkpointId, [reward.ticket.ticketId]), /409/);
    const retired = await f.transport.retireEmptyInventory(cp.checkpointId, [first.ticket.ticketId, last.ticket.ticketId]);
    assert.equal(retired.statement.version, 2); assert.equal(retired.statement.receiptCount, 3); assert.equal(retired.statement.itemCount, 1);
    assert.equal(inventoryRetiredCount(retired), 2); assert.equal(await verifyInventoryCheckpoint(retired, f.signer.publicKey, f.backend), true);
    assert.equal(await verifyInventoryCheckpoint({ ...retired, statement: { ...retired.statement, retiredEmptyCount: 1 } }, f.signer.publicKey, f.backend), false);
    f.reopen(); assert.deepEqual(await f.transport.retireEmptyInventory(cp.checkpointId, [first.ticket.ticketId, last.ticket.ticketId]), retired);
    const page = await f.transport.inventoryPage(retired.checkpointId);
    assert.equal(validInventoryPage(page, retired, 0), true); assert.deepEqual(page.positions, [2]);
    assert.deepEqual(page.emptyRanges, [{ first: 1, last: 1 }, { first: 3, last: 3 }]); assert.equal(page.next, null);
    assert.equal(validInventoryPage({ ...page, positions: [1] }, retired, 0), false);
    assert.equal(page.records[0].ticket.ticketId, reward.ticket.ticketId);
    await assert.rejects(f.transport.status(first.ticket.ticketId), /403/); await assert.rejects(f.transport.start("empty-1"), /403/);
    assert.equal((await f.transport.admitToMarket(await signEncounterListing(reward.receipt, reward.receipt.statement.items[0].assetId, f.owner, f.backend))).accepted, true);
    const next = await f.settle("next", false, 1); const appended = await f.transport.compactInventory(retired.checkpointId, [next.ticket.ticketId]);
    assert.equal(inventoryRetiredCount(appended), 2); assert.equal(appended.statement.receiptCount, 4);
    assert.deepEqual(await f.transport.compactInventory(retired.checkpointId, [next.ticket.ticketId]), appended);
    await assert.rejects(f.transport.retireEmptyInventory(cp.checkpointId, [first.ticket.ticketId, last.ticket.ticketId]), /409/);
  } finally { f.db.close(); }
});

test("out-of-order retirement merges both neighboring ranges and rolls back source, index, ranges and checkpoint together", async () => {
  const f = await fixture();
  try {
    const rows = []; for (let i = 0; i < 5; i++) rows.push(await f.settle(`empty-${i}`));
    const ids = rows.map((r) => r.ticket.ticketId); let cp = await f.transport.compactInventory(null, ids); await f.roll();
    const ledger = new SqliteEncounterLedger(f.sql); const held = ledger.byId(ids[0])!;
    assert.equal(ledger.replace(held.revision, { ...held, revision: held.revision + 1, evidenceHold: true }), true);
    await assert.rejects(f.transport.retireEmptyInventory(cp.checkpointId, [ids[0]]), /409/);
    const clear = ledger.byId(ids[0])!; ledger.replace(clear.revision, { ...clear, revision: clear.revision + 1, evidenceHold: false });
    f.setFault(true); await assert.rejects(f.transport.retireEmptyInventory(cp.checkpointId, ids), /409/); f.setFault(false);
    assert.ok(ledger.byId(ids[0])); assert.equal(f.sql.exec("SELECT COUNT(*) AS n FROM encounter_inventory_members_v1").toArray()[0].n, 5);
    assert.equal(f.sql.exec("SELECT COUNT(*) AS n FROM encounter_inventory_empty_ranges_v1").toArray()[0].n, 0);
    cp = await f.transport.retireEmptyInventory(cp.checkpointId, [ids[0], ids[2], ids[4]]);
    cp = await f.transport.retireEmptyInventory(cp.checkpointId, [ids[1], ids[3]]);
    assert.deepEqual(f.sql.exec("SELECT first, last FROM encounter_inventory_empty_ranges_v1").toArray().map((r) => ({ ...r })), [{ first: 1, last: 5 }]);
    const page = await f.transport.inventoryPage(cp.checkpointId); assert.deepEqual(page.records, []); assert.deepEqual(page.emptyRanges, [{ first: 1, last: 5 }]);
    assert.equal(validInventoryPage(page, cp, 0), true); assert.equal(validInventoryPage({ ...page, emptyRanges: [{ first: 2, last: 5 }] }, cp, 0), false);
    assert.equal(f.sql.exec("SELECT COUNT(*) AS n FROM encounter_origins_v1").toArray()[0].n, 0);
  } finally { f.db.close(); }
});

test("retirement rechecks live cases after signing and competing batches cannot consume the same checkpoint twice", async () => {
  const f = await fixture();
  try {
    const a = await f.settle("a"); const b = await f.settle("b"); const cp = await f.transport.compactInventory(null, [a.ticket.ticketId, b.ticket.ticketId]); await f.roll();
    let entered!: () => void; let resume!: () => void; let held = false;
    const signing = new Promise<void>((resolve) => { entered = resolve; }); const release = new Promise<void>((resolve) => { resume = resolve; });
    const signer = { scheme: f.signer.scheme, publicKey: f.signer.publicKey, signDigest: async (digest: string) => { entered(); await release; return f.signer.signDigest(digest); } };
    const inventory = new SqliteEncounterInventory({ sql: f.sql, ledger: new SqliteEncounterLedger(f.sql), signer, backend: f.backend,
      transaction: f.transaction, now: () => b.receipt.statement.retentionUntil, currentGeneration: () => 1, held: () => held });
    const pending = inventory.retireEmpty("demo", f.owner.publicKey, { expectedCheckpointId: cp.checkpointId, ticketIds: [a.ticket.ticketId] });
    await signing; held = true; resume(); await assert.rejects(pending, /retirement refused/);
    assert.equal(inventory.head("demo", f.owner.publicKey)!.checkpointId, cp.checkpointId);
    const results = await Promise.allSettled([a, b].map((r) => f.transport.retireEmptyInventory(cp.checkpointId, [r.ticket.ticketId])));
    assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
    assert.equal(f.sql.exec("SELECT COUNT(*) AS n FROM encounter_origins_v1").toArray()[0].n, 1);
  } finally { f.db.close(); }
});

test("repeated all-empty generations retain one range while later appends keep historical counts", async () => {
  const f = await fixture();
  try {
    let cp = null;
    for (let generation = 0; generation < 4; generation++) {
      const ids: string[] = [];
      for (let i = 0; i < 32; i++) ids.push((await f.settle(`empty-${i}`, false, generation)).ticket.ticketId);
      for (let i = 0; i < ids.length; i += 16) cp = await f.transport.compactInventory(cp?.checkpointId ?? null, ids.slice(i, i + 16));
      assert.equal((await f.roll(generation)).status, 200);
      for (let i = 0; i < ids.length; i += 16) cp = await f.transport.retireEmptyInventory(cp!.checkpointId, ids.slice(i, i + 16));
      assert.equal(cp!.statement.receiptCount, (generation + 1) * 32); assert.equal(inventoryRetiredCount(cp), (generation + 1) * 32);
      assert.equal(f.sql.exec("SELECT COUNT(*) AS n FROM encounter_inventory_members_v1").toArray()[0].n, 0);
      assert.equal(f.sql.exec("SELECT COUNT(*) AS n FROM encounter_origins_v1").toArray()[0].n, 0);
      assert.equal(f.sql.exec("SELECT COUNT(*) AS n FROM encounter_inventory_empty_ranges_v1").toArray()[0].n, 1);
    }
    const page = await f.transport.inventoryPage(cp!.checkpointId); assert.deepEqual(page.emptyRanges, [{ first: 1, last: 128 }]);
    const suffix = await f.transport.inventoryPage(cp!.checkpointId, 100); assert.deepEqual(suffix.emptyRanges, [{ first: 101, last: 128 }]);
    assert.equal(validInventoryPage(suffix, cp!, 100), true);
  } finally { f.db.close(); }
});
