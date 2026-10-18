import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { IDBFactory } from "fake-indexeddb";
import { createStandardWebCryptoBackend } from "../../player-local-runtime/crypto-backend.ts";
import { IndexedDbAuditPayloadQueue } from "../web/src/audit/bounded-payload-queue.ts";
import { EncounterRecorder, type EncounterTransport } from "../web/src/audit/encounter-recorder.ts";
import { IndexedDbAuditPayloadPool } from "../web/src/audit/payload-pool.ts";
import {
  EncounterAuthority, SqliteEncounterLedger,
  createEncounterChunks, signEncounterCommit, signEncounterListing,
  verifyEncounterPruneGrant, verifyEncounterReceipt,
  verifyEncounterReveal,
  verifyEncounterTicket,
} from "../game/encounter/index.ts";

test("abandonment is durable and idempotent, cannot mint, and closes retained partial logs only after its hold window", async () => {
  const f = await fixture();
  try {
    const first = await f.authority.terminate(f.ticket.ticketId, "abandoned");
    f.setTime(20_000); f.restart();
    assert.deepEqual(await f.authority.terminate(f.ticket.ticketId, "expired"), first);
    assert.deepEqual(await f.authority.issue(f.authorization), f.ticket);
    await assert.rejects(f.authority.commit(f.commitment), /forfeited/);
    await assert.rejects(f.authority.reveal(f.ticket.ticketId), /commit/);
    await assert.rejects(f.authority.settle(f.ticket.ticketId, f.chunks), /reveal/);
    f.authority.setEvidenceHold(f.ticket.ticketId, true);
    await assert.rejects(f.authority.closureGrant(f.ticket.ticketId, 1, 1), /hold/);
    f.authority.setEvidenceHold(f.ticket.ticketId, false);
    const grant = await f.authority.closureGrant(f.ticket.ticketId, 1, 1);
    assert.equal(grant.closureId, first.terminationId);
    assert.throws(() => f.authority.setEvidenceHold(f.ticket.ticketId, true), /closed/);
    assert.deepEqual(await f.authority.terminate(f.ticket.ticketId, "abandoned"), first);
  } finally { f.db.close(); }
});

test("only missed uncommitted starts expire; a settled reward cannot be abandoned", async () => {
  const f = await fixture();
  try {
    await assert.rejects(f.authority.terminate(f.ticket.ticketId, "expired"), /expiry/);
    f.setTime(f.ticket.commitNotBefore); await f.authority.commit(f.commitment);
    f.setTime(f.ticket.releaseAt);
    await assert.rejects(f.authority.terminate(f.ticket.ticketId, "expired"), /expiry/);
    await f.authority.reveal(f.ticket.ticketId);
    f.setTime(f.ticket.issuedAt);
    await assert.rejects(f.authority.terminate(f.ticket.ticketId, "abandoned"), /clock/);
    f.setTime(f.ticket.releaseAt);
    await f.authority.settle(f.ticket.ticketId, f.chunks);
    await assert.rejects(f.authority.terminate(f.ticket.ticketId, "abandoned"), /settled/);
    const other = await f.authority.issue({ ...f.authorization, startHead: "unused-expired" });
    f.setTime(other.releaseAt);
    const expired = await f.authority.terminate(other.ticketId, "expired");
    assert.equal(expired.statement.reason, "expired");
  } finally { f.db.close(); }
});

test("durable CAS resolves settlement versus abandonment in either order, even while signing is suspended", async () => {
  for (const winner of ["settle", "terminate"] as const) {
    const f = await fixture();
    let proceed!: () => void; let entered!: () => void;
    const gate = new Promise<void>((resolve) => { proceed = resolve; });
    const started = new Promise<void>((resolve) => { entered = resolve; });
    try {
      f.setTime(f.ticket.commitNotBefore); await f.authority.commit(f.commitment);
      f.setTime(f.ticket.releaseAt); await f.authority.reveal(f.ticket.ticketId);
      const suspended = new EncounterAuthority({ ledger: f.ledger, crypto, now: () => f.ticket.releaseAt, retentionMs: 10_000,
        signer: { publicKey: f.authorityKey.signer.publicKey, scheme: "ed25519-v1",
          async signDigest(digest) { entered(); await gate; return f.authorityKey.signer.signDigest(digest); } } });
      const pending = winner === "settle" ? suspended.terminate(f.ticket.ticketId, "abandoned") : suspended.settle(f.ticket.ticketId, f.chunks);
      const refused = assert.rejects(pending, /settled|changed/);
      await started;
      if (winner === "settle") await f.authority.settle(f.ticket.ticketId, f.chunks);
      else await f.authority.terminate(f.ticket.ticketId, "abandoned");
      proceed(); await refused;
      const row = f.ledger.byId(f.ticket.ticketId)!;
      assert.equal(row.phase, winner === "settle" ? "settled" : "forfeited");
      assert.equal(Boolean(row.receipt), winner === "settle");
      assert.equal(Boolean(row.termination), winner !== "settle");
    } finally { proceed?.(); f.db.close(); }
  }
});

test("preflight reserves the entire log before issuing a ticket and retries reuse the same credit", async () => {
  const f = await fixture();
  const pool = await IndexedDbAuditPayloadPool.open({ factory: f.factory, name: `reserved-${f.name}`,
    limits: { maxBytes: 8_192, reservedBytes: 0, maxItems: 2, maxItemBytes: 4_096 }, maxQueues: 2 });
  let starts = 0;
  const options = { factory: f.factory, payloadPool: pool, authorization: f.authorization,
    trustedAuthorityKey: f.authorityKey.signer.publicKey, owner: f.owner, cryptoBackend: f.cryptoBackend,
    transport: { ...f.transport, async start() {
      starts++;
      assert.equal((await pool.snapshot()).reservedPayloadBytes, 8_192);
      return f.authority.issue(f.authorization);
    } } };
  try {
    const first = await EncounterRecorder.start(options); first.close();
    const retry = await EncounterRecorder.start(options);
    assert.equal((await pool.snapshot()).reservedPayloadBytes, 8_192);
    assert.equal((await pool.snapshot()).queueCount, 1);
    await retry.recordChunk(0, f.frames.slice(0, 30));
    await retry.recordChunk(1, f.frames.slice(30));
    assert.equal((await pool.snapshot()).reservedPayloadBytes, 0);
    retry.close();
    let deniedStarts = 0;
    await assert.rejects(EncounterRecorder.start({ ...options,
      authorization: { ...f.authorization, startHead: "trusted-start-next" },
      transport: { ...f.transport, async start() { deniedStarts++; return f.ticket; } },
    }), /capacity/);
    assert.equal(deniedStarts, 0); assert.equal(starts, 2);
  } finally { pool.close(); f.db.close(); }
});

test("a signed ticket binds its clock, start, owner and queue; a modified ticket cannot start recording", async () => {
  const f = await fixture();
  try {
    assert.equal(await verifyEncounterTicket(f.ticket, f.authorityKey.signer.publicKey, f.cryptoBackend), true);
    for (const change of [{ releaseAt: f.ticket.releaseAt + 1 }, { queueId: "forged-queue" },
      { ownerPublicKey: "a".repeat(64) }, { startHead: "invented-start" }, { seedCommitment: "b".repeat(64) }]) {
      const ticket = { ...f.ticket, ...change };
      assert.equal(await verifyEncounterTicket(ticket, f.authorityKey.signer.publicKey, f.cryptoBackend), false);
      await assert.rejects(EncounterRecorder.open({ factory: f.factory, name: f.name, ticket,
        trustedAuthorityKey: f.authorityKey.signer.publicKey, owner: f.owner, cryptoBackend: f.cryptoBackend,
        transport: f.transport }), /ticket/);
    }
  } finally { f.db.close(); }
});

test("an ambiguous start timeout retains its reservation and retries the same consumed start", async () => {
  const f = await fixture();
  const pool = await IndexedDbAuditPayloadPool.open({ factory: f.factory, name: `timeout-${f.name}`,
    limits: { maxBytes: 8_192, reservedBytes: 0, maxItems: 2, maxItemBytes: 4_096 }, maxQueues: 1 });
  let fail = true;
  const options = { factory: f.factory, payloadPool: pool, authorization: f.authorization,
    owner: f.owner, cryptoBackend: f.cryptoBackend, trustedAuthorityKey: f.authorityKey.signer.publicKey,
    transport: { ...f.transport, async start() {
      const ticket = await f.authority.issue(f.authorization);
      if (fail) throw new Error("network timeout after issuance");
      return ticket;
    } } };
  try {
    await assert.rejects(EncounterRecorder.start(options), /timeout/);
    assert.equal((await pool.snapshot()).reservedPayloadBytes, 8_192);
    fail = false;
    const retry = await EncounterRecorder.start(options);
    assert.equal((await pool.snapshot()).queueCount, 1);
    assert.equal((await pool.snapshot()).reservedPayloadBytes, 8_192);
    assert.deepEqual(await f.authority.issue(f.authorization), f.ticket);
    retry.close();
  } finally { pool.close(); f.db.close(); }
});

async function fixture(path = ":memory:") {
  const cryptoBackend = createStandardWebCryptoBackend(crypto);
  const authorityKey = await cryptoBackend.generateSigningKey();
  const owner = (await cryptoBackend.generateSigningKey()).signer;
  let db = new DatabaseSync(path);
  const sql = { exec(query: string, ...args: (string | number | null)[]) {
    const statement = db.prepare(query);
    const rows = statement.all(...args);
    return { toArray: () => rows };
  } };
  const ledger = new SqliteEncounterLedger(sql);
  let now = 1_000;
  const restart = () => new EncounterAuthority({ ledger, signer: authorityKey.signer,
    crypto, now: () => now, retentionMs: 10_000 });
  let authority = restart();
  const authorization = { unit: "demo", startHead: "trusted-start-1", playerId: "alice",
    ownerPublicKey: owner.publicKey };
  const ticket = await authority.issue(authorization);
  const frames = Array.from({ length: 60 }, (_, index) => ({ tick: index + 1,
    horizontal: (index >= 30 && index < 40 ? 1 : 0) as 0 | 1, vertical: 0 as const }));
  const chunks = await createEncounterChunks(ticket, frames, cryptoBackend);
  const commitment = await signEncounterCommit(ticket, chunks, owner, cryptoBackend);
  const factory = new IDBFactory();
  const name = `encounter-${ticket.ticketId}`;
  const openQueue = () => IndexedDbAuditPayloadQueue.open({ factory, name,
    queueId: ticket.queueId,
    limits: { maxBytes: 16_384, maxItems: 2, maxItemBytes: 4_096, reservedBytes: 8_192 },
    verifyPruneGrant: (grant) => verifyEncounterPruneGrant(grant, authorityKey.signer.publicKey, cryptoBackend),
  });
  const transport: EncounterTransport = {
    commit: (c) => authority.commit(c), reveal: (id) => authority.reveal(id),
    settle: (id, chunks) => authority.settle(id, chunks),
    admitToMarket: (listing) => authority.admitToMarket(listing),
    pruneGrant: (id, revision) => authority.pruneGrant(id, revision),
  };
  const openRecorder = (override?: EncounterTransport) => EncounterRecorder.open({ factory, name, ticket,
    trustedAuthorityKey: authorityKey.signer.publicKey, owner, cryptoBackend,
    transport: override ?? transport });
  return { get db() { return db; }, ledger, owner, ticket, frames, chunks, commitment, openQueue, openRecorder, authorization,
    cryptoBackend, authorityKey, transport, factory, name,
    get authority() { return authority; },
    setTime(value: number) { now = value; },
    restart() { authority = restart(); },
    reopenDatabase() { db.close(); db = new DatabaseSync(path); authority = restart(); },
  };
}

test("record → commit → reveal → real game replay → market → authenticated prune survives restart", async () => {
  const f = await fixture();
  let recorder = await f.openRecorder();
  assert.equal(await recorder.recordChunk(0, f.frames.slice(0, 30)), "stored");
  assert.equal(await recorder.recordChunk(1, f.frames.slice(30)), "stored");
  assert.equal((await recorder.snapshot()).itemCount, 2);
  recorder.close();
  recorder = await f.openRecorder();
  f.setTime(f.ticket.commitNotBefore);
  await recorder.commit();
  f.restart();
  f.setTime(f.ticket.releaseAt);
  const reveal = await f.authority.reveal(f.ticket.ticketId);
  assert.equal(reveal.root, f.commitment.root);
  assert.equal(await verifyEncounterReveal(f.ticket, f.commitment, reveal, f.cryptoBackend), true);
  assert.equal(await verifyEncounterReveal(f.ticket, f.commitment, { ...reveal, seed: "0".repeat(64) }, f.cryptoBackend), false);
  const receipt = await recorder.settle();
  assert.equal(receipt.statement.items.length, 1);
  assert.equal(await verifyEncounterReceipt(receipt, f.authorityKey.signer.publicKey, f.cryptoBackend), true);
  const item = receipt.statement.items[0];
  assert.deepEqual(await recorder.admitToMarket(receipt, item.assetId), { accepted: true, assetId: item.assetId });
  await assert.rejects(recorder.prune(), /retention/);
  f.setTime(receipt.statement.retentionUntil);
  assert.equal(await recorder.prune(), "pruned");
  assert.equal((await recorder.snapshot()).usedBytes, 0);
  assert.equal((await recorder.snapshot()).itemCount, 0);
  recorder.close();
  f.restart();
  recorder = await f.openRecorder();
  const restoredReceipt = await recorder.restoreReceipt();
  assert.deepEqual(restoredReceipt, receipt);
  assert.deepEqual(await recorder.admitToMarket(restoredReceipt, item.assetId), { accepted: true, assetId: item.assetId });
  assert.deepEqual(await f.authority.settle(f.ticket.ticketId, []), receipt);
  recorder.close(); f.db.close();
});

test("recorders for different tickets charge one application pool and release finalized metadata", async () => {
  const f = await fixture();
  const pool = await IndexedDbAuditPayloadPool.open({ factory: f.factory, name: `shared-${f.name}`,
    limits: { maxBytes: 1_000, reservedBytes: 0, maxItems: 4, maxItemBytes: 4_096 }, maxQueues: 2 });
  const secondTicket = await f.authority.issue({ ...f.authorization, startHead: "trusted-start-2" });
  const open = (ticket = f.ticket) => EncounterRecorder.open({ factory: f.factory, payloadPool: pool, ticket,
    trustedAuthorityKey: f.authorityKey.signer.publicKey, owner: f.owner, cryptoBackend: f.cryptoBackend, transport: f.transport });
  const first = await open(); const second = await open(secondTicket);
  try {
    await first.recordChunk(0, f.frames.slice(0, 30)); await first.recordChunk(1, f.frames.slice(30));
    assert.equal(await second.recordChunk(0, f.frames.slice(0, 30)), "stored");
    assert.equal(await second.recordChunk(1, f.frames.slice(30)), "backpressure");
    assert.ok((await pool.snapshot()).usedBytes <= 1_000);
    f.setTime(f.ticket.commitNotBefore); await first.commit();
    f.setTime(f.ticket.releaseAt); const receipt = await first.settle();
    f.setTime(receipt.statement.retentionUntil); await first.prune();
    assert.equal(await first.release(), "released");
    assert.equal((await pool.snapshot()).queueCount, 1);
    const recovered = await EncounterRecorder.recoverReceipt({ ticket: f.ticket,
      trustedAuthorityKey: f.authorityKey.signer.publicKey, cryptoBackend: f.cryptoBackend, transport: f.transport });
    assert.deepEqual(recovered, receipt);
    assert.equal((await pool.snapshot()).queueCount, 1); // recovery never allocates a queue
  } finally { first.close(); second.close(); pool.close(); f.db.close(); }
});

test("the client refuses partial logs and forged reveals before requesting settlement", async () => {
  const f = await fixture();
  const recorder = await f.openRecorder({ ...f.transport,
    async reveal(id) { return { ...await f.authority.reveal(id), seed: "0".repeat(64) }; } });
  try {
    await recorder.recordChunk(0, f.frames.slice(0, 30));
    f.setTime(f.ticket.commitNotBefore);
    await assert.rejects(recorder.commit(), /complete/);
    await recorder.recordChunk(1, f.frames.slice(30));
    await recorder.commit();
    f.setTime(f.ticket.releaseAt);
    await assert.rejects(recorder.settle(), /reveal/);
    assert.equal(f.ledger.byId(f.ticket.ticketId)!.receipt, undefined);
    assert.equal((await recorder.snapshot()).itemCount, 2);
  } finally { recorder.close(); f.db.close(); }
});

test("a modified receipt is rejected by the client and cannot discard the retained evidence", async () => {
  const f = await fixture();
  const recorder = await f.openRecorder({ ...f.transport,
    async settle(id, chunks) {
      const receipt = await f.authority.settle(id, chunks);
      return { ...receipt, statement: { ...receipt.statement, root: "0".repeat(64) } };
    } });
  try {
    await recorder.recordChunk(0, f.frames.slice(0, 30));
    await recorder.recordChunk(1, f.frames.slice(30));
    f.setTime(f.ticket.commitNotBefore); await recorder.commit();
    f.setTime(f.ticket.releaseAt);
    await assert.rejects(recorder.settle(), /receipt/);
    assert.equal((await recorder.snapshot()).usedBytes > 0, true);
    assert.equal((await recorder.snapshot()).itemCount, 2);
  } finally { recorder.close(); f.db.close(); }
});

test("closing and reopening SQLite preserves the committed seed, spent start and final receipt", async () => {
  const directory = mkdtempSync(join(tmpdir(), "encounter-ledger-"));
  const f = await fixture(join(directory, "ledger.sqlite"));
  try {
    f.setTime(f.ticket.commitNotBefore); await f.authority.commit(f.commitment);
    f.reopenDatabase();
    assert.deepEqual(await f.authority.issue(f.authorization), f.ticket);
    f.setTime(f.ticket.releaseAt);
    const reveal = await f.authority.reveal(f.ticket.ticketId);
    assert.equal(await verifyEncounterReveal(f.ticket, f.commitment, reveal, f.cryptoBackend), true);
    const receipt = await f.authority.settle(f.ticket.ticketId, f.chunks);
    f.reopenDatabase();
    assert.deepEqual(await f.authority.reveal(f.ticket.ticketId), reveal);
    assert.deepEqual(await f.authority.settle(f.ticket.ticketId, []), receipt);
  } finally { f.db.close(); rmSync(directory, { recursive: true }); }
});

test("a matching digest cannot make impossible ticks or axes into a valid game history", async () => {
  for (const invalidTuple of [[2, 0, 0], [1, 2, 0]]) {
    const f = await fixture();
    try {
      const chunks = f.chunks.map((c) => ({ ...c, payload: c.payload.slice() }));
      const value = JSON.parse(new TextDecoder().decode(chunks[0].payload));
      value[3][0] = invalidTuple;
      const text = JSON.stringify(value);
      chunks[0].payload = new TextEncoder().encode(text);
      chunks[0].checkpointDigest = await f.cryptoBackend.hashString(text);
      const commitment = await signEncounterCommit(f.ticket, chunks, f.owner, f.cryptoBackend);
      f.setTime(f.ticket.commitNotBefore); await f.authority.commit(commitment);
      f.setTime(f.ticket.releaseAt); await f.authority.reveal(f.ticket.ticketId);
      await assert.rejects(f.authority.settle(f.ticket.ticketId, chunks), /log/);
      assert.equal(f.ledger.byId(f.ticket.ticketId)!.receipt, undefined);
    } finally { f.db.close(); }
  }
});

test("forfeiting burns the start, and a different signing key cannot take over stored tickets", async () => {
  const f = await fixture();
  f.authority.forfeit(f.ticket.ticketId);
  f.setTime(f.ticket.commitNotBefore);
  await assert.rejects(f.authority.commit(f.commitment), /forfeited/);
  assert.deepEqual(await f.authority.issue(f.authorization), f.ticket);
  const otherKey = (await f.cryptoBackend.generateSigningKey()).signer;
  const differentAuthority = new EncounterAuthority({ ledger: f.ledger, signer: otherKey,
    crypto, now: () => f.ticket.releaseAt, retentionMs: 10_000 });
  await assert.rejects(differentAuthority.issue(f.authorization), /authority/);
  await assert.rejects(differentAuthority.reveal(f.ticket.ticketId), /authority/);
  f.db.close();
});

test("one trusted start cannot acquire another seed or a replacement owner, including concurrent issuance", async () => {
  const f = await fixture();
  const [a, b] = await Promise.all([f.authority.issue(f.authorization), f.authority.issue(f.authorization)]);
  assert.deepEqual(a, f.ticket); assert.deepEqual(b, f.ticket);
  await assert.rejects(f.authority.issue({ ...f.authorization, ownerPublicKey: "a".repeat(64) }), /start/);
  assert.equal("secret" in f.ticket, false);
  assert.equal("seed" in f.ticket, false);
  f.setTime(f.ticket.releaseAt);
  await assert.rejects(f.authority.reveal(f.ticket.ticketId), /commit/);
  await assert.rejects(f.authority.commit(f.commitment), /commit/);
  assert.deepEqual(await f.authority.issue(f.authorization), f.ticket);
  f.db.close();
});

test("clock gates, owner authentication and immutable committed roots reject early release and grinding", async () => {
  const f = await fixture();
  await assert.rejects(f.authority.commit(f.commitment), /commit/);
  f.setTime(f.ticket.commitNotBefore);
  await assert.rejects(f.authority.commit({ ...f.commitment, ownerSignature: "0".repeat(128) }), /signature/);
  await f.authority.commit(f.commitment);
  await assert.rejects(f.authority.reveal(f.ticket.ticketId), /release/);
  const otherChunks = await createEncounterChunks(f.ticket, f.frames.map((x) => ({ ...x, vertical: 1 })), f.cryptoBackend);
  const other = await signEncounterCommit(f.ticket, otherChunks, f.owner, f.cryptoBackend);
  await assert.rejects(f.authority.commit(other), /root/);
  f.setTime(f.ticket.releaseAt);
  const [a, b] = await Promise.all([f.authority.reveal(f.ticket.ticketId), f.authority.reveal(f.ticket.ticketId)]);
  assert.deepEqual(a, b);
  await f.authority.commit(f.commitment); // idempotent receipt, no new choice
  await assert.rejects(f.authority.commit(other), /root/);
  f.db.close();
});

test("only the pinned, complete, valid input log can mint; concurrent settlement returns one receipt", async () => {
  const f = await fixture();
  f.setTime(f.ticket.commitNotBefore); await f.authority.commit(f.commitment);
  await assert.rejects(f.authority.settle(f.ticket.ticketId, f.chunks), /reveal/);
  f.setTime(f.ticket.releaseAt); await f.authority.reveal(f.ticket.ticketId);
  const corrupted = f.chunks.map((chunk) => ({ ...chunk, payload: chunk.payload.slice() }));
  corrupted[0].payload[0] ^= 1;
  await assert.rejects(f.authority.settle(f.ticket.ticketId, corrupted), /log/);
  await assert.rejects(f.authority.settle(f.ticket.ticketId, f.chunks.slice(1)), /log/);
  const [a, b] = await Promise.all([f.authority.settle(f.ticket.ticketId, f.chunks), f.authority.settle(f.ticket.ticketId, f.chunks)]);
  assert.deepEqual(a, b);
  assert.equal(a.statement.items.length, 1);
  assert.match(a.statement.items[0].assetId, new RegExp(f.ticket.ticketId));
  const listing = await signEncounterListing(a, a.statement.items[0].assetId, f.owner, f.cryptoBackend);
  await assert.rejects(f.authority.admitToMarket({ ...listing, assetId: "invented" }), /item/);
  await assert.rejects(f.authority.admitToMarket({ ...listing, ownerSignature: "0".repeat(128) }), /signature/);
  f.db.close();
});

test("unresolved evidence blocks pruning; signed grants cannot be moved or edited", async () => {
  const f = await fixture(); const queue = await f.openQueue();
  for (const chunk of f.chunks) await queue.append(chunk);
  f.setTime(f.ticket.commitNotBefore); await f.authority.commit(f.commitment);
  f.setTime(f.ticket.releaseAt); await f.authority.reveal(f.ticket.ticketId);
  const receipt = await f.authority.settle(f.ticket.ticketId, f.chunks);
  f.authority.setEvidenceHold(f.ticket.ticketId, true);
  const listing = await signEncounterListing(receipt, receipt.statement.items[0].assetId, f.owner, f.cryptoBackend);
  await assert.rejects(f.authority.admitToMarket(listing), /hold/);
  f.setTime(receipt.statement.retentionUntil);
  await assert.rejects(f.authority.pruneGrant(f.ticket.ticketId, 2), /hold/);
  f.authority.setEvidenceHold(f.ticket.ticketId, false);
  const grant = await f.authority.pruneGrant(f.ticket.ticketId, 2);
  assert.equal(await queue.prune({ ...grant, throughCheckpointDigest: "a".repeat(64) }), "refused");
  assert.equal(await queue.prune({ ...grant, expectedRevision: 3 }), "refused");
  assert.equal(await queue.prune({ ...grant, queueId: "other-generation" }), "refused");
  assert.throws(() => f.authority.setEvidenceHold(f.ticket.ticketId, true), /closed/);
  assert.equal(await queue.prune(grant), "pruned");
  queue.close(); f.db.close();
});
