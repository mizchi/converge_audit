import "fake-indexeddb/auto";
import assert from "node:assert/strict";
import test from "node:test";
import {
  createStandardWebCryptoBackend,
} from "../../player-local-runtime/crypto-backend.ts";
import {
  loadOrCreateProductionDeviceKey,
} from "../web/src/audit/device-key.ts";
import { IndexedDbRunSnapshotStore } from "../web/src/audit/indexeddb.ts";

test("non-extractable device key survives IndexedDB restart", async () => {
  const backend = createStandardWebCryptoBackend(crypto);
  const databaseName = `device-key-custody-${crypto.randomUUID()}`;
  const runKey = "run-1";
  const firstStore = new IndexedDbRunSnapshotStore(databaseName);
  const first = await loadOrCreateProductionDeviceKey(
    firstStore,
    runKey,
    backend,
  );
  const stored = await firstStore.loadDeviceKeyHandle(runKey);

  assert.equal(stored?.version, 1);
  assert.equal(stored?.privateKey.extractable, false);
  await assert.rejects(
    crypto.subtle.exportKey("pkcs8", stored!.privateKey),
  );

  const secondStore = new IndexedDbRunSnapshotStore(databaseName);
  const restored = await loadOrCreateProductionDeviceKey(
    secondStore,
    runKey,
    backend,
  );
  assert.equal(restored.publicKey, first.publicKey);
  const signature = await restored.signDigest("checkpoint-after-restart");
  assert.equal(await backend.verify(
    restored.publicKey,
    "checkpoint-after-restart",
    signature,
  ), true);
  assert.deepEqual(Object.keys(restored).sort(), [
    "publicKey",
    "scheme",
    "signDigest",
  ]);
});

test("legacy seed is one-way migrated into a non-extractable handle", async () => {
  const backend = createStandardWebCryptoBackend(crypto);
  const store = new IndexedDbRunSnapshotStore(
    `device-key-migration-${crypto.randomUUID()}`,
  );
  const runKey = "legacy-run";
  const seed =
    "000102030405060708090a0b0c0d0e0f" +
    "101112131415161718191a1b1c1d1e1f";
  const expectedPublicKey =
    "03a107bff3ce10be1d70dd18e74bc099" +
    "67e4d6309ba50d5f1ddc8664125531b8";
  await store.saveDeviceSeed(runKey, seed);

  const migrated = await loadOrCreateProductionDeviceKey(
    store,
    runKey,
    backend,
  );

  assert.equal(migrated.publicKey, expectedPublicKey);
  assert.equal(await store.loadDeviceSeed(runKey), undefined);
  const material = await store.loadDeviceKeyHandle(runKey);
  assert.equal(material?.privateKey.extractable, false);
  assert.equal(await backend.verify(
    migrated.publicKey,
    "migrated",
    await migrated.signDigest("migrated"),
  ), true);
});
