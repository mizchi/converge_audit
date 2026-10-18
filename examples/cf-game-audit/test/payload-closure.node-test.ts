import assert from "node:assert/strict";
import test from "node:test";
import { IDBFactory } from "fake-indexeddb";
import { IndexedDbAuditPayloadPool } from "../web/src/audit/payload-pool.ts";

async function fixture(verifyClosureGrant = async () => true, injectWriteFault?: () => void) {
  const factory = new IDBFactory(); const name = crypto.randomUUID();
  const pool = await IndexedDbAuditPayloadPool.open({ factory, name,
    limits: { maxBytes: 20, reservedBytes: 2, maxItems: 4, maxItemBytes: 8 }, maxQueues: 3, injectWriteFault });
  const options = { queueId: "terminated", limits: { maxBytes: 16, reservedBytes: 0, maxItems: 2, maxItemBytes: 8 },
    verifyPruneGrant: async () => false, verifyClosureGrant, bytes: 16, items: 2 };
  const queue = await pool.reserve(options);
  const grant = async () => ({ queueId: options.queueId, expectedRevision: (await queue.snapshot()).revision,
    nextSequence: (await queue.snapshot()).nextSequence, closureId: "c".repeat(64), authorization: "test-closure" });
  return { pool, queue, options, grant };
}
const chunk = (sequence: number) => ({ sequence, checkpointDigest: "a".repeat(64), payload: new Uint8Array(4) });

test("terminal closure atomically releases partial payload, unused credit and its metadata slot", async () => {
  const f = await fixture();
  const other = await f.pool.queue({ ...f.options, queueId: "other" });
  await other.append({ ...chunk(0), payload: new Uint8Array(2) });
  await f.queue.append(chunk(0));
  assert.equal(await f.queue.releaseEmpty(), "refused");
  assert.equal(await f.queue.releaseClosed(await f.grant()), "released");
  assert.deepEqual(await f.pool.snapshot(), { usedBytes: 2, itemCount: 1, queueCount: 1,
    reservedPayloadBytes: 0, reservedItemCount: 0, revision: (await f.pool.snapshot()).revision });
  assert.equal((await other.readBatch(2))[0].payload.byteLength, 2);
  await assert.rejects(f.queue.snapshot(), /released/);
  f.pool.close();
});

test("an unauthenticated terminal claim or another snapshot cannot delete retained evidence", async () => {
  const f = await fixture(async () => false); await f.queue.append(chunk(0));
  assert.equal(await f.queue.releaseClosed(await f.grant()), "refused");
  assert.equal((await f.pool.snapshot()).usedBytes, 4); f.pool.close();
  const g = await fixture(); await g.queue.append(chunk(0)); const grant = await g.grant();
  assert.equal(await g.queue.releaseClosed({ ...grant, queueId: "other" }), "refused");
  assert.equal(await g.queue.releaseClosed({ ...grant, nextSequence: 0 }), "refused");
  assert.equal(await g.queue.releaseClosed({ ...grant, expectedRevision: grant.expectedRevision - 1 }), "concurrent_write");
  assert.equal((await g.queue.readBatch(2)).length, 1); g.pool.close();
});

test("an append during closure authentication invalidates the grant; the old handle cannot release a recreated scope", async () => {
  let proceed!: () => void; let entered!: () => void;
  const gate = new Promise<void>((resolve) => { proceed = resolve; });
  const started = new Promise<void>((resolve) => { entered = resolve; });
  let delayed = true;
  const f = await fixture(async () => { if (delayed) { entered(); await gate; } return true; });
  await f.queue.append(chunk(0));
  const pending = f.queue.releaseClosed(await f.grant());
  await started; await f.queue.append(chunk(1)); proceed();
  assert.equal(await pending, "concurrent_write");
  assert.equal((await f.queue.readBatch(2)).length, 2);
  delayed = false; const grant = await f.grant();
  assert.equal(await f.queue.releaseClosed(grant), "released");
  const recreated = await f.pool.reserve(f.options);
  await assert.rejects(f.queue.releaseClosed(grant), /generation|released/);
  assert.equal(await recreated.releaseClosed(grant), "concurrent_write"); f.pool.close();
});

test("a failed terminal deletion rolls back the payload and both global credit counters", async () => {
  let fail = false;
  const f = await fixture(async () => true, () => { if (fail) throw new Error("closure write fault"); });
  await f.queue.append(chunk(0)); const before = await f.pool.snapshot(); const grant = await f.grant();
  fail = true; await assert.rejects(f.queue.releaseClosed(grant), /fault/);
  assert.deepEqual(await f.pool.snapshot(), before);
  assert.equal((await f.queue.readBatch(2)).length, 1);
  fail = false; assert.equal(await f.queue.releaseClosed(grant), "released"); f.pool.close();
});

test("a terminal grant can release a wholly unused reservation without inventing a prefix digest", async () => {
  const f = await fixture();
  assert.equal(await f.queue.releaseClosed(await f.grant()), "released");
  assert.equal((await f.pool.snapshot()).reservedPayloadBytes, 0); f.pool.close();
});
