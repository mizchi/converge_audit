import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { createStandardWebCryptoBackend } from "../../player-local-runtime/crypto-backend.ts";
import { EncounterHttpApi } from "../src/encounter-api.ts";
import { SqliteEncounterArchive } from "../game/encounter/archive-store.ts";
import { createEncounterChunks, signEncounterCommit, signEncounterListing, verifyEncounterTicket } from "../game/encounter/wire.ts";
import { HttpEncounterTransport } from "../web/src/audit/encounter-http.ts";
import { EncounterAuthority } from "../game/encounter/authority.ts";
import { SqliteEncounterLedger } from "../game/encounter/ledger.ts";
import type { EncounterGenerationSeal } from "../game/encounter/generation.ts";
import { SqliteEncounterRecovery } from "../game/encounter/recovery-store.ts";

async function fixture(legacy = false, maxAdmissions = 1) {
  const db = new DatabaseSync(":memory:"); const backend = createStandardWebCryptoBackend(crypto);
  const signer = (await backend.generateSigningKey()).signer; const owner = (await backend.generateSigningKey()).signer; let now = 1_000;
  const sql = { exec(query: string, ...args: (string | number | null)[]) { const rows = db.prepare(query).all(...args); return { toArray: () => rows }; } };
  let fail = false;
  const transaction = <T>(body: () => T): T => { db.exec("BEGIN"); try { const value = body(); if (fail) throw new Error("rollover write fault"); db.exec("COMMIT"); return value; } catch (e) { db.exec("ROLLBACK"); throw e; } };
  const archive = new SqliteEncounterArchive({ sql, transaction, signer, trustedAuthorityKey: signer.publicKey, crypto, now: () => now, maxObjects: 1 });
  const makeApi = (generational = true) => new EncounterHttpApi({ sql, signer, crypto, archive, ...(generational ? { transaction } : {}), now: () => now, retentionMs: 0, maxAdmissions, adminToken: "admin" });
  let api = makeApi(!legacy);
  const transport = new HttpEncounterTransport({ endpoint: "https://test/v1/pve/demo/encounter", unit: "demo", owner, cryptoBackend: backend, now: () => now,
    fetch: async (url, init) => api.fetch(new Request(url, init)) });
  const admin = async (path: string, body: unknown) => api.fetch(new Request(`https://test/v1/pve/demo/${path}`, { method: "POST", headers: { authorization: "Bearer admin" }, body: JSON.stringify(body) }));
  const provision = (generation?: number, startHead = "earned") => admin("encounter-admissions", { unit: "demo", startHead, playerId: "alice", ownerPublicKey: owner.publicKey, ...(generation === undefined ? {} : { generation }) });
  const roll = (expectedGeneration: number) => admin("encounter-generation", { expectedGeneration });
  const settle = async (generation = 0, startHead = "earned") => {
    const ticket = await transport.start(startHead, generation);
    const frames = Array.from({ length: 60 }, (_, i) => ({ tick: i + 1, horizontal: (i >= 30 && i < 40 ? 1 : 0) as 0 | 1, vertical: 0 as const }));
    const chunks = await createEncounterChunks(ticket, frames, backend); const commitment = await signEncounterCommit(ticket, chunks, owner, backend);
    now = ticket.commitNotBefore; await transport.commit(commitment); now = ticket.releaseAt; const reveal = await transport.reveal(ticket.ticketId);
    const receipt = await transport.settle(ticket.ticketId, chunks); return { ticket, receipt, chunks, reveal, commitment };
  };
  return { db, backend, owner, signer, sql, transaction, archive, transport, get api() { return api; }, makeApi, reopen() { api = makeApi(); }, provision, roll, settle, setFault(value: boolean) { fail = value; } };
}
test("generation rollover reclaims admission and archive slots while old origins remain marketable and old starts cannot replay", async () => {
  const f = await fixture();
  try {
    assert.equal((await f.provision()).status, 201); const first = await f.settle();
    await f.transport.archiveUpload(first.ticket.ticketId, first.chunks);
    assert.equal((await f.roll(0)).status, 409);
    await f.transport.archiveRelease(first.ticket.ticketId);
    const response = await f.roll(0); assert.equal(response.status, 200); const seal = await response.json() as EncounterGenerationSeal;
    assert.equal(await verifyEncounterTicket({ ...first.ticket, generation: 1 }, f.signer.publicKey, f.backend), false);
    const { verifyGenerationSeal } = await import("../game/encounter/generation.ts");
    assert.equal(await verifyGenerationSeal(seal, f.signer.publicKey, f.backend), true);
    assert.equal(await verifyGenerationSeal({ ...seal, statement: { ...seal.statement, nextGeneration: 9 } }, f.signer.publicKey, f.backend), false);
    assert.deepEqual(await (await f.roll(0)).json(), seal);
    assert.equal(f.archive.snapshot().totalObjects, 0); assert.equal(f.archive.minimumGeneration("demo"), 1);
    assert.equal(f.sql.exec("SELECT COUNT(*) AS n FROM encounter_tickets_v1").toArray()[0].n, 0);
    const origin = f.sql.exec("SELECT data FROM encounter_origins_v1 WHERE id = ?", first.ticket.ticketId).toArray()[0];
    assert.ok(origin); assert.equal(JSON.parse(origin.data as string).secret, ""); assert.equal(JSON.parse(origin.data as string).reveal, undefined);
    assert.equal((await f.provision()).status, 409); assert.equal((await f.transport.start("earned")).ticketId, first.ticket.ticketId);
    assert.equal(f.sql.exec("SELECT COUNT(*) AS n FROM encounter_tickets_v1").toArray()[0].n, 0);
    await assert.rejects(f.transport.reveal(first.ticket.ticketId), /409/);
    assert.equal((await f.transport.status(first.ticket.ticketId)).phase, "settled");
    const listing = await signEncounterListing(first.receipt, first.receipt.statement.items[0].assetId, f.owner, f.backend);
    assert.equal((await f.transport.admitToMarket(listing)).accepted, true);
    assert.equal((await f.transport.status(first.ticket.ticketId)).receipt!.receiptId, first.receipt.receiptId);
    assert.equal((await f.provision(1)).status, 201); const second = await f.settle(1);
    assert.equal(second.ticket.generation, 1); assert.notEqual(second.ticket.queueId, first.ticket.queueId);
    await f.transport.archiveUpload(second.ticket.ticketId, second.chunks);
    assert.equal(f.archive.snapshot().totalObjects, 1);
    await assert.rejects(f.archive.store({ ...first, commitment: (await f.transport.status(first.ticket.ticketId)).commitment!, reveal: { ticketId: first.ticket.ticketId, root: first.receipt.statement.root, seed: "0".repeat(64), committedAt: first.ticket.commitNotBefore, releasedAt: first.ticket.releaseAt, signature: "0".repeat(128) } }), /generation/);
    const cp = await f.transport.compactInventory(null, [first.ticket.ticketId, second.ticket.ticketId]);
    assert.equal(cp.statement.receiptCount, 2); assert.equal((await f.transport.inventoryPage(cp.checkpointId)).records.length, 2);
  } finally { f.db.close(); }
});
test("unused authorizations block rotation and legacy admissions migrate without reviving a retired generation on restart", async () => {
  const f = await fixture(true);
  try {
    await f.provision(); f.reopen(); assert.equal((await f.transport.admissions()).length, 1);
    assert.equal((await f.roll(0)).status, 409);
    const first = await f.settle(); await f.transport.pruneGrant(first.ticket.ticketId, 0);
    assert.equal((await f.roll(0)).status, 200); f.reopen();
    assert.equal((await f.transport.admissions()).length, 0); assert.equal((await f.provision()).status, 409);
    assert.throws(() => f.makeApi(false), /generation transaction required/);
    assert.equal((await f.provision(1)).status, 201); const second = await f.settle(1); await f.transport.pruneGrant(second.ticket.ticketId, 0);
    assert.equal((await f.roll(1)).status, 200); assert.equal((await f.roll(0)).status, 409);
    f.reopen(); assert.equal(f.archive.minimumGeneration("demo"), 2);
    const configuration = await f.api.fetch(new Request("https://test/v1/pve/demo/encounter-configuration"));
    assert.equal((await configuration.json() as { generation: number }).generation, 2);
    f.sql.exec("DELETE FROM encounter_generations_v1");
    await assert.rejects(f.transport.start("earned", 2), /missing generation fence/);
  } finally { f.db.close(); }
});
test("generation rollover refuses unfinished evidence and commits its fences, origins and reclaimed slots atomically", async () => {
  const f = await fixture();
  try {
    await f.provision(); const first = await f.settle();
    assert.equal((await f.roll(0)).status, 409);
    await f.transport.archiveUpload(first.ticket.ticketId, first.chunks); await f.transport.archiveRelease(first.ticket.ticketId);
    f.setFault(true); assert.equal((await f.roll(0)).status, 409); f.setFault(false);
    assert.equal(f.archive.minimumGeneration("demo"), 0); assert.equal(f.archive.snapshot().totalObjects, 1);
    assert.equal(f.sql.exec("SELECT COUNT(*) AS n FROM encounter_tickets_v1").toArray()[0].n, 1);
    assert.equal(f.sql.exec("SELECT COUNT(*) AS n FROM encounter_origins_v1").toArray()[0].n, 0);
    assert.equal((await f.roll(0)).status, 200); assert.equal(f.archive.minimumGeneration("demo"), 1);
    assert.equal((await f.roll(2)).status, 409);
  } finally { f.db.close(); }
});
test("a real 1025th settlement and inventory checkpoint cross the old lifetime ceiling without losing the first origin", async () => {
  const f = await fixture(false, 1_024);
  try {
    const ids: string[] = []; let first: Awaited<ReturnType<typeof f.settle>> | undefined;
    for (let i = 0; i < 1_024; i++) {
      const head = `start-${i}`; assert.equal((await f.provision(0, head)).status, 201);
      const result = await f.settle(0, head); first ??= result; ids.push(result.ticket.ticketId); await f.transport.pruneGrant(result.ticket.ticketId, 0);
    }
    assert.equal((await f.provision(0, "overflow")).status, 429);
    let checkpoint: Awaited<ReturnType<typeof f.transport.compactInventory>> | undefined;
    for (let i = 0; i < ids.length; i += 16) checkpoint = await f.transport.compactInventory(checkpoint?.checkpointId ?? null, ids.slice(i, i + 16));
    assert.equal(checkpoint!.statement.receiptCount, 1_024);
    assert.equal((await f.roll(0)).status, 200); assert.equal((await f.provision(1, "new-generation")).status, 201);
    const next = await f.settle(1, "new-generation");
    checkpoint = await f.transport.compactInventory(checkpoint!.checkpointId, [next.ticket.ticketId]);
    assert.equal(checkpoint.statement.receiptCount, 1_025);
    assert.equal((await f.transport.inventoryPage(checkpoint.checkpointId, 1_024)).records[0].ticket.generation, 1);
    const listing = await signEncounterListing(first!.receipt, first!.receipt.statement.items[0].assetId, f.owner, f.backend);
    assert.equal((await f.transport.admitToMarket(listing)).accepted, true);
    assert.equal(f.sql.exec("SELECT COUNT(*) AS n FROM encounter_tickets_v1").toArray()[0].n, 1);
    assert.equal(f.sql.exec("SELECT COUNT(*) AS n FROM encounter_origins_v1").toArray()[0].n, 1_024);
  } finally { f.db.close(); }
});
test("an in-flight issued ticket cannot cross a generation fence during asynchronous signing", async () => {
  const f = await fixture();
  try {
    let generation = 0; let entered!: () => void; let resume!: () => void;
    const signing = new Promise<void>((resolve) => { entered = resolve; }); const release = new Promise<void>((resolve) => { resume = resolve; });
    const signer = { scheme: f.signer.scheme, publicKey: f.signer.publicKey, signDigest: async (digest: string) => { entered(); await release; return f.signer.signDigest(digest); } };
    const authority = new EncounterAuthority({ ledger: new SqliteEncounterLedger(f.sql), signer, crypto, now: () => 1_000, retentionMs: 0, currentGeneration: () => generation });
    const pending = authority.issue({ unit: "demo", startHead: "delayed", playerId: "alice", ownerPublicKey: f.owner.publicKey });
    await signing; generation = 1; resume(); await assert.rejects(pending, /generation changed/);
    assert.equal(f.sql.exec("SELECT COUNT(*) AS n FROM encounter_tickets_v1").toArray()[0].n, 0);
  } finally { f.db.close(); }
});
test("an in-flight archive upload cannot recreate a reclaimed tombstone after generation retirement", async () => {
  const f = await fixture();
  try {
    await f.provision(); const first = await f.settle(); let entered!: () => void; let resume!: () => void;
    const signing = new Promise<void>((resolve) => { entered = resolve; }); const release = new Promise<void>((resolve) => { resume = resolve; });
    const signer = { scheme: f.signer.scheme, publicKey: f.signer.publicKey, signDigest: async (digest: string) => { entered(); await release; return f.signer.signDigest(digest); } };
    const delayed = new SqliteEncounterArchive({ sql: f.sql, transaction: (body) => { f.db.exec("BEGIN"); try { const value = body(); f.db.exec("COMMIT"); return value; } catch (e) { f.db.exec("ROLLBACK"); throw e; } },
      signer, trustedAuthorityKey: f.signer.publicKey, crypto, now: () => first.receipt.statement.settledAt });
    const pending = delayed.store(first); await signing;
    await f.transport.pruneGrant(first.ticket.ticketId, 0); assert.equal((await f.roll(0)).status, 200);
    resume(); await assert.rejects(pending, /generation retired/); assert.equal(f.archive.snapshot().totalObjects, 0);
  } finally { f.db.close(); }
});
test("a separately stored archive cannot be reclaimed through the authority's local transaction", async () => {
  const f = await fixture(); const remote = new DatabaseSync(":memory:");
  try {
    await f.provision(); const first = await f.settle(); await f.transport.pruneGrant(first.ticket.ticketId, 0);
    const sql = { exec(query: string, ...args: (string | number | null)[]) { const rows = remote.prepare(query).all(...args); return { toArray: () => rows }; } };
    const archive = new SqliteEncounterArchive({ sql, signer: f.signer, trustedAuthorityKey: f.signer.publicKey, crypto, now: () => first.receipt.statement.settledAt,
      transaction: (body) => { remote.exec("BEGIN"); try { const r = body(); remote.exec("COMMIT"); return r; } catch (e) { remote.exec("ROLLBACK"); throw e; } } });
    const api = new EncounterHttpApi({ sql: f.sql, signer: f.signer, archive, crypto, transaction: f.transaction, now: () => first.receipt.statement.settledAt, retentionMs: 0, adminToken: "admin" });
    const response = await api.fetch(new Request("https://test/v1/pve/demo/encounter-generation", { method: "POST", headers: { authorization: "Bearer admin" }, body: JSON.stringify({ expectedGeneration: 0 }) }));
    assert.equal(response.status, 409); assert.equal(f.archive.minimumGeneration("demo"), 0); assert.equal(archive.minimumGeneration("demo"), 0);
    assert.equal(f.sql.exec("SELECT COUNT(*) AS n FROM encounter_tickets_v1").toArray()[0].n, 1);
  } finally { remote.close(); f.db.close(); }
});

test("owner-released forfeits disappear at rollover and signed retry works without a per-ticket tombstone", async () => {
  const f = await fixture();
  try {
    await f.provision(); const ticket = await f.transport.start("earned");
    const termination = await f.transport.terminate(ticket.ticketId, "abandoned");
    await assert.rejects(f.transport.releaseRecovery(ticket, termination), /409/);
    await f.transport.closureGrant(ticket.ticketId, 0, 0);
    const ack = await f.transport.releaseRecovery(ticket, termination);
    assert.deepEqual(ack, { released: true, ticketId: ticket.ticketId, terminationId: termination.terminationId });
    assert.equal((await f.transport.status(ticket.ticketId)).phase, "forfeited");
    assert.equal((await f.roll(0)).status, 200); f.reopen();
    assert.equal(f.sql.exec("SELECT COUNT(*) AS n FROM encounter_origins_v1").toArray()[0].n, 0);
    assert.deepEqual(await f.transport.releaseRecovery(ticket, termination), ack);
    await assert.rejects(f.transport.start("earned"), /403/);
    await assert.rejects(f.transport.status(ticket.ticketId), /403/);
    await assert.rejects(f.transport.releaseRecovery(ticket, { ...termination, signature: "0".repeat(128) }), /409/);
    // Even when every origin is gone, losing metadata cannot reset spent starts.
    f.sql.exec("DELETE FROM encounter_generations_v1");
    await assert.rejects(f.transport.start("earned"), /generation fence/);
  } finally { f.db.close(); }
});

test("unacknowledged forfeits retain recovery, then late owner release deletes only that old origin", async () => {
  const f = await fixture(false, 2);
  try {
    await f.provision(0, "stopped"); const ticket = await f.transport.start("stopped");
    const termination = await f.transport.terminate(ticket.ticketId, "abandoned"); await f.transport.closureGrant(ticket.ticketId, 0, 0);
    await f.provision(0, "reward"); const reward = await f.settle(0, "reward"); await f.transport.pruneGrant(reward.ticket.ticketId, 0);
    assert.equal((await f.roll(0)).status, 200);
    assert.equal((await f.transport.start("stopped")).ticketId, ticket.ticketId);
    await f.transport.closureGrant(ticket.ticketId, 2, 1);
    await assert.rejects(f.transport.releaseRecovery(reward.ticket, termination), /409/);
    const stranger = (await f.backend.generateSigningKey()).signer;
    const other = new HttpEncounterTransport({ endpoint: "https://test/v1/pve/demo/encounter", unit: "demo", owner: stranger, cryptoBackend: f.backend, now: () => reward.ticket.releaseAt,
      fetch: async (url, init) => f.api.fetch(new Request(url, init)) });
    await assert.rejects(other.releaseRecovery(ticket, termination), /409/);
    await f.transport.releaseRecovery(ticket, termination);
    assert.equal(f.sql.exec("SELECT COUNT(*) AS n FROM encounter_origins_v1").toArray()[0].n, 1);
    const listing = await signEncounterListing(reward.receipt, reward.receipt.statement.items[0].assetId, f.owner, f.backend);
    assert.equal((await f.transport.admitToMarket(listing)).accepted, true);
    const cp = await f.transport.compactInventory(null, [reward.ticket.ticketId]);
    assert.equal((await f.transport.inventoryPage(cp.checkpointId)).records[0].ticket.ticketId, reward.ticket.ticketId);
  } finally { f.db.close(); }
});

test("release acknowledgment and terminal deletion roll back with their generation transaction", async () => {
  const f = await fixture();
  try {
    await f.provision(); const ticket = await f.transport.start("earned"); const termination = await f.transport.terminate(ticket.ticketId, "abandoned");
    await f.transport.closureGrant(ticket.ticketId, 0, 0);
    f.setFault(true); await assert.rejects(f.transport.releaseRecovery(ticket, termination), /409/); f.setFault(false);
    const ledger = new SqliteEncounterLedger(f.sql); assert.equal(ledger.byId(ticket.ticketId)!.recoveryReleased, undefined);
    await f.transport.releaseRecovery(ticket, termination);
    f.setFault(true); assert.equal((await f.roll(0)).status, 409); f.setFault(false);
    assert.equal(ledger.byId(ticket.ticketId)!.recoveryReleased, true); assert.equal(f.archive.minimumGeneration("demo"), 0);
    assert.equal((await f.roll(0)).status, 200); assert.equal(ledger.byId(ticket.ticketId), undefined);
    assert.deepEqual(await f.transport.releaseRecovery(ticket, termination), { released: true, ticketId: ticket.ticketId, terminationId: termination.terminationId });
  } finally { f.db.close(); }
});

test("recovery release checks live hold and asset state inside its write transaction", async () => {
  const f = await fixture();
  try {
    await f.provision(); const ticket = await f.transport.start("earned"); const termination = await f.transport.terminate(ticket.ticketId, "abandoned");
    await f.transport.closureGrant(ticket.ticketId, 0, 0); const ledger = new SqliteEncounterLedger(f.sql);
    let row = ledger.byId(ticket.ticketId)!;
    assert.equal(ledger.replace(row.revision, { ...row, revision: row.revision + 1, evidenceHold: true }), true);
    await assert.rejects(f.transport.releaseRecovery(ticket, termination), /409/);
    row = ledger.byId(ticket.ticketId)!;
    assert.equal(ledger.replace(row.revision, { ...row, revision: row.revision + 1, evidenceHold: false, admittedAssets: ["unexpected-asset"] }), true);
    await assert.rejects(f.transport.releaseRecovery(ticket, termination), /409/);
    row = ledger.byId(ticket.ticketId)!;
    assert.equal(ledger.replace(row.revision, { ...row, revision: row.revision + 1, admittedAssets: [] }), true);
    let entered!: () => void; let resume!: () => void; let held = false; let first = true;
    const verifying = new Promise<void>((resolve) => { entered = resolve; }); const release = new Promise<void>((resolve) => { resume = resolve; });
    const backend = { ...f.backend, verify: async (...args: Parameters<typeof f.backend.verify>) => {
      const ok = await f.backend.verify(...args); if (first) { first = false; entered(); await release; } return ok;
    } };
    const recovery = new SqliteEncounterRecovery({ sql: f.sql, ledger, backend, trustedKey: f.signer.publicKey,
      transaction: f.transaction, currentGeneration: () => 0, held: () => held, now: () => 1_000 });
    const pending = recovery.release("demo", f.owner.publicKey, { ticket, termination });
    await verifying; held = true; resume(); await assert.rejects(pending, /release refused/);
    assert.equal(ledger.byId(ticket.ticketId)!.recoveryReleased, undefined);
    await f.transport.releaseRecovery(ticket, termination); assert.equal((await f.roll(0)).status, 200);
  } finally { f.db.close(); }
});

test("all-forfeit generations leave no origin rows, and the no-archive adapter keeps a durable spent-start fence", async () => {
  const f = await fixture(false, 16);
  try {
    for (let generation = 0; generation < 8; generation++) {
      for (let i = 0; i < 16; i++) {
        const head = `stop-${i}`; assert.equal((await f.provision(generation, head)).status, 201);
        const ticket = await f.transport.start(head, generation); const termination = await f.transport.terminate(ticket.ticketId, "abandoned");
        await f.transport.closureGrant(ticket.ticketId, 0, 0); await f.transport.releaseRecovery(ticket, termination);
      }
      assert.equal((await f.roll(generation)).status, 200);
      assert.equal(f.sql.exec("SELECT COUNT(*) AS n FROM encounter_origins_v1").toArray()[0].n, 0);
      assert.equal(f.sql.exec("SELECT COUNT(*) AS n FROM encounter_tickets_v1").toArray()[0].n, 0);
    }
    assert.equal(f.sql.exec("SELECT COUNT(*) AS n FROM encounter_generation_floors_v1").toArray()[0].n, 1);
    f.sql.exec("DELETE FROM encounter_generations_v1");
    const noArchive = new EncounterHttpApi({ sql: f.sql, signer: f.signer, crypto, transaction: f.transaction, now: () => 1_000, retentionMs: 0, adminToken: "admin" });
    await assert.rejects(noArchive.fetch(new Request("https://test/v1/pve/demo/encounter-configuration")), /generation fence/);
  } finally { f.db.close(); }
});
