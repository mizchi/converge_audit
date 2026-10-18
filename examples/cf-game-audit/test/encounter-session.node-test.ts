import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { IDBFactory } from "fake-indexeddb";
import { createStandardWebCryptoBackend } from "../../player-local-runtime/crypto-backend.ts";
import { EncounterHttpApi } from "../src/encounter-api.ts";
import { HttpEncounterTransport } from "../web/src/audit/encounter-http.ts";
import { IndexedDbAuditPayloadPool } from "../web/src/audit/payload-pool.ts";
import { IndexedDbEncounterSessionStore } from "../web/src/audit/encounter-session-store.ts";
import { EncounterSessionController } from "../web/src/audit/encounter-session.ts";
import { SqliteEncounterArchive } from "../game/encounter/archive-store.ts";
import { SqliteEncounterInventory } from "../game/encounter/inventory-store.ts";
import { SqliteEncounterLedger } from "../game/encounter/ledger.ts";
import { signEncounterRequest } from "../game/encounter/http-wire.ts";

async function fixture() {
  const db = new DatabaseSync(":memory:"); const backend = createStandardWebCryptoBackend(crypto);
  const signer = (await backend.generateSigningKey()).signer; let now = 1_000;
  const sql = { exec(query: string, ...args: (string | number | null)[]) {
    const rows = db.prepare(query).all(...args); return { toArray: () => rows };
  } };
  const archive = new SqliteEncounterArchive({ sql, transaction: (body) => {
    db.exec("BEGIN"); try { const result = body(); db.exec("COMMIT"); return result; } catch (e) { db.exec("ROLLBACK"); throw e; }
  }, signer, trustedAuthorityKey: signer.publicKey, crypto, now: () => now });
  const transaction = <T>(body: () => T): T => {
    db.exec("BEGIN"); try { const result = body(); db.exec("COMMIT"); return result; } catch (e) { db.exec("ROLLBACK"); throw e; }
  };
  const api = new EncounterHttpApi({ sql, signer, crypto, archive, transaction, now: () => now, retentionMs: 0, adminToken: "admin" });
  const factory = new IDBFactory();
  let sessionWrites = 0; let failOnSessionWrite = Infinity;
  const store = await IndexedDbEncounterSessionStore.open({ factory, name: crypto.randomUUID(),
    injectWriteFault: () => { if (++sessionWrites === failOnSessionWrite) throw new Error("session commit fault"); } });
  const owner = await store.owner(backend);
  let writeFault = false;
  const pool = await IndexedDbAuditPayloadPool.open({ factory, name: crypto.randomUUID(),
    limits: { maxBytes: 8_192, reservedBytes: 0, maxItems: 2, maxItemBytes: 4_096 }, maxQueues: 1,
    injectWriteFault: () => { if (writeFault) throw new Error("payload write fault"); } });
  let loseCommit = false; let loseCheckpoint = false; let loseRecovery = false; let loseEmpty = false; let startCalls = 0;
  const transport = new HttpEncounterTransport({ endpoint: "https://test/v1/pve/demo/encounter", unit: "demo", owner, cryptoBackend: backend,
    now: () => now, fetch: async (url, init) => {
      if (JSON.parse(init!.body as string).command.op === "start") startCalls++;
      const response = await api.fetch(new Request(url, init));
      if (loseCommit && JSON.parse(init!.body as string).command.op === "commit") { loseCommit = false; throw new Error("lost commit response"); }
      if (loseCheckpoint && JSON.parse(init!.body as string).command.op === "inventory-compact") { loseCheckpoint = false; throw new Error("lost checkpoint response"); }
      if (loseRecovery && JSON.parse(init!.body as string).command.op === "release-recovery") { loseRecovery = false; throw new Error("lost recovery response"); }
      if (loseEmpty && JSON.parse(init!.body as string).command.op === "inventory-retire-empty") { loseEmpty = false; throw new Error("lost empty retirement response"); }
      return response;
    } });
  const options = { factory, store, owner, pool, transport, backend, trustedKey: signer.publicKey, trustedArchiveKey: signer.publicKey, unit: "demo", now: () => now };
  const authorization = { unit: "demo", playerId: "alice", ownerPublicKey: owner.publicKey, startHead: "earned" };
  const provision = async (startHead = "earned", generation = 0) => {
    const value = { ...authorization, startHead, ...(generation > 0 ? { generation } : {}) };
    const response = await api.fetch(new Request("https://test/v1/pve/demo/encounter-admissions", { method: "POST", headers: { authorization: "Bearer admin" }, body: JSON.stringify(value) }));
    assert.equal(response.status, 201); return value;
  };
  const open = async () => { const c = new EncounterSessionController(options); await c.initialize(); return c; };
  const play = async (c: EncounterSessionController, count = 60) => {
    for (let tick = 1; tick <= count; tick++) await c.step(tick > 30 && tick <= 40 ? 1 : 0, 0);
  };
  return { db, sql, signer, transaction, store, pool, archive, transport, api, owner, backend, open, authorization, provision, play,
    get startCalls() { return startCalls; }, setTime(t: number) { now = t; }, loseNextCommit() { loseCommit = true; },
    loseNextCheckpoint() { loseCheckpoint = true; }, loseNextRecovery() { loseRecovery = true; }, loseNextEmpty() { loseEmpty = true; }, failSessionWriteAfter(n: number) { failOnSessionWrite = sessionWrites + n; }, failWrites() { writeFault = true; } };
}
async function rollGeneration(f: Awaited<ReturnType<typeof fixture>>, expectedGeneration = 0) {
  const response = await f.api.fetch(new Request("https://test/v1/pve/demo/encounter-generation", { method: "POST", headers: { authorization: "Bearer admin" }, body: JSON.stringify({ expectedGeneration }) }));
  assert.equal(response.status, 200);
}
test("a lost recovery release response retries from its durable proof after the terminal row is deleted", async () => {
  const f = await fixture();
  try {
    const c = await f.open(); await c.start(await f.provision()); await f.play(c, 30); await c.terminate();
    await assert.rejects(c.forgetTerminated(), /clean/); await c.cleanup(); const id = c.ticket!.ticketId;
    f.loseNextRecovery(); await assert.rejects(c.forgetTerminated(), /lost recovery/);
    assert.equal((await f.store.read()).current!.recoveryReleasePending, true);
    await rollGeneration(f); assert.equal(new SqliteEncounterLedger(f.sql).byId(id), undefined);
    c.close(); const restored = await f.open();
    assert.equal(restored.current, null); assert.equal(restored.phase, "idle"); assert.equal(f.startCalls, 1);
    assert.equal((await f.pool.snapshot()).usedBytes, 0); restored.close();
  } finally { f.pool.close(); f.store.close(); f.db.close(); }
});
test("local recovery adoption failure retains a proof and normal next-start releases an old forfeit's recovery", async () => {
  const f = await fixture();
  try {
    const c = await f.open(); await c.start(await f.provision()); await c.terminate(); await c.cleanup(); const id = c.ticket!.ticketId;
    f.failSessionWriteAfter(2); await assert.rejects(c.forgetTerminated(), /session commit fault/);
    assert.equal((await f.store.read()).current!.recoveryReleasePending, true);
    await rollGeneration(f); c.close(); const restored = await f.open(); assert.equal(restored.current, null);
    await restored.start(await f.provision("second", 1)); await restored.terminate(); await restored.cleanup(); const second = restored.ticket!.ticketId;
    await restored.start(await f.provision("third", 1));
    const ledger = new SqliteEncounterLedger(f.sql); assert.equal(ledger.byId(id), undefined); assert.equal(ledger.byId(second)!.recoveryReleased, true);
    assert.equal(restored.history.length, 0); restored.close();
  } finally { f.pool.close(); f.store.close(); f.db.close(); }
});
test("an acknowledgment for another termination cannot discard the pending recovery proof", async () => {
  const f = await fixture();
  try {
    const c = await f.open(); await c.start(await f.provision()); await c.terminate(); await c.cleanup();
    const release = f.transport.releaseRecovery.bind(f.transport);
    f.transport.releaseRecovery = async (...args) => ({ ...await release(...args), terminationId: "0".repeat(64) });
    await assert.rejects(c.forgetTerminated(), /invalid recovery release acknowledgment/);
    assert.ok((await f.store.read()).current!.termination); assert.equal((await f.store.read()).current!.recoveryReleasePending, true);
    f.transport.releaseRecovery = release; await rollGeneration(f); c.close();
    const restored = await f.open(); assert.equal(restored.current, null); restored.close();
  } finally { f.pool.close(); f.store.close(); f.db.close(); }
});
async function settleOne(f: Awaited<ReturnType<typeof fixture>>, c: EncounterSessionController, head: string) {
  await c.start(await f.provision(head)); await f.play(c);
  f.setTime(c.ticket!.commitNotBefore); await c.advanceSettlement();
  f.setTime(c.ticket!.releaseAt); await c.advanceSettlement(); await c.cleanup();
}
async function emptyCheckpoint(f: Awaited<ReturnType<typeof fixture>>, c: EncounterSessionController, closeGeneration = true) {
  await c.start(await f.provision("empty")); for (let i = 0; i < 60; i++) await c.step(0, 0);
  f.setTime(c.ticket!.commitNotBefore); await c.advanceSettlement(); f.setTime(c.ticket!.releaseAt); await c.advanceSettlement();
  assert.equal(c.receipt!.statement.items.length, 0); const id = c.ticket!.ticketId; await c.cleanup(); await c.compact(); if (closeGeneration) await rollGeneration(f); return id;
}
test("a definite retirement refusal clears its intent so unused current-generation starts remain consumable", async () => {
  const f = await fixture();
  try {
    const c = await f.open(); await emptyCheckpoint(f, c, false); const next = await f.provision("unused");
    await assert.rejects(c.retireEmptyInventory(), /409/); assert.equal((await f.store.read()).pendingEmptyRetirement, null);
    await c.start(next); assert.equal(c.phase, "playing"); c.close();
  } finally { f.pool.close(); f.store.close(); f.db.close(); }
});
test("a lost empty-retirement response adopts the exact v2 checkpoint after reload without reading deleted originals", async () => {
  const f = await fixture();
  try {
    const c = await f.open(); const id = await emptyCheckpoint(f, c); f.loseNextEmpty();
    await assert.rejects(c.retireEmptyInventory(), /lost empty retirement/);
    const pending = await f.store.read(); assert.equal(pending.checkpoint!.statement.version, 1); assert.deepEqual(pending.pendingEmptyRetirement!.ticketIds, [id]);
    assert.equal(new SqliteEncounterLedger(f.sql).byId(id), undefined); c.close();
    const restored = await f.open(); assert.equal(restored.checkpoint!.statement.version, 2); assert.equal(restored.inventoryPage.length, 0); assert.equal(restored.inventoryHasMore, false);
    assert.equal((await f.store.read()).pendingEmptyRetirement, null); restored.close();
  } finally { f.pool.close(); f.store.close(); f.db.close(); }
});
test("local empty-retirement adoption rolls back, then v2 append preserves retired counts and old item access", async () => {
  const f = await fixture();
  try {
    const c = await f.open(); await emptyCheckpoint(f, c); f.failSessionWriteAfter(2);
    await assert.rejects(c.retireEmptyInventory(), /session commit fault/); assert.ok((await f.store.read()).pendingEmptyRetirement); c.close();
    const restored = await f.open(); assert.equal(restored.checkpoint!.statement.version, 2);
    await restored.start(await f.provision("item-after-gap", 1)); await f.play(restored);
    f.setTime(restored.ticket!.commitNotBefore); await restored.advanceSettlement(); f.setTime(restored.ticket!.releaseAt); await restored.advanceSettlement(); await restored.cleanup();
    await restored.compact(); assert.equal(restored.checkpoint!.statement.receiptCount, 2); assert.equal(restored.checkpoint!.statement.itemCount, 1);
    const item = restored.inventoryPage[0]; await restored.admit(item.receipt.statement.items[0].assetId, item.ticket.ticketId); restored.close();
  } finally { f.pool.close(); f.store.close(); f.db.close(); }
});
test("receipt compaction permits a seventeenth encounter while an old item remains independently verifiable and marketable", async () => {
  const f = await fixture();
  try {
    const c = await f.open(); let firstId = "";
    for (let i = 0; i < 16; i++) { await settleOne(f, c, `batch-${i}`); firstId ||= c.ticket!.ticketId; }
    const before = await f.store.read(); assert.equal(before.history.length, 15);
    await c.compact();
    const compacted = await f.store.read(); assert.equal(compacted.history.length, 0); assert.equal(compacted.current, null);
    assert.equal(compacted.checkpoint!.statement.receiptCount, 16);
    assert.ok(JSON.stringify(compacted).length < 2_048);
    assert.equal(c.inventoryPage.length, 3); assert.equal(c.inventoryHasMore, true);
    const seen: string[] = [];
    do { seen.push(...c.inventoryPage.map((r) => r.ticket.ticketId)); if (!c.inventoryHasMore) break; await c.loadInventory(true); } while (true);
    assert.equal(new Set(seen).size, 16); assert.ok(seen.includes(firstId));
    await c.loadInventory(); const old = c.inventoryPage[0]; assert.equal(old.ticket.ticketId, firstId);
    await c.admit(old.receipt.statement.items[0].assetId, firstId);
    assert.equal(c.inventoryPage[0].admittedAssets.length, 1);
    c.close(); const restored = await f.open(); assert.equal(restored.checkpoint!.statement.receiptCount, 16);
    assert.equal(restored.inventoryPage[0].admittedAssets.length, 1);
    await settleOne(f, restored, "seventeenth"); assert.equal(restored.receipt!.statement.items.length, 1);
    assert.equal((await f.store.read()).history.length, 0); restored.close();
  } finally { f.pool.close(); f.store.close(); f.db.close(); }
});
test("a lost checkpoint response retains its bounded intent and replays the same checkpoint after reload without double counting", async () => {
  const f = await fixture();
  try {
    const c = await f.open(); await settleOne(f, c, "lost-checkpoint");
    f.loseNextCheckpoint(); await assert.rejects(c.compact(), /lost checkpoint/);
    const pending = await f.store.read(); assert.equal(pending.pendingCompaction!.ticketIds.length, 1); assert.ok(pending.current!.receipt);
    c.close(); const restored = await f.open();
    const image = await f.store.read(); assert.equal(image.pendingCompaction, null); assert.equal(image.current, null);
    assert.equal(image.checkpoint!.statement.receiptCount, 1);
    assert.equal(restored.inventoryPage.length, 1); restored.close();
  } finally { f.pool.close(); f.store.close(); f.db.close(); }
});
test("checkpoint batching rejects duplicate receipts, stale heads, unsettled tickets and changed signed summaries", async () => {
  const f = await fixture();
  try {
    const c = await f.open(); await settleOne(f, c, "first"); const id = c.ticket!.ticketId;
    await assert.rejects(f.transport.compactInventory(null, [id, id]), /invalid/);
    await c.compact(); const cp = c.checkpoint!;
    assert.deepEqual(await f.transport.compactInventory(null, [id]), cp);
    await assert.rejects(f.transport.compactInventory(cp.checkpointId, [id]), /409/);
    await c.start(await f.provision("unsettled"));
    await assert.rejects(f.transport.compactInventory(cp.checkpointId, [c.ticket!.ticketId]), /409/);
    await assert.rejects(f.transport.compactInventory("f".repeat(64), [id]), /409/);
    const { verifyInventoryCheckpoint } = await import("../game/encounter/inventory-checkpoint.ts");
    assert.equal(await verifyInventoryCheckpoint({ ...cp, statement: { ...cp.statement, itemCount: 99 } }, cp.statement.authorityKey, f.backend), false);
    c.close();
  } finally { f.pool.close(); f.store.close(); f.db.close(); }
});
test("automatic compaction at the sixteen-receipt boundary reserves room before consuming the next start", async () => {
  const f = await fixture();
  try {
    const c = await f.open();
    for (let i = 0; i < 17; i++) await settleOne(f, c, `automatic-${i}`);
    assert.equal(c.checkpoint!.statement.receiptCount, 16);
    assert.equal(c.history.length, 0); assert.equal(c.inventoryPage.length, 3);
    await c.compact(); assert.equal(c.checkpoint!.statement.receiptCount, 17); c.close();
  } finally { f.pool.close(); f.store.close(); f.db.close(); }
});
test("local checkpoint adoption rolls back atomically and recovers the server's committed result", async () => {
  const f = await fixture();
  try {
    const c = await f.open(); await settleOne(f, c, "local-fault");
    f.failSessionWriteAfter(2); await assert.rejects(c.compact(), /session commit fault/);
    const retained = await f.store.read(); assert.ok(retained.current!.receipt); assert.ok(retained.pendingCompaction); assert.equal(retained.checkpoint, null);
    c.close(); const restored = await f.open(); assert.equal(restored.checkpoint!.statement.receiptCount, 1); restored.close();
  } finally { f.pool.close(); f.store.close(); f.db.close(); }
});
test("inventory index and head commit together, and concurrent competing batches cannot consume the same checkpoint head", async () => {
  const f = await fixture();
  try {
    const c = await f.open(); await settleOne(f, c, "transaction-first"); const first = c.ticket!.ticketId;
    await settleOne(f, c, "transaction-second"); const second = c.ticket!.ticketId; c.close();
    let fail = true;
    const inventory = new SqliteEncounterInventory({ sql: f.sql, ledger: new SqliteEncounterLedger(f.sql), signer: f.signer,
      backend: f.backend, transaction: f.transaction, now: () => 99_000, injectWriteFault: () => { if (fail) throw new Error("inventory transaction fault"); } });
    await assert.rejects(inventory.compact("demo", f.owner.publicKey, { expectedCheckpointId: null, ticketIds: [first] }), /transaction fault/);
    assert.equal(inventory.head("demo", f.owner.publicKey), null);
    assert.equal(f.sql.exec("SELECT COUNT(*) AS n FROM encounter_inventory_members_v1").toArray()[0].n, 0);
    fail = false;
    const results = await Promise.allSettled([first, second].map((id) => inventory.compact("demo", f.owner.publicKey, { expectedCheckpointId: null, ticketIds: [id] })));
    assert.equal(results.filter((r) => r.status === "fulfilled").length, 1); assert.equal(results.filter((r) => r.status === "rejected").length, 1);
    assert.equal(inventory.head("demo", f.owner.publicKey)!.statement.receiptCount, 1);
    assert.equal(f.sql.exec("SELECT COUNT(*) AS n FROM encounter_inventory_members_v1").toArray()[0].n, 1);
  } finally { f.pool.close(); f.store.close(); f.db.close(); }
});
test("compacted receipts retain active evidence holds and cannot be catalogued by another owner", async () => {
  const f = await fixture();
  try {
    const c = await f.open(); await c.start(await f.provision()); await f.play(c);
    f.setTime(c.ticket!.commitNotBefore); await c.advanceSettlement(); f.setTime(c.ticket!.releaseAt); await c.advanceSettlement();
    await c.archive(); const ticketId = c.ticket!.ticketId; await c.compact();
    const ledger = new SqliteEncounterLedger(f.sql); const row = ledger.byId(ticketId)!;
    assert.equal(row.retentionReleased, false);
    assert.equal(ledger.replace(row.revision, { ...row, revision: row.revision + 1, evidenceHold: true }), true);
    const record = c.inventoryPage[0];
    await assert.rejects(c.admit(record.receipt.statement.items[0].assetId, ticketId), /409/);
    const other = (await f.backend.generateSigningKey()).signer;
    const transport = new HttpEncounterTransport({ endpoint: "https://test/v1/pve/demo/encounter", unit: "demo", owner: other,
      cryptoBackend: f.backend, now: () => record.receipt.statement.settledAt, fetch: async (url, init) => f.api.fetch(new Request(url, init)) });
    await assert.rejects(transport.compactInventory(null, [ticketId]), /409/);
    await assert.rejects(transport.inventoryPage(c.checkpoint!.checkpointId), /409/); c.close();
  } finally { f.pool.close(); f.store.close(); f.db.close(); }
});
test("inventory HTTP signatures bind the expected checkpoint, full ticket order and page cursor", async () => {
  const f = await fixture();
  try {
    const c = await f.open(); await settleOne(f, c, "signed-first"); const first = c.ticket!.ticketId;
    await settleOne(f, c, "signed-second"); const second = c.ticket!.ticketId; const now = c.receipt!.statement.settledAt;
    const request = await signEncounterRequest("demo", { op: "inventory-compact", expectedCheckpointId: null, ticketIds: [first, second] }, f.owner, f.backend, now);
    const post = (body: unknown) => f.api.fetch(new Request("https://test/v1/pve/demo/encounter", { method: "POST", body: JSON.stringify(body) }));
    assert.equal((await post({ ...request, command: { ...request.command, expectedCheckpointId: "f".repeat(64) } })).status, 401);
    assert.equal((await post({ ...request, command: { ...request.command, ticketIds: [second, first] } })).status, 401);
    await c.compact();
    const page = await signEncounterRequest("demo", { op: "inventory-page", checkpointId: c.checkpoint!.checkpointId, after: 0 }, f.owner, f.backend, now);
    assert.equal((await post({ ...page, command: { ...page.command, after: 1 } })).status, 401); c.close();
  } finally { f.pool.close(); f.store.close(); f.db.close(); }
});
test("the IndexedDB controller records, restores and compacts receipts across generations with distinct queue identities", async () => {
  const f = await fixture();
  try {
    const c = await f.open(); await settleOne(f, c, "same-head"); const oldQueue = c.ticket!.queueId;
    const roll = (expectedGeneration: number) => f.api.fetch(new Request("https://test/v1/pve/demo/encounter-generation", { method: "POST", headers: { authorization: "Bearer admin" }, body: JSON.stringify({ expectedGeneration }) }));
    assert.equal((await roll(0)).status, 200);
    await c.start(await f.provision("same-head", 1)); assert.equal(c.ticket!.generation, 1); assert.notEqual(c.ticket!.queueId, oldQueue);
    await f.play(c); f.setTime(c.ticket!.commitNotBefore); await c.advanceSettlement(); f.setTime(c.ticket!.releaseAt); await c.advanceSettlement();
    await c.cleanup(); c.close(); const restored = await f.open(); assert.equal(restored.ticket!.generation, 1);
    assert.equal((await roll(1)).status, 200); await restored.compact(); assert.equal(restored.checkpoint!.statement.receiptCount, 2);
    assert.equal(restored.inventoryPage.length, 2); restored.close();
  } finally { f.pool.close(); f.store.close(); f.db.close(); }
});
test("UI session uses bounded logs, confirms real replayed loot, admits it and restores cleaned receipts without allocating another queue", async () => {
  const f = await fixture();
  try {
    const c = await f.open(); await c.start(await f.provision()); await f.play(c);
    assert.equal(c.phase, "ready"); assert.equal(c.receipt, undefined);
    f.setTime(c.ticket!.commitNotBefore); await c.advanceSettlement(); assert.equal(c.phase, "waiting");
    f.setTime(c.ticket!.releaseAt); await c.advanceSettlement();
    assert.equal(c.phase, "settled"); assert.equal(c.receipt!.statement.items.length, 1);
    await c.admit(c.receipt!.statement.items[0].assetId); await c.cleanup(); c.close();
    assert.equal((await f.pool.snapshot()).queueCount, 0);
    const restored = await f.open(); assert.equal(restored.phase, "settled");
    assert.equal((await f.pool.snapshot()).queueCount, 0);
    await restored.start(await f.provision("second"));
    assert.equal((await f.store.read()).history.length, 1); restored.close();
  } finally { f.pool.close(); f.store.close(); f.db.close(); }
});
test("failed chunk persistence never appears as a saved chunk or permits settlement", async () => {
  const f = await fixture();
  try {
    const c = await f.open(); await c.start(await f.provision()); await f.play(c, 29);
    assert.equal(c.durableChunks, 0); f.failWrites();
    await assert.rejects(c.step(0, 0), /fault/);
    assert.equal(c.tick, 30); assert.equal(c.durableChunks, 0);
    assert.equal((await f.pool.scopeSnapshot(c.ticket!.queueId))!.itemCount, 0);
    await assert.rejects(c.advanceSettlement(), /complete/); c.close();
  } finally { f.pool.close(); f.store.close(); f.db.close(); }
});
test("UI archive handoff frees local capacity and recovers the receipt without closing the server's case window", async () => {
  const f = await fixture();
  try {
    const c = await f.open(); await c.start(await f.provision()); await f.play(c);
    f.setTime(c.ticket!.commitNotBefore); await c.advanceSettlement();
    f.setTime(c.ticket!.releaseAt); await c.advanceSettlement();
    await c.archive(); assert.equal(c.current!.cleaned, true);
    assert.equal((await f.pool.snapshot()).queueCount, 0); assert.ok(f.archive.snapshot().usedBytes > 0);
    const row = f.db.prepare("SELECT data FROM encounter_tickets_v1 WHERE id = ?").get(c.ticket!.ticketId)!;
    assert.equal(JSON.parse(row.data as string).retentionReleased, false); c.close();
    const restored = await f.open(); assert.equal(restored.phase, "settled"); assert.equal((await f.pool.snapshot()).queueCount, 0); restored.close();
  } finally { f.pool.close(); f.store.close(); f.db.close(); }
});
test("reload with a partial chunked log cannot resume gameplay or invent the missing inputs", async () => {
  const f = await fixture();
  try {
    const c = await f.open(); await c.start(await f.provision()); await f.play(c, 30); c.close();
    const restored = await f.open(); assert.equal(restored.phase, "interrupted");
    await assert.rejects(restored.step(1, 0), /playing/);
    await assert.rejects(restored.advanceSettlement(), /complete/);
    await restored.terminate(); await restored.cleanup();
    assert.equal((await f.pool.snapshot()).reservedPayloadBytes, 0); assert.equal((await f.pool.snapshot()).queueCount, 0);
    restored.close();
  } finally { f.pool.close(); f.store.close(); f.db.close(); }
});
test("a lost commit reply recovers the authority's pinned root and never starts recording again", async () => {
  const f = await fixture();
  try {
    const c = await f.open(); await c.start(await f.provision()); await f.play(c);
    f.setTime(c.ticket!.commitNotBefore); f.loseNextCommit();
    await assert.rejects(c.advanceSettlement(), /lost/); c.close();
    const restored = await f.open(); assert.equal(restored.phase, "waiting");
    f.setTime(restored.ticket!.releaseAt); await restored.advanceSettlement();
    assert.equal(restored.phase, "settled"); restored.close();
  } finally { f.pool.close(); f.store.close(); f.db.close(); }
});
test("recovering a pending start never issues a ticket before its full capacity is available", async () => {
  const f = await fixture();
  try {
    await f.provision();
    await f.store.write({ ...await f.store.read(), current: { authorization: f.authorization, phase: "starting", cleaned: false, admittedAssets: [] } }, 0);
    await f.pool.reserve({ queueId: "other", limits: { maxBytes: 8_192, reservedBytes: 0, maxItems: 2, maxItemBytes: 4_096 },
      bytes: 8_192, items: 2, verifyPruneGrant: async () => false });
    await assert.rejects(f.open(), /capacity/); assert.equal(f.startCalls, 0);
  } finally { f.pool.close(); f.store.close(); f.db.close(); }
});
