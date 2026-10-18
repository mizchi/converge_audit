import assert from "node:assert/strict";
import test from "node:test";
import { IDBFactory } from "fake-indexeddb";
import {
  IndexedDbAuditPayloadQueue,
  type PayloadPruneGrant,
} from "../web/src/audit/bounded-payload-queue.ts";

const limits = { maxBytes: 12, maxItems: 2, maxItemBytes: 8, reservedBytes: 2 };
const checkpoint = "a".repeat(64);

async function fixture(options: { fault?: () => void } = {}) {
  const factory = new IDBFactory();
  const name = `payload-${crypto.randomUUID()}`;
  const open = () => IndexedDbAuditPayloadQueue.open({
    factory, name, queueId: "alice/replay", limits,
    verifyPruneGrant: async (grant) => grant.authorization === "trusted-test-grant",
    injectWriteFault: options.fault,
  });
  return { factory, name, open, queue: await open() };
}

function chunk(sequence: number, bytes = 5) {
  return { sequence, checkpointDigest: checkpoint, payload: new Uint8Array(bytes).fill(sequence) };
}

function grant(revision: number, overrides: Partial<PayloadPruneGrant> = {}): PayloadPruneGrant {
  return {
    queueId: "alice/replay", expectedRevision: revision, throughSequence: 0,
    throughCheckpointDigest: checkpoint,
    deliveryAcknowledged: true, gameplayFinalized: true,
    retentionClosed: true, unresolvedReference: false,
    authorization: "trusted-test-grant", ...overrides,
  };
}

test("payload bytes, reserved headroom and item count bound admission across restart", async () => {
  const f = await fixture();
  assert.equal(await f.queue.append(chunk(0)), "stored");
  assert.equal(await f.queue.append(chunk(1)), "stored");
  assert.equal(await f.queue.append(chunk(2, 1)), "backpressure");
  assert.equal((await f.queue.snapshot()).usedBytes, 10);
  f.queue.close();
  const reopened = await f.open();
  assert.equal(await reopened.append(chunk(2, 1)), "backpressure");
  assert.equal((await reopened.snapshot()).itemCount, 2);
  reopened.close();
});

test("oversized chunks and conflicting retries do not mutate the queue", async () => {
  const { queue } = await fixture();
  assert.equal(await queue.append(chunk(0, 9)), "backpressure");
  assert.equal(await queue.append(chunk(0)), "stored");
  const before = await queue.snapshot();
  assert.equal(await queue.append(chunk(0)), "duplicate");
  assert.equal(await queue.append(chunk(0, 4)), "conflict");
  assert.equal(await queue.append(chunk(2)), "gap");
  assert.deepEqual(await queue.snapshot(), before);
  queue.close();
});

test("ACK alone, an active hold, an open retention window and unauthenticated grants cannot prune", async () => {
  const { queue } = await fixture();
  await queue.append(chunk(0));
  const before = await queue.snapshot();
  for (const override of [
    { gameplayFinalized: false }, { retentionClosed: false },
    { deliveryAcknowledged: false }, { unresolvedReference: true },
    { authorization: "forged" }, { queueId: "another-queue" },
  ]) {
    assert.equal(await queue.prune(grant(before.revision, override)), "refused");
    assert.deepEqual(await queue.snapshot(), before);
  }
  queue.close();
});

test("concurrent append and delayed prune grant cannot delete a newer revision", async () => {
  const { queue } = await fixture();
  await queue.append(chunk(0));
  const stale = grant((await queue.snapshot()).revision);
  await queue.append(chunk(1));
  assert.equal(await queue.prune(stale), "concurrent_write");
  assert.equal((await queue.snapshot()).itemCount, 2);
  queue.close();
});

test("pruning advances a durable contiguous boundary and recovers admission capacity", async () => {
  const f = await fixture();
  await f.queue.append(chunk(0));
  await f.queue.append(chunk(1));
  assert.equal(await f.queue.prune(grant((await f.queue.snapshot()).revision)), "pruned");
  assert.equal(await f.queue.append(chunk(0)), "pruned");
  assert.equal(await f.queue.append(chunk(2)), "stored");
  assert.deepEqual((await f.queue.readBatch(1)).map((value) => value.sequence), [1]);
  assert.deepEqual((await f.queue.readBatch(2)).map((value) => value.sequence), [1, 2]);
  f.queue.close();
  const reopened = await f.open();
  assert.equal((await reopened.snapshot()).firstSequence, 1);
  assert.equal((await reopened.snapshot()).usedBytes, 10);
  reopened.close();
});

test("two connections cannot both consume the last free capacity", async () => {
  const f = await fixture();
  await f.queue.append(chunk(0));
  const second = await f.open();
  const results = await Promise.all([f.queue.append(chunk(1)), second.append(chunk(1))]);
  assert.deepEqual(results.sort(), ["duplicate", "stored"]);
  assert.equal((await second.snapshot()).usedBytes, 10);
  f.queue.close();
  second.close();
});

test("quota failure rolls back both payload and durable usage counters", async () => {
  let fail = true;
  const f = await fixture({ fault: () => {
    if (fail) throw new DOMException("injected storage quota", "QuotaExceededError");
  } });
  const before = await f.queue.snapshot();
  await assert.rejects(f.queue.append(chunk(0)), { name: "QuotaExceededError" });
  assert.deepEqual(await f.queue.snapshot(), before);
  fail = false;
  assert.equal(await f.queue.append(chunk(0)), "stored");
  f.queue.close();
});

test("byte headroom blocks a second item independently of the item-count bound", async () => {
  const { queue } = await fixture();
  await queue.append(chunk(0));
  assert.equal(await queue.append(chunk(1, 6)), "backpressure");
  assert.equal((await queue.snapshot()).itemCount, 1);
  assert.equal((await queue.snapshot()).usedBytes, 5);
  queue.close();
});

test("grant target, batch size and invalid payloads are checked without mutation", async () => {
  const { queue } = await fixture();
  await queue.append(chunk(0));
  const before = await queue.snapshot();
  assert.equal(await queue.prune(grant(before.revision, { throughCheckpointDigest: "b".repeat(64) })), "refused");
  assert.equal(await queue.prune(grant(before.revision, { throughSequence: 1 })), "refused");
  assert.equal(await queue.prune(grant(before.revision, { authorization: "x".repeat(16_385) })), "refused");
  assert.equal(await queue.append(chunk(1, 0)), "invalid");
  assert.equal(await queue.append({ ...chunk(1), checkpointDigest: "not-a-digest" }), "invalid");
  await assert.rejects(queue.readBatch(65), TypeError);
  assert.deepEqual(await queue.snapshot(), before);
  queue.close();
});

test("failure during prune retains both the prefix and the old watermark", async () => {
  let fail = false;
  const f = await fixture({ fault: () => { if (fail) throw new Error("injected prune failure"); } });
  await f.queue.append(chunk(0));
  const before = await f.queue.snapshot();
  fail = true;
  await assert.rejects(f.queue.prune(grant(before.revision)), /injected prune failure/);
  assert.deepEqual(await f.queue.snapshot(), before);
  assert.equal((await f.queue.readBatch(1))[0].sequence, 0);
  f.queue.close();
  const reopened = await f.open();
  assert.deepEqual(await reopened.snapshot(), before);
  reopened.close();
});

test("reopening with a different budget refuses without rewriting the existing queue", async () => {
  const f = await fixture();
  await f.queue.append(chunk(0));
  f.queue.close();
  await assert.rejects(IndexedDbAuditPayloadQueue.open({
    factory: f.factory, name: f.name, queueId: "alice/replay",
    limits: { ...limits, maxBytes: 100 }, verifyPruneGrant: async () => true,
  }), /configuration\/accounting mismatch/);
  const reopened = await f.open();
  assert.equal((await reopened.snapshot()).usedBytes, 5);
  reopened.close();
});

test("an append burst bounds queued payload copies before waiting on IndexedDB", async () => {
  const { queue } = await fixture();
  const results = await Promise.all(Array.from({ length: 10 }, () => queue.append(chunk(0))));
  assert.equal(results.filter((value) => value === "stored").length, 1);
  assert.equal(results.filter((value) => value === "duplicate").length, 3);
  assert.equal(results.filter((value) => value === "backpressure").length, 6);
  assert.equal((await queue.snapshot()).usedBytes, 5);
  queue.close();
});
