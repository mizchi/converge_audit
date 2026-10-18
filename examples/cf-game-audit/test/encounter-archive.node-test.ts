import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { IDBFactory } from "fake-indexeddb";
import { createStandardWebCryptoBackend } from "../../player-local-runtime/crypto-backend.ts";
import { SqliteEncounterArchive, type EncounterArchiveOptions } from "../game/encounter/archive-store.ts";
import { verifyArchiveCustody, verifyArchivedBundle } from "../game/encounter/archive.ts";
import { EncounterAuthority, SqliteEncounterLedger, decodeEncounterLog, frame } from "../game/encounter/index.ts";
import { advanceGame, createInitialGame } from "../game/kernel.ts";
import { EncounterRecorder } from "../web/src/audit/encounter-recorder.ts";
import { IndexedDbAuditPayloadPool } from "../web/src/audit/payload-pool.ts";

async function fixture(maxBytes = 16_384, maxObjects = 2) {
  const db = new DatabaseSync(":memory:"); const remote = new DatabaseSync(":memory:");
  const sql = (database: DatabaseSync) => ({ exec(query: string, ...args: (string | number | null)[]) { const rows = database.prepare(query).all(...args); return { toArray: () => rows }; } });
  const backend = createStandardWebCryptoBackend(crypto); const signer = (await backend.generateSigningKey()).signer;
  const archiveKey = (await backend.generateSigningKey()).signer; let archiveSignatures = 0;
  const archiveSigner = { publicKey: archiveKey.publicKey, scheme: archiveKey.scheme, async signDigest(value: string) { archiveSignatures++; return archiveKey.signDigest(value); } };
  const owner = (await backend.generateSigningKey()).signer;
  let now = 1_000; let fail = false; let loseReply = false;
  const transaction = <T>(body: () => T): T => { remote.exec("BEGIN"); try { const result = body(); remote.exec("COMMIT"); return result; } catch (e) { remote.exec("ROLLBACK"); throw e; } };
  const archiveOptions: EncounterArchiveOptions = { sql: sql(remote), transaction, signer: archiveSigner, trustedAuthorityKey: signer.publicKey,
    crypto, now: () => now, maxBytes, maxObjects, injectWriteFault: () => { if (fail) throw new Error("archive write failure"); } };
  const archive = new SqliteEncounterArchive(archiveOptions);
  const ledger = new SqliteEncounterLedger(sql(db));
  const authority = new EncounterAuthority({ ledger, signer, crypto, now: () => now, retentionMs: 10_000, trustedArchiveKey: archive.publicKey });
  const ticket = await authority.issue({ unit: "demo", startHead: "earned", playerId: "alice", ownerPublicKey: owner.publicKey });
  const factory = new IDBFactory(); const pool = await IndexedDbAuditPayloadPool.open({ factory, name: crypto.randomUUID(),
    limits: { maxBytes: 8_192, reservedBytes: 0, maxItems: 2, maxItemBytes: 4_096 }, maxQueues: 1 });
  const transport = { commit: authority.commit.bind(authority), reveal: authority.reveal.bind(authority), settle: authority.settle.bind(authority),
    admitToMarket: authority.admitToMarket.bind(authority), pruneGrant: authority.pruneGrant.bind(authority),
    async archiveUpload(id: string, chunks: Parameters<EncounterAuthority["settle"]>[1]) {
      const row = ledger.byId(id)!;
      const custody = await archive.store({ ticket: row.ticket, commitment: row.commitment!, reveal: row.reveal!, receipt: row.receipt!, chunks: chunks.map((c) => ({ ...c, payload: c.payload.slice() })) });
      if (loseReply) { loseReply = false; throw new Error("lost archive acknowledgement"); }
      await authority.acceptArchive(id, custody); return custody;
    }, archiveHandoff: authority.archiveHandoff.bind(authority) };
  const recorder = await EncounterRecorder.open({ factory, payloadPool: pool, ticket, owner, cryptoBackend: backend,
    trustedAuthorityKey: signer.publicKey, trustedArchiveKey: archive.publicKey, transport });
  const frames = Array.from({ length: 60 }, (_, i) => ({ tick: i + 1, horizontal: (i >= 30 && i < 40 ? 1 : 0) as 0 | 1, vertical: 0 as const }));
  await recorder.recordChunk(0, frames.slice(0, 30)); await recorder.recordChunk(1, frames.slice(30));
  now = ticket.commitNotBefore; await recorder.commit(); now = ticket.releaseAt; const receipt = await recorder.settle();
  return { db, remote, backend, signer, ledger, authority, archive, recorder, pool, ticket, receipt,
    get archiveSignatures() { return archiveSignatures; },
    reopen() { return new SqliteEncounterArchive(archiveOptions); },
    loseNextReply() { loseReply = true; },
    failWrites(value: boolean) { fail = value; }, setTime(t: number) { now = t; }, close() { recorder.close(); pool.close(); db.close(); remote.close(); } };
}

test("verified archive custody releases only the local log while holds and remote replay evidence survive", async () => {
  const f = await fixture();
  try {
    f.authority.setEvidenceHold(f.ticket.ticketId, true);
    const custody = await f.recorder.archive();
    assert.equal(await verifyArchiveCustody(custody, f.archive.publicKey, f.backend), true);
    assert.equal(await f.recorder.cleanupArchived(custody), "released");
    assert.equal((await f.pool.snapshot()).queueCount, 0);
    assert.equal(f.ledger.byId(f.ticket.ticketId)!.retentionReleased, false);
    assert.equal(f.ledger.byId(f.ticket.ticketId)!.evidenceHold, true);
    const stored = f.archive.read(f.ticket.ticketId)!;
    assert.equal(stored.bundle!.chunks.length, 2); assert.deepEqual(stored.custody, custody);
    assert.equal(await verifyArchivedBundle(custody, stored.bundle!, f.signer.publicKey, f.archive.publicKey, f.backend), true);
    const b = stored.bundle!;
    const seed = await f.backend.hashString(frame("encounter-game-seed-v1", f.ticket.ticketId, b.reveal.seed));
    let replayed = createInitialGame({ seed: Number.parseInt(seed.slice(0, 8), 16), playerId: f.ticket.playerId });
    for (const input of await decodeEncounterLog(b.ticket, b.commitment, b.chunks, f.backend)) {
      const next = advanceGame(replayed, input); assert.equal(next.ok, true); replayed = next.state;
    }
    assert.equal(await f.backend.hashString(frame("encounter-final-state-v1", f.ticket.ticketId, replayed)), f.receipt.statement.finalStateDigest);
    stored.bundle!.chunks[0].payload[5] ^= 1;
    assert.equal(await verifyArchivedBundle(custody, stored.bundle!, f.signer.publicKey, f.archive.publicKey, f.backend), false);
    await assert.rejects(f.authority.archiveRelease(f.ticket.ticketId), /retention|hold/);
    f.setTime(f.receipt.statement.retentionUntil);
    await assert.rejects(f.authority.archiveRelease(f.ticket.ticketId), /hold/);
    f.authority.setEvidenceHold(f.ticket.ticketId, false);
    const release = await f.authority.archiveRelease(f.ticket.ticketId);
    await f.archive.release(release);
    assert.equal(f.archive.read(f.ticket.ticketId)!.bundle, null);
    assert.equal(f.archive.snapshot().usedBytes, 0); assert.equal(f.archive.snapshot().totalObjects, 1);
    assert.throws(() => f.authority.setEvidenceHold(f.ticket.ticketId, true), /closed/);
    assert.deepEqual(await f.archive.release(release), release);
  } finally { f.close(); }
});
test("a lost archive acknowledgement leaves local evidence and retries recover the same durable custody", async () => {
  const f = await fixture();
  try {
    f.authority.setEvidenceHold(f.ticket.ticketId, true); f.loseNextReply();
    await assert.rejects(f.recorder.archive(), /lost/);
    assert.equal((await f.pool.snapshot()).itemCount, 2); assert.equal(f.ledger.byId(f.ticket.ticketId)!.archiveCustody, undefined);
    const durable = f.reopen().read(f.ticket.ticketId)!; const bytes = f.archive.snapshot().usedBytes; const signatures = f.archiveSignatures;
    const retried = await f.recorder.archive(); assert.deepEqual(retried, durable.custody);
    assert.equal(f.archiveSignatures, signatures); assert.equal(f.archive.snapshot().usedBytes, bytes);
    assert.equal(await f.recorder.cleanupArchived(retried), "released");
    assert.equal(f.ledger.byId(f.ticket.ticketId)!.evidenceHold, true); assert.equal(f.archive.snapshot().totalObjects, 1);
  } finally { f.close(); }
});
test("missing durable accounting is never reset while archive objects remain", async () => {
  const f = await fixture();
  try {
    await f.recorder.archive(); f.remote.exec("DELETE FROM encounter_archive_budget_v1");
    assert.throws(() => f.reopen(), /accounting/);
  } finally { f.close(); }
});
test("archive release failures retain replay data and retries never refund the lifetime object slot", async () => {
  const f = await fixture(16_384, 1);
  try {
    const custody = await f.recorder.archive(); const bundle = f.archive.read(f.ticket.ticketId)!.bundle!;
    f.setTime(f.receipt.statement.retentionUntil); const release = await f.authority.archiveRelease(f.ticket.ticketId);
    await assert.rejects(f.archive.release({ ...release, signature: "0".repeat(128) }), /release/);
    f.failWrites(true); await assert.rejects(f.archive.release(release), /failure/);
    assert.ok(f.archive.read(f.ticket.ticketId)!.bundle); assert.equal(f.archive.snapshot().usedBytes, custody.statement.storedBytes);
    f.failWrites(false); await f.archive.release(release);
    assert.equal(f.reopen().snapshot().totalObjects, 1);
    await assert.rejects(f.archive.store(bundle), /released/);
    assert.equal(f.archive.snapshot().usedBytes, 0); assert.equal(f.archive.snapshot().totalObjects, 1);
  } finally { f.close(); }
});
test("archive backpressure leaves the complete local replay log intact", async () => {
  const f = await fixture(1);
  try {
    await assert.rejects(f.recorder.archive(), /capacity/);
    assert.equal(f.archive.snapshot().totalObjects, 0); assert.equal(f.archive.snapshot().usedBytes, 0);
    assert.equal((await f.pool.snapshot()).itemCount, 2);
    await assert.rejects(f.authority.archiveHandoff(f.ticket.ticketId, 2, 2), /custody/);
  } finally { f.close(); }
});
test("failed archive persistence, forged custody and retargeted bindings never authorize a local handoff", async () => {
  const f = await fixture();
  try {
    f.failWrites(true); await assert.rejects(f.recorder.archive(), /failure/);
    assert.equal(f.archive.read(f.ticket.ticketId), undefined); assert.equal(f.archive.snapshot().usedBytes, 0);
    assert.equal(f.ledger.byId(f.ticket.ticketId)!.archiveCustody, undefined);
    await assert.rejects(f.authority.archiveHandoff(f.ticket.ticketId, 2, 2), /custody/);
    assert.equal((await f.pool.snapshot()).itemCount, 2);
    f.failWrites(false); const custody = await f.recorder.archive();
    await assert.rejects(f.recorder.cleanupArchived({ ...custody, signature: "0".repeat(128) }), /custody/);
    await assert.rejects(f.authority.acceptArchive(f.ticket.ticketId, { ...custody, statement: { ...custody.statement, root: "0".repeat(64) } }), /custody/);
    assert.equal((await f.pool.snapshot()).itemCount, 2);
    const signatures = f.archiveSignatures;
    assert.deepEqual(await f.recorder.archive(), custody);
    assert.equal(f.archiveSignatures, signatures);
    assert.equal(f.archive.snapshot().totalObjects, 1);
  } finally { f.close(); }
});
