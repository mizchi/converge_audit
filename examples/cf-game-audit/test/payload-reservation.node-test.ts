import assert from "node:assert/strict";
import test from "node:test";
import { IDBFactory } from "fake-indexeddb";
import { IndexedDbAuditPayloadPool } from "../web/src/audit/payload-pool.ts";

const limits = { maxBytes: 12, reservedBytes: 2, maxItems: 3, maxItemBytes: 8 };
const local = { maxBytes: 20, reservedBytes: 0, maxItems: 4, maxItemBytes: 8 };
const scope = (queueId: string) => ({ queueId, limits: local, verifyPruneGrant: async () => false });
const chunk = (sequence: number, bytes: number) => ({ sequence, checkpointDigest: "a".repeat(64), payload: new Uint8Array(bytes) });
async function fixture(injectWriteFault?: () => void) {
  const factory = new IDBFactory(); const name = crypto.randomUUID();
  const open = () => IndexedDbAuditPayloadPool.open({ factory, name, limits, maxQueues: 3, injectWriteFault });
  return { factory, name, open, pool: await open() };
}

test("a full-encounter reservation prevents other queues from stealing its capacity", async () => {
  const f = await fixture();
  const a = await f.pool.reserve({ ...scope("a"), bytes: 8, items: 2 });
  const b = await f.pool.queue(scope("b"));
  assert.equal((await f.pool.snapshot()).reservedPayloadBytes, 8);
  assert.equal((await f.pool.snapshot()).reservedItemCount, 2);
  assert.equal(await b.append(chunk(0, 3)), "backpressure");
  assert.equal(await b.append(chunk(0, 2)), "stored");
  assert.equal(await a.append(chunk(0, 4)), "stored");
  assert.equal(await a.append(chunk(1, 4)), "stored");
  assert.deepEqual(await f.pool.snapshot(), { usedBytes: 10, itemCount: 3, queueCount: 2,
    reservedPayloadBytes: 0, reservedItemCount: 0, revision: (await f.pool.snapshot()).revision });
  f.pool.close();
});

test("the last allocated item returns unused byte credit, and the reservation cannot be consumed again", async () => {
  const f = await fixture();
  const a = await f.pool.reserve({ ...scope("a"), bytes: 10, items: 2 });
  const b = await f.pool.queue(scope("b"));
  assert.equal(await a.append(chunk(0, 3)), "stored");
  assert.equal((await f.pool.snapshot()).reservedPayloadBytes, 7);
  assert.equal(await a.append(chunk(0, 3)), "duplicate");
  assert.equal((await f.pool.snapshot()).reservedPayloadBytes, 7);
  assert.equal(await b.append(chunk(0, 1)), "backpressure");
  assert.equal(await a.append(chunk(1, 5)), "stored");
  assert.equal((await f.pool.snapshot()).reservedPayloadBytes, 0);
  assert.equal(await a.append(chunk(2, 1)), "backpressure");
  assert.equal(await b.append(chunk(0, 2)), "stored");
  f.pool.close();
});

test("concurrent reservations use one shared admission gate and retries do not reserve twice", async () => {
  const f = await fixture(); const second = await f.open();
  const results = await Promise.allSettled([
    f.pool.reserve({ ...scope("a"), bytes: 6, items: 1 }), second.reserve({ ...scope("b"), bytes: 6, items: 1 }),
  ]);
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  assert.equal((await f.pool.snapshot()).queueCount, 1);
  assert.equal((await f.pool.snapshot()).reservedPayloadBytes, 6);
  const id = results[0].status === "fulfilled" ? "a" : "b";
  await second.reserve({ ...scope(id), bytes: 6, items: 1 });
  assert.equal((await second.snapshot()).reservedPayloadBytes, 6);
  await assert.rejects(second.reserve({ ...scope(id), bytes: 7, items: 1 }), /reservation/);
  f.pool.close(); second.close();
});

test("unused reservations survive restart and can release their metadata and capacity", async () => {
  const f = await fixture();
  await f.pool.reserve({ ...scope("a"), bytes: 8, items: 2 }); f.pool.close();
  const restored = await f.open();
  const a = await restored.reserve({ ...scope("a"), bytes: 8, items: 2 });
  assert.equal((await restored.snapshot()).reservedPayloadBytes, 8);
  assert.equal(await a.releaseEmpty(), "released");
  assert.equal((await restored.snapshot()).reservedPayloadBytes, 0);
  assert.equal((await restored.snapshot()).reservedItemCount, 0);
  assert.equal((await restored.snapshot()).queueCount, 0);
  restored.close();
});

test("failed reservation and failed conversion to payload roll back every credit counter", async () => {
  let fail = true;
  const f = await fixture(() => { if (fail) throw new Error("injected reservation failure"); });
  await assert.rejects(f.pool.reserve({ ...scope("a"), bytes: 8, items: 2 }), /reservation failure/);
  assert.equal((await f.pool.snapshot()).queueCount, 0);
  assert.equal((await f.pool.snapshot()).reservedPayloadBytes, 0);
  fail = false; const a = await f.pool.reserve({ ...scope("a"), bytes: 8, items: 2 });
  const before = await f.pool.snapshot();
  fail = true; await assert.rejects(a.append(chunk(0, 4)), /reservation failure/);
  assert.deepEqual(await f.pool.snapshot(), before);
  assert.equal((await a.snapshot()).itemCount, 0);
  fail = false; assert.equal(await a.append(chunk(0, 4)), "stored"); f.pool.close();
});

test("a reservation already containing payload cannot be discarded as an empty reservation", async () => {
  const f = await fixture(); const a = await f.pool.reserve({ ...scope("a"), bytes: 8, items: 2 });
  await a.append(chunk(0, 4));
  assert.equal(await a.releaseEmpty(), "refused");
  f.pool.close(); const restored = await f.open();
  assert.equal((await restored.snapshot()).reservedPayloadBytes, 4);
  assert.equal((await restored.snapshot()).reservedItemCount, 1);
  assert.equal(await (await restored.queue(scope("a"))).append(chunk(1, 4)), "stored");
  restored.close();
});

test("pruning payload and reopening a spent reservation never refund its item credit", async () => {
  const f = await fixture();
  const options = { ...scope("a"), bytes: 8, items: 2, verifyPruneGrant: async () => true };
  let a = await f.pool.reserve(options);
  const prune = async (throughSequence: number) => a.prune({ queueId: "a", expectedRevision: (await a.snapshot()).revision,
    throughSequence, throughCheckpointDigest: "a".repeat(64), authorization: "test-finality",
    deliveryAcknowledged: true, gameplayFinalized: true, retentionClosed: true, unresolvedReference: false });
  assert.equal(await a.append(chunk(0, 4)), "stored");
  assert.equal(await prune(0), "pruned");
  a = await f.pool.reserve(options);
  assert.equal((await f.pool.snapshot()).reservedItemCount, 1);
  assert.equal((await f.pool.snapshot()).reservedPayloadBytes, 4);
  assert.equal(await a.append(chunk(1, 4)), "stored");
  assert.equal(await prune(1), "pruned");
  a = await f.pool.reserve(options);
  assert.equal(await a.append(chunk(2, 1)), "backpressure");
  assert.equal((await f.pool.snapshot()).usedBytes, 0);
  assert.equal((await f.pool.snapshot()).reservedItemCount, 0);
  f.pool.close();
});

async function changeCounters(factory: IDBFactory, name: string, change: (meta: Record<string, unknown>) => void) {
  const db = await new Promise<IDBDatabase>((resolve) => { const open = factory.open(name); open.onsuccess = () => resolve(open.result); });
  const tx = db.transaction("pool_meta", "readwrite");
  const done = new Promise<void>((resolve, reject) => { tx.oncomplete = () => resolve(); tx.onabort = () => reject(tx.error); });
  const get = tx.objectStore("pool_meta").get("singleton");
  get.onsuccess = () => { const meta = get.result; change(meta); tx.objectStore("pool_meta").put(meta); };
  await done; db.close();
}

test("old shared-pool counters migrate without losing chunks; partial or inconsistent credit counters are refused", async () => {
  const f = await fixture();
  const a = await f.pool.queue(scope("a")); await a.append(chunk(0, 4)); f.pool.close();
  await changeCounters(f.factory, f.name, (meta) => { delete meta.reservedPayloadBytes; delete meta.reservedItemCount; });
  const migrated = await f.open();
  assert.equal((await migrated.snapshot()).usedBytes, 4);
  assert.equal((await migrated.snapshot()).reservedPayloadBytes, 0);
  assert.equal((await (await migrated.queue(scope("a"))).readBatch(1)).length, 1); migrated.close();
  await changeCounters(f.factory, f.name, (meta) => { delete meta.reservedItemCount; });
  await assert.rejects(f.open(), /accounting/);
  await changeCounters(f.factory, f.name, (meta) => { meta.reservedItemCount = 0; meta.reservedPayloadBytes = 1; });
  await assert.rejects(f.open(), /usage mismatch/);
});
