import "fake-indexeddb/auto";
import assert from "node:assert/strict";
import test from "node:test";
import type {
  VerificationKeyRecord,
} from "../../player-local-runtime/key-lifecycle.ts";
import {
  IndexedDbVerificationKeyLifecycleStore,
} from "../web/src/audit/verification-key-lifecycle-indexeddb.ts";

const digest = {
  async hashString(value: string): Promise<string> {
    const encoded = new TextEncoder().encode(value);
    return Array.from(
      new Uint8Array(await crypto.subtle.digest("SHA-256", encoded)),
      (byte) => byte.toString(16).padStart(2, "0"),
    ).join("");
  },
};

function key(
  keyVersion: number,
  publicKey: string,
  validFromMs: number,
  validUntilMs: number,
): VerificationKeyRecord {
  return {
    version: 1,
    keyId: "authority-checkpoint-key",
    keyVersion,
    subjectId: "authority-a",
    purpose: "checkpoint-receipt",
    scopeId: "world-a",
    scheme: "ed25519-v1",
    publicKey,
    validFromMs,
    validUntilMs,
    revokedAtMs: null,
  };
}

test("player-local IndexedDB retains lifecycle history across restart", async () => {
  const databaseName = `key-lifecycle-${crypto.randomUUID()}`;
  const first = await IndexedDbVerificationKeyLifecycleStore.open(
    indexedDB,
    databaseName,
  );
  assert.deepEqual(await first.provision({
    record: key(1, "11".repeat(32), 0, 1_000),
    expectedRevision: 0,
    committedAtMs: 10,
    digest,
  }), { decision: "committed", revision: 1 });
  first.close();

  const second = await IndexedDbVerificationKeyLifecycleStore.open(
    indexedDB,
    databaseName,
  );
  assert.deepEqual(await second.rotate({
    keyId: "authority-checkpoint-key",
    previousKeyVersion: 1,
    nextRecord: key(2, "22".repeat(32), 500, 2_000),
    cutoverMs: 500,
    expectedRevision: 1,
    committedAtMs: 400,
    digest,
  }), { decision: "committed", revision: 2 });
  assert.deepEqual(await second.revoke({
    keyId: "authority-checkpoint-key",
    keyVersion: 2,
    revokedAtMs: 750,
    expectedRevision: 2,
    committedAtMs: 700,
    digest,
  }), { decision: "committed", revision: 3 });

  const image = await second.image("authority-checkpoint-key");
  assert.equal(image.records.length, 2);
  assert.equal(image.records[0].validUntilMs, 500);
  assert.equal(image.records[1].revokedAtMs, 750);
  assert.deepEqual(image.events.map((event) => event.lifecycleRevision), [1, 2, 3]);
  assert.equal(JSON.stringify(image).includes("private"), false);
  second.close();
});
