import assert from "node:assert/strict";
import test from "node:test";
import { IDBFactory } from "fake-indexeddb";
import { createStandardWebCryptoBackend } from "../../player-local-runtime/crypto-backend.ts";
import { IndexedDbEncounterSessionStore } from "../web/src/audit/encounter-session-store.ts";
import { ENCOUNTER_RULES } from "../game/encounter/contracts.ts";
import type { InventoryCheckpointStatement } from "../game/encounter/inventory-checkpoint.ts";

const initial = { authorization: { unit: "demo", startHead: "assigned", playerId: "alice", ownerPublicKey: "a".repeat(64) },
  phase: "starting" as const, cleaned: false, admittedAssets: [] };
test("one non-extractable device key and bounded session metadata survive reload", async () => {
  const factory = new IDBFactory(); const name = crypto.randomUUID(); const backend = createStandardWebCryptoBackend(crypto);
  let store = await IndexedDbEncounterSessionStore.open({ factory, name });
  const owner = await store.owner(backend);
  let image = await store.read();
  image = await store.write({ ...image, current: initial }, image.revision); store.close();
  store = await IndexedDbEncounterSessionStore.open({ factory, name });
  assert.equal((await store.owner(backend)).publicKey, owner.publicKey);
  assert.deepEqual(await store.read(), image);
  assert.equal((await store.inspectKey()).privateKey.extractable, false); store.close();
});
test("stale writes and transaction failures preserve the prior recovery record", async () => {
  const factory = new IDBFactory(); const name = crypto.randomUUID(); let fail = false;
  const store = await IndexedDbEncounterSessionStore.open({ factory, name, injectWriteFault: () => { if (fail) throw new Error("session fault"); } });
  const image = await store.write({ ...await store.read(), current: initial }, 0);
  await assert.rejects(store.write({ ...image, current: null }, 0), /revision/);
  fail = true; await assert.rejects(store.write({ ...image, current: null }, image.revision), /fault/);
  assert.deepEqual(await store.read(), image); store.close();
});
test("key creation rechecks retained evidence after asynchronous generation and fails closed", async () => {
  const store = await IndexedDbEncounterSessionStore.open({ factory: new IDBFactory(), name: crypto.randomUUID() });
  const backend = createStandardWebCryptoBackend(crypto);
  try {
    await assert.rejects(store.owner({ ...backend, generateSigningKey: async () => {
      await store.write({ ...await store.read(), current: initial }, 0);
      return backend.generateSigningKey();
    } }), /key missing/);
    await assert.rejects(store.inspectKey(), /unavailable/);
    assert.deepEqual((await store.read()).current, initial);
  } finally { store.close(); }
});
test("history/count/byte limits refuse new data without evicting existing recovery evidence", async () => {
  const store = await IndexedDbEncounterSessionStore.open({ factory: new IDBFactory(), name: crypto.randomUUID() });
  const image = await store.write({ ...await store.read(), current: initial }, 0);
  await assert.rejects(store.write({ ...image, history: Array(17).fill({}) }, image.revision), /capacity|invalid/);
  await assert.rejects(store.write({ ...image, current: { ...initial, authorization: { ...initial.authorization, startHead: "x".repeat(100_000) } } }, image.revision), /capacity|invalid/);
  await assert.rejects(store.write({ ...image, hiddenBlob: new ArrayBuffer(100_000) } as typeof image, image.revision), /invalid/);
  assert.deepEqual(await store.read(), image); store.close();
});
test("legacy session images gain empty checkpoint fields without resetting the revision or device key", async () => {
  const factory = new IDBFactory(); const name = crypto.randomUUID(); const backend = createStandardWebCryptoBackend(crypto);
  const store = await IndexedDbEncounterSessionStore.open({ factory, name }); const owner = await store.owner(backend);
  const db = await new Promise<IDBDatabase>((resolve, reject) => { const r = factory.open(name, 1); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction("control", "readwrite"); tx.objectStore("control").put({ version: 1, revision: 7, current: initial, history: [] }, "session");
    tx.oncomplete = () => resolve(); tx.onabort = () => reject(tx.error);
  }); db.close();
  const image = await store.read(); assert.equal(image.revision, 7); assert.equal(image.checkpoint, null); assert.equal(image.pendingCompaction, null);
  assert.deepEqual(image.current, initial); assert.equal((await store.owner(backend)).publicKey, owner.publicKey); store.close();
});
test("a retained checkpoint without a device key cannot silently create a replacement identity", async () => {
  const store = await IndexedDbEncounterSessionStore.open({ factory: new IDBFactory(), name: crypto.randomUUID() });
  try {
    const statement: InventoryCheckpointStatement = { version: 1, authorityKey: "a".repeat(64), ownerPublicKey: "b".repeat(64), unit: "demo", rulesId: ENCOUNTER_RULES,
      revision: 1, previousId: null, batchDigest: "c".repeat(64), root: "d".repeat(64), receiptCount: 1, itemCount: 1, createdAt: 1 };
    await store.write({ ...await store.read(), checkpoint: { statement, checkpointId: "e".repeat(64), signature: "f".repeat(128) } }, 0);
    await assert.rejects(store.owner(createStandardWebCryptoBackend(crypto)), /key missing/);
    await assert.rejects(store.inspectKey(), /unavailable/);
  } finally { store.close(); }
});
