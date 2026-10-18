import assert from "node:assert/strict";
import test from "node:test";
import { IDBFactory } from "fake-indexeddb";
import { IndexedDbAuditPayloadPool } from "../web/src/audit/payload-pool.ts";
import type { PayloadPruneGrant } from "../web/src/audit/bounded-payload-queue.ts";
import { IndexedDbAuditPayloadQueue } from "../web/src/audit/bounded-payload-queue.ts";

const limits = { maxBytes: 12, reservedBytes: 2, maxItems: 3, maxItemBytes: 8 };
const local = { maxBytes: 20, reservedBytes: 2, maxItems: 4, maxItemBytes: 8 };
const checkpoint = "a".repeat(64);
const chunk = (sequence: number, bytes = 5) => ({ sequence, checkpointDigest: checkpoint, payload: new Uint8Array(bytes).fill(sequence) });
const scope = (queueId: string, overrides = {}) => ({ queueId, limits: local,
  verifyPruneGrant: async (grant: Readonly<PayloadPruneGrant>) => grant.authorization === "trusted-test-grant", ...overrides });
const grant = (queueId: string, expectedRevision: number, throughSequence = 0): PayloadPruneGrant => ({
  queueId, expectedRevision, throughSequence, throughCheckpointDigest: checkpoint,
  deliveryAcknowledged: true, gameplayFinalized: true, retentionClosed: true,
  unresolvedReference: false, authorization: "trusted-test-grant",
});
async function fixture(options: { maxQueues?: number; injectWriteFault?: () => void } = {}) {
  const factory = new IDBFactory(); const name = `payload-pool-${crypto.randomUUID()}`;
  const open = () => IndexedDbAuditPayloadPool.open({ factory, name, limits, maxQueues: 3, ...options });
  return { factory, name, open, pool: await open() };
}

test("different encounter queues share one byte budget across connections and restart", async () => {
  const f = await fixture(); const second = await f.open();
  const a = await f.pool.queue(scope("a")); const b = await second.queue(scope("b"));
  assert.equal(await a.append(chunk(0)), "stored");
  assert.equal(await b.append(chunk(0)), "stored");
  assert.equal(await a.append(chunk(1, 1)), "backpressure");
  assert.equal((await f.pool.snapshot()).usedBytes, 10);
  f.pool.close(); second.close();
  const restored = await f.open();
  assert.equal((await restored.snapshot()).itemCount, 2);
  assert.equal(await (await restored.queue(scope("a"))).append(chunk(1, 1)), "backpressure");
  restored.close();
});

test("the scope and pool limits are independently enforced", async () => {
  const f = await fixture();
  const a = await f.pool.queue(scope("a", { limits: { ...local, maxBytes: 7 } }));
  const b = await f.pool.queue(scope("b"));
  assert.equal(await a.append(chunk(0)), "stored");
  assert.equal(await a.append(chunk(1, 1)), "backpressure");
  assert.equal(await b.append(chunk(0)), "stored");
  assert.equal((await f.pool.snapshot()).usedBytes, 10);
  f.pool.close();
});

test("tiny chunks are bounded by global item count even when bytes remain", async () => {
  const f = await fixture(); const a = await f.pool.queue(scope("a")); const b = await f.pool.queue(scope("b"));
  await a.append(chunk(0, 1)); await b.append(chunk(0, 1)); await a.append(chunk(1, 1));
  assert.equal(await b.append(chunk(1, 1)), "backpressure");
  assert.equal((await f.pool.snapshot()).usedBytes, 3);
  f.pool.close();
});

test("concurrent writes in distinct tabs cannot both spend the last free bytes", async () => {
  const f = await fixture(); const second = await f.open();
  const a = await f.pool.queue(scope("a")); const b = await second.queue(scope("b"));
  const results = await Promise.all([a.append(chunk(0, 6)), b.append(chunk(0, 6))]);
  assert.deepEqual(results.sort(), ["backpressure", "stored"]);
  assert.equal((await second.snapshot()).usedBytes, 6);
  f.pool.close(); second.close();
});

test("empty queue metadata has a cap and concurrent registration spends one slot", async () => {
  const f = await fixture({ maxQueues: 1 }); const second = await f.open();
  const registered = await Promise.allSettled([f.pool.queue(scope("a")), second.queue(scope("b"))]);
  assert.equal(registered.filter((r) => r.status === "fulfilled").length, 1);
  assert.equal((await f.pool.snapshot()).queueCount, 1);
  const winner = registered.find((r) => r.status === "fulfilled")!;
  assert.equal(winner.status, "fulfilled");
  if (winner.status === "fulfilled") assert.equal(await winner.value.releaseEmpty(), "released");
  assert.equal((await f.pool.snapshot()).queueCount, 0);
  await second.queue(scope("c"));
  f.pool.close(); second.close();
});

test("authenticated prefix pruning recovers shared capacity and preserves another queue", async () => {
  const f = await fixture(); const a = await f.pool.queue(scope("a")); const b = await f.pool.queue(scope("b"));
  await a.append(chunk(0)); await b.append(chunk(0));
  const allowed = grant("a", (await a.snapshot()).revision);
  assert.equal(await a.prune({ ...allowed, authorization: "forged" }), "refused");
  assert.equal(await a.prune({ ...allowed, unresolvedReference: true }), "refused");
  assert.equal(await a.prune(allowed), "pruned");
  assert.deepEqual((await b.readBatch(2)).map((c) => c.sequence), [0]);
  assert.equal((await f.pool.snapshot()).usedBytes, 5);
  assert.equal(await b.append(chunk(1)), "stored");
  f.pool.close();
});

test("writes to another scope do not invalidate this scope's prune revision", async () => {
  const f = await fixture(); const a = await f.pool.queue(scope("a")); const b = await f.pool.queue(scope("b"));
  await a.append(chunk(0)); const allowed = grant("a", (await a.snapshot()).revision);
  await b.append(chunk(0));
  assert.equal(await a.prune(allowed), "pruned");
  f.pool.close();
});

test("a nonempty scope cannot be released, and retiring an empty finalized scope recycles its metadata slot", async () => {
  const f = await fixture({ maxQueues: 1 }); const a = await f.pool.queue(scope("a"));
  await a.append(chunk(0));
  assert.equal(await a.releaseEmpty(), "refused");
  assert.equal(await a.release(grant("a", (await a.snapshot()).revision)), "refused");
  assert.equal(await a.prune(grant("a", (await a.snapshot()).revision)), "pruned");
  assert.equal(await a.release(grant("a", (await a.snapshot()).revision)), "released");
  assert.equal((await f.pool.snapshot()).queueCount, 0);
  await f.pool.queue(scope("b"));
  f.pool.close();
});

test("old handles and grants cannot mutate a recreated scope with the same ID", async () => {
  const f = await fixture(); const old = await f.pool.queue(scope("same"));
  await old.append(chunk(0));
  const stale = grant("same", (await old.snapshot()).revision);
  await old.prune(stale);
  await old.release(grant("same", (await old.snapshot()).revision));
  const fresh = await f.pool.queue(scope("same"));
  assert.ok((await fresh.snapshot()).revision > stale.expectedRevision);
  await fresh.append(chunk(0));
  await assert.rejects(old.append(chunk(1)), /generation|released/);
  assert.equal(await fresh.prune(stale), "concurrent_write");
  assert.equal((await fresh.snapshot()).itemCount, 1);
  f.pool.close();
});

test("quota errors roll back the payload, local usage and global usage in one transaction", async () => {
  let fail = false;
  const f = await fixture({ injectWriteFault: () => { if (fail) throw new DOMException("quota", "QuotaExceededError"); } });
  const a = await f.pool.queue(scope("a")); const before = await f.pool.snapshot(); const localBefore = await a.snapshot();
  fail = true;
  await assert.rejects(a.append(chunk(0)), { name: "QuotaExceededError" });
  assert.deepEqual(await f.pool.snapshot(), before);
  assert.deepEqual(await a.snapshot(), localBefore);
  fail = false; await a.append(chunk(0));
  const filled = await f.pool.snapshot();
  fail = true;
  await assert.rejects(a.prune(grant("a", (await a.snapshot()).revision)), { name: "QuotaExceededError" });
  assert.deepEqual(await f.pool.snapshot(), filled);
  assert.equal((await a.readBatch(1)).length, 1);
  fail = false; f.pool.close();
});

test("duplicate and conflicting retries do not consume global budget twice", async () => {
  const f = await fixture(); const a = await f.pool.queue(scope("a"));
  await a.append(chunk(0)); const before = await f.pool.snapshot();
  assert.equal(await a.append(chunk(0)), "duplicate");
  assert.equal(await a.append(chunk(0, 4)), "conflict");
  assert.equal(await a.append(chunk(2)), "gap");
  assert.deepEqual(await f.pool.snapshot(), before);
  f.pool.close();
});

test("restart refuses a changed global budget without discarding retained data", async () => {
  const f = await fixture(); const a = await f.pool.queue(scope("a")); await a.append(chunk(0)); f.pool.close();
  await assert.rejects(IndexedDbAuditPayloadPool.open({ factory: f.factory, name: f.name,
    limits: { ...limits, maxBytes: 100 }, maxQueues: 3 }), /configuration/);
  const restored = await f.open(); assert.equal((await restored.snapshot()).usedBytes, 5); restored.close();
});

test("failed registration and release cannot leak or undercount metadata slots", async () => {
  let fail = true;
  const f = await fixture({ injectWriteFault: () => { if (fail) throw new Error("injected metadata fault"); } });
  await assert.rejects(f.pool.queue(scope("a")), /metadata fault/);
  assert.equal((await f.pool.snapshot()).queueCount, 0);
  fail = false; const a = await f.pool.queue(scope("a"));
  const before = await f.pool.snapshot();
  fail = true;
  await assert.rejects(a.releaseEmpty(), /metadata fault/);
  assert.deepEqual(await f.pool.snapshot(), before);
  assert.equal((await a.snapshot()).itemCount, 0);
  fail = false; await a.append(chunk(0)); await a.prune(grant("a", (await a.snapshot()).revision));
  const pruned = await f.pool.snapshot();
  fail = true;
  await assert.rejects(a.release(grant("a", (await a.snapshot()).revision)), /metadata fault/);
  assert.deepEqual(await f.pool.snapshot(), pruned);
  fail = false; await a.release(grant("a", (await a.snapshot()).revision)); f.pool.close();
});

test("an append while authorization is delayed makes the grant stale without deleting the new payload", async () => {
  let allow!: () => void; let entered!: () => void;
  const gate = new Promise<void>((resolve) => { allow = resolve; });
  const started = new Promise<void>((resolve) => { entered = resolve; });
  const f = await fixture();
  const a = await f.pool.queue(scope("a", { verifyPruneGrant: async () => { entered(); await gate; return true; } }));
  await a.append(chunk(0));
  const pending = a.prune(grant("a", (await a.snapshot()).revision));
  await started;
  await a.append(chunk(1, 1)); allow();
  assert.equal(await pending, "concurrent_write");
  assert.equal((await f.pool.snapshot()).usedBytes, 6);
  assert.equal((await a.snapshot()).itemCount, 2);
  f.pool.close();
});

test("burst copies are bounded across distinct queues sharing one connection", async () => {
  const pool = await IndexedDbAuditPayloadPool.open({ factory: new IDBFactory(), name: crypto.randomUUID(),
    limits: { maxBytes: 100, reservedBytes: 0, maxItems: 10, maxItemBytes: 8 }, maxQueues: 8 });
  const queues = [];
  for (let i = 0; i < 8; i++) queues.push(await pool.queue(scope(`q-${i}`)));
  const result = await Promise.all(queues.map((q) => q.append(chunk(0, 1))));
  assert.equal(result.filter((r) => r === "stored").length, 4);
  assert.equal(result.filter((r) => r === "backpressure").length, 4);
  assert.equal((await pool.snapshot()).usedBytes, 4);
  pool.close();
});

test("the new shared store refuses a legacy database and leaves its retained chunks intact", async () => {
  const factory = new IDBFactory(); const name = crypto.randomUUID();
  const options = { factory, name, ...scope("legacy") };
  const original = await IndexedDbAuditPayloadQueue.open(options);
  await original.append(chunk(0)); original.close();
  await assert.rejects(IndexedDbAuditPayloadPool.open({ factory, name, limits, maxQueues: 3 }), /legacy/);
  const retained = await IndexedDbAuditPayloadQueue.open(options);
  assert.equal((await retained.snapshot()).usedBytes, 5);
  assert.equal((await retained.readBatch(1)).length, 1);
  retained.close();
});

test("restart detects inconsistent durable counters instead of resetting the retained evidence", async () => {
  const f = await fixture(); const a = await f.pool.queue(scope("a")); await a.append(chunk(0)); f.pool.close();
  const database = await new Promise<IDBDatabase>((resolve, reject) => {
    const open = f.factory.open(f.name, 1);
    open.onsuccess = () => resolve(open.result); open.onerror = () => reject(open.error);
  });
  const tx = database.transaction("pool_meta", "readwrite");
  const done = new Promise<void>((resolve, reject) => { tx.oncomplete = () => resolve(); tx.onabort = () => reject(tx.error); });
  const get = tx.objectStore("pool_meta").get("singleton");
  get.onsuccess = () => tx.objectStore("pool_meta").put({ ...get.result, usedBytes: get.result.usedBytes + 1 });
  await done; database.close();
  await assert.rejects(f.open(), /usage mismatch/);
  const inspect = await new Promise<IDBDatabase>((resolve) => { const open = f.factory.open(f.name); open.onsuccess = () => resolve(open.result); });
  const read = inspect.transaction("pool_chunks", "readonly").objectStore("pool_chunks").count();
  const count = await new Promise<number>((resolve) => { read.onsuccess = () => resolve(read.result); });
  assert.equal(count, 1); inspect.close();
});
