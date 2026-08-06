import assert from "node:assert/strict";
import test from "node:test";
import { IDBFactory } from "fake-indexeddb";
import {
  audit_browser_ed25519_public_key,
  audit_browser_ed25519_sign,
  audit_browser_sha256,
} from "../../../_build/js/release/build/x/game_audit/browser_bridge/browser_bridge.js";

import { runPlayerLocalStorageConformance } from "../../player-local-runtime/conformance.node.ts";
import {
  playerLocalEvidenceHoldEnvelopeStatement,
  type PlayerLocalEvidenceHoldUnsignedEnvelope,
} from "../../player-local-runtime/evidence-hold-wire.ts";

import type {
  AuditBoundary,
  PlayerLocalAuditEvent,
  PlayerLocalAuditImage,
  PlayerLocalSealWriteSet,
  PlayerLocalStoreConfiguration,
} from "../../player-local-runtime/contracts.ts";
import {
  BrowserPlayerLocalCheckpointRuntime,
} from "../web/src/audit/player-local-checkpoint-runtime.ts";
import {
  IndexedDbPlayerLocalStore,
  InjectedIndexedDbPlayerLocalSealFault,
  PlayerLocalIndexedDbCorruptError,
} from "../web/src/audit/player-local-indexeddb.ts";
import {
  createMoonBitEd25519EvidenceHoldAuthenticator,
} from "../web/src/audit/evidence-hold-authenticator.ts";

const boundary: AuditBoundary = {
  protocol_version: 1,
  purpose: "checkpoint-v1",
  manifest_digest: "manifest-local",
  scope_id: "player-alice",
  unit_id: "match-1",
};

const configuration: PlayerLocalStoreConfiguration = {
  boundary,
  genesis_digest: "genesis",
  outbox_capacity: 8,
};

function event(counter: number, digest: string): PlayerLocalAuditEvent {
  return {
    boundary,
    author_id: "alice",
    counter,
    epoch: 0,
    event_digest: digest,
    canonical_event: `event:${digest}`,
  };
}

function sealWriteSet(
  image: PlayerLocalAuditImage,
  destinations = ["authority", "peer-bob"],
  digest = "checkpoint-0",
): PlayerLocalSealWriteSet {
  const epoch = image.head.epoch + 1;
  const activeOutboxCount = image.outbox.filter(
    (entry) => entry.state.kind !== "acknowledged",
  ).length;
  const outbox_entries = destinations.map((destination_id, index) => ({
    boundary,
    destination_id,
    epoch,
    checkpoint_digest: digest,
    canonical_envelope: `envelope:${digest}`,
    created_order: image.next_created_order + index,
    state: { kind: "pending" as const },
  }));
  return {
    expected_revision: image.storage_revision,
    expected_snapshot: {
      boundary,
      current_epoch: image.head.epoch,
      current_digest: image.head.checkpoint_digest,
      incoming_epoch_known: false,
      known_digest_matches: false,
      known_seal_complete: false,
      closure_consumed: false,
      outbox_entry_count: activeOutboxCount,
      outbox_capacity: image.outbox_capacity,
      next_created_order: image.next_created_order,
    },
    checkpoint: {
      boundary,
      epoch,
      previous_checkpoint: image.head.checkpoint_digest,
      checkpoint_digest: digest,
      canonical_envelope: `envelope:${digest}`,
    },
    next_head: { boundary, epoch, checkpoint_digest: digest },
    outbox_entries,
    consumed_closure: {
      boundary,
      epoch,
      roster_digest: "roster",
      frontier_digest: "frontier",
      certificate_digest: "certificate",
    },
    next_outbox_entry_count: activeOutboxCount + destinations.length,
    next_created_order: image.next_created_order + destinations.length,
  };
}

function fixture(capacity = 8) {
  const factory = new IDBFactory();
  const name = `player-local-${crypto.randomUUID()}`;
  const config = { ...configuration, outbox_capacity: capacity };
  return {
    factory,
    name,
    config,
    open: () => IndexedDbPlayerLocalStore.open(factory, name, config),
  };
}

test("IndexedDB persists forks, an atomic seal, leases, and ACK evidence", async () => {
  const database = fixture();
  const store = await database.open();
  assert.deepEqual(await store.admitEvent(event(0, "event-0")), {
    decision: "stored",
  });
  assert.deepEqual(await store.admitEvent(event(0, "event-0")), {
    decision: "duplicate",
  });
  assert.deepEqual(await store.admitEvent(event(0, "event-fork")), {
    decision: "equivocation",
  });
  assert.deepEqual(await store.commitSeal(sealWriteSet(await store.image())), {
    decision: "committed",
  });
  await store.close();

  const restarted = await database.open();
  const restored = await restarted.image();
  assert.equal(restored.events.length, 1);
  assert.equal(restored.equivocations.length, 1);
  assert.equal(restored.checkpoints.length, 1);
  assert.equal(restored.outbox.length, 2);
  assert.deepEqual(await restarted.claimOutbox(0, 100, 30), {
    boundary,
    destination_id: "authority",
    epoch: 0,
    checkpoint_digest: "checkpoint-0",
    canonical_envelope: "envelope:checkpoint-0",
    created_order: 0,
    state: { kind: "in_flight", lease_expires_at_ms: 130 },
  });
  assert.deepEqual(await restarted.acknowledgeOutbox({
    boundary,
    authority_id: "authority",
    epoch: 0,
    checkpoint_digest: "checkpoint-0",
    decision: "accepted",
  }), { decision: "updated" });
  await restarted.close();

  const afterAckRestart = await database.open();
  const acknowledged = await afterAckRestart.image();
  assert.equal(acknowledged.ack_history.length, 1);
  assert.deepEqual(acknowledged.outbox[0]?.state, { kind: "acknowledged" });
  await afterAckRestart.close();
});

for (
  const faultPoint of [
    "after_history",
    "after_head",
    "after_outbox",
    "after_closure",
  ] as const
) {
  test(`IndexedDB rolls back ${faultPoint} without a partial seal`, async () => {
    const database = fixture();
    const store = await database.open();
    const before = await store.image();
    await assert.rejects(
      store.commitSeal(sealWriteSet(before), faultPoint),
      (error) =>
        error instanceof InjectedIndexedDbPlayerLocalSealFault &&
        error.faultPoint === faultPoint,
    );
    assert.deepEqual(await store.image(), before);
    assert.deepEqual(await store.commitSeal(sealWriteSet(before)), {
      decision: "committed",
    });
    await store.close();
  });
}

test("IndexedDB rejects stale CAS and invalid capacity atomically", async () => {
  const staleDatabase = fixture();
  const staleStore = await staleDatabase.open();
  const stale = sealWriteSet(await staleStore.image());
  await staleStore.admitEvent(event(0, "late-event"));
  const beforeStaleCommit = await staleStore.image();
  assert.deepEqual(await staleStore.commitSeal(stale), {
    decision: "concurrent_write",
  });
  assert.deepEqual(await staleStore.image(), beforeStaleCommit);
  await staleStore.close();

  const capacityDatabase = fixture(1);
  const capacityStore = await capacityDatabase.open();
  const beforeCapacity = await capacityStore.image();
  assert.deepEqual(
    await capacityStore.commitSeal(
      sealWriteSet(beforeCapacity, ["authority", "peer-bob"]),
    ),
    { decision: "refused", reason: "invalid_write_set" },
  );
  assert.deepEqual(await capacityStore.image(), beforeCapacity);
  await capacityStore.close();
});

test("IndexedDB reuses capacity after ACK while retaining evidence", async () => {
  const database = fixture(1);
  const store = await database.open();
  assert.deepEqual(
    await store.commitSeal(
      sealWriteSet(await store.image(), ["authority"], "checkpoint-0"),
    ),
    { decision: "committed" },
  );
  assert(await store.claimOutbox(0, 100, 30));
  assert.deepEqual(await store.acknowledgeOutbox({
    boundary,
    authority_id: "authority",
    epoch: 0,
    checkpoint_digest: "checkpoint-0",
    decision: "accepted",
  }), { decision: "updated" });
  assert.deepEqual(
    await store.commitSeal(
      sealWriteSet(await store.image(), ["authority"], "checkpoint-1"),
    ),
    { decision: "committed" },
  );
  const image = await store.image();
  assert.equal(image.outbox.length, 2);
  assert.equal(image.ack_history.length, 1);
  await store.close();
});

test("IndexedDB refuses a restart image with a missing ACK footprint", async () => {
  const database = fixture();
  const store = await database.open();
  await store.commitSeal(
    sealWriteSet(await store.image(), ["authority"], "checkpoint-0"),
  );
  await store.claimOutbox(0, 100, 30);
  await store.acknowledgeOutbox({
    boundary,
    authority_id: "authority",
    epoch: 0,
    checkpoint_digest: "checkpoint-0",
    decision: "duplicate",
  });
  await store.close();

  const raw = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = database.factory.open(database.name);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  const transaction = raw.transaction("player_local_ack_history", "readwrite");
  transaction.objectStore("player_local_ack_history").clear();
  await new Promise<void>((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error);
  });
  raw.close();

  await assert.rejects(database.open(), PlayerLocalIndexedDbCorruptError);
});

test("browser runtime commits only a MoonBit-prepared write set", async () => {
  const database = fixture(1);
  const runtime = await BrowserPlayerLocalCheckpointRuntime.open({
    factory: database.factory,
    databaseName: database.name,
    configuration: database.config,
  });
  assert.deepEqual(await runtime.seal(
    {
      boundary,
      epoch: 0,
      previous_checkpoint: "genesis",
      checkpoint_digest: "checkpoint-0",
      canonical_envelope: "envelope:checkpoint-0",
    },
    {
      boundary,
      epoch: 0,
      roster_digest: "roster",
      frontier_digest: "frontier",
      certificate_digest: "certificate",
    },
    ["authority"],
  ), { decision: "committed" });
  assert.equal((await runtime.image()).outbox.length, 1);
  assert.equal(await runtime.acknowledge({
    authorityId: "authority",
    checkpointDigest: "checkpoint-0",
    decision: "accepted",
    authenticationSucceeded: true,
  }), "acknowledged");
  assert.deepEqual((await runtime.image()).outbox[0]?.state, {
    kind: "acknowledged",
  });
  runtime.close();
});

test("browser runtime admits and resolves evidence holds only through authenticated exact bindings", async () => {
  const database = fixture(1);
  const runtime = await BrowserPlayerLocalCheckpointRuntime.open({
    factory: database.factory,
    databaseName: database.name,
    configuration: database.config,
  });
  assert.deepEqual(await runtime.seal(
    {
      boundary,
      epoch: 0,
      previous_checkpoint: "genesis",
      checkpoint_digest: "checkpoint-0",
      canonical_envelope: "envelope:checkpoint-0",
    },
    {
      boundary,
      epoch: 0,
      roster_digest: "roster",
      frontier_digest: "frontier",
      certificate_digest: "certificate",
    },
    ["authority"],
  ), { decision: "committed" });
  const hold = {
    boundary,
    hold_id: "challenge-0",
    epoch: 0,
    checkpoint_digest: "checkpoint-0",
    kind: "challenge" as const,
    reference_digest: "challenge-reference-0",
    state: { kind: "active" as const },
  };
  assert.deepEqual(await runtime.placeEvidenceHold({
    hold,
    authenticationSucceeded: false,
  }), { decision: "refused", reason: "policy_rejected" });
  assert.equal((await runtime.image()).evidence_holds.length, 0);
  assert.deepEqual(await runtime.placeEvidenceHold({
    hold,
    authenticationSucceeded: true,
  }), { decision: "stored" });
  assert.deepEqual(await runtime.resolveEvidenceHold({
    resolution: {
      boundary,
      hold_id: hold.hold_id,
      epoch: hold.epoch,
      checkpoint_digest: hold.checkpoint_digest,
      reference_digest: "wrong-reference",
      decision: "dismissed",
      resolution_digest: "resolution-0",
    },
    authenticationSucceeded: true,
  }), { decision: "refused", reason: "policy_rejected" });
  assert.deepEqual(await runtime.resolveEvidenceHold({
    resolution: {
      boundary,
      hold_id: hold.hold_id,
      epoch: hold.epoch,
      checkpoint_digest: hold.checkpoint_digest,
      reference_digest: hold.reference_digest,
      decision: "dismissed",
      resolution_digest: "resolution-0",
    },
    authenticationSucceeded: false,
  }), { decision: "refused", reason: "policy_rejected" });
  assert.deepEqual(await runtime.resolveEvidenceHold({
    resolution: {
      boundary,
      hold_id: hold.hold_id,
      epoch: hold.epoch,
      checkpoint_digest: hold.checkpoint_digest,
      reference_digest: hold.reference_digest,
      decision: "dismissed",
      resolution_digest: "resolution-0",
    },
    authenticationSucceeded: true,
  }), { decision: "resolved" });
  runtime.close();
});

test("browser runtime ingests signed evidence-hold envelopes through a replaceable authenticator", async () => {
  const database = fixture(1);
  const runtime = await BrowserPlayerLocalCheckpointRuntime.open({
    factory: database.factory,
    databaseName: database.name,
    configuration: database.config,
  });
  assert.deepEqual(await runtime.seal(
    {
      boundary,
      epoch: 0,
      previous_checkpoint: "genesis",
      checkpoint_digest: "checkpoint-0",
      canonical_envelope: "envelope:checkpoint-0",
    },
    {
      boundary,
      epoch: 0,
      roster_digest: "roster",
      frontier_digest: "frontier",
      certificate_digest: "certificate",
    },
    ["authority"],
  ), { decision: "committed" });
  const seed =
    "000102030405060708090a0b0c0d0e0f" +
    "101112131415161718191a1b1c1d1e1f";
  const sourceId = "authority-a";
  const authenticator = createMoonBitEd25519EvidenceHoldAuthenticator({
    [sourceId]: audit_browser_ed25519_public_key(seed),
  });
  const sign = (unsigned: PlayerLocalEvidenceHoldUnsignedEnvelope) => {
    const messageDigest = audit_browser_sha256(
      playerLocalEvidenceHoldEnvelopeStatement(unsigned),
    );
    return {
      ...unsigned,
      message_digest: messageDigest,
      authentication: {
        scheme: "moonbit-ed25519-v1" as const,
        signature: audit_browser_ed25519_sign(seed, messageDigest),
      },
    };
  };
  const placement: PlayerLocalEvidenceHoldUnsignedEnvelope = {
    version: 1,
    source_id: sourceId,
    message_id: "challenge-0",
    sequence: 0,
    previous_message_digest: "inbox-genesis",
    operation: {
      kind: "place",
      hold: {
        boundary,
        hold_id: "challenge-0",
        epoch: 0,
        checkpoint_digest: "checkpoint-0",
        kind: "challenge",
        reference_digest: "challenge-reference-0",
        state: { kind: "active" },
      },
    },
  };
  const signedPlacement = sign(placement);
  assert.deepEqual(await runtime.ingestEvidenceHoldEnvelope({
    envelope: {
      ...signedPlacement,
      authentication: {
        ...signedPlacement.authentication,
        signature: "0".repeat(128),
      },
    },
    expectedSourceId: sourceId,
    initialMessageDigest: "inbox-genesis",
    authenticator,
  }), { decision: "refused", reason: "authentication_failed" });
  assert.equal((await runtime.image()).evidence_holds.length, 0);
  assert.deepEqual(await runtime.ingestEvidenceHoldEnvelope({
    envelope: sign({ ...placement, message_id: "different-hold" }),
    expectedSourceId: sourceId,
    initialMessageDigest: "inbox-genesis",
    authenticator,
  }), { decision: "refused", reason: "invalid_envelope" });
  assert.deepEqual(await runtime.ingestEvidenceHoldEnvelope({
    envelope: signedPlacement,
    expectedSourceId: sourceId,
    initialMessageDigest: "inbox-genesis",
    authenticator,
  }), { decision: "applied" });

  const resolution: PlayerLocalEvidenceHoldUnsignedEnvelope = {
    version: 1,
    source_id: sourceId,
    message_id: "challenge-0",
    sequence: 1,
    previous_message_digest: signedPlacement.message_digest,
    operation: {
      kind: "resolve",
      resolution: {
        boundary,
        hold_id: "challenge-0",
        epoch: 0,
        checkpoint_digest: "checkpoint-0",
        reference_digest: "challenge-reference-0",
        decision: "dismissed",
        resolution_digest: "resolution-0",
      },
    },
  };
  const signedResolution = sign(resolution);
  assert.deepEqual(await runtime.ingestEvidenceHoldEnvelope({
    envelope: sign({
      ...resolution,
      previous_message_digest: "unrelated-inbox-head",
    }),
    expectedSourceId: sourceId,
    initialMessageDigest: "inbox-genesis",
    authenticator,
  }), { decision: "refused", reason: "cursor_mismatch" });
  assert.deepEqual(await runtime.ingestEvidenceHoldEnvelope({
    envelope: sign({
      ...resolution,
      sequence: 2,
    }),
    expectedSourceId: sourceId,
    initialMessageDigest: "inbox-genesis",
    authenticator,
  }), { decision: "refused", reason: "cursor_mismatch" });
  assert.equal(
    (await runtime.image()).evidence_holds[0]?.state.kind,
    "active",
  );
  assert.deepEqual(await runtime.ingestEvidenceHoldEnvelope({
    envelope: signedResolution,
    expectedSourceId: sourceId,
    initialMessageDigest: "inbox-genesis",
    authenticator,
  }), { decision: "applied" });
  assert.deepEqual(await runtime.ingestEvidenceHoldEnvelope({
    envelope: signedResolution,
    expectedSourceId: sourceId,
    initialMessageDigest: "inbox-genesis",
    authenticator,
  }), { decision: "no_change" });
  assert.deepEqual(await runtime.ingestEvidenceHoldEnvelope({
    envelope: sign({
      ...placement,
      sequence: 2,
      previous_message_digest: signedResolution.message_digest,
    }),
    expectedSourceId: sourceId,
    initialMessageDigest: "inbox-genesis",
    authenticator,
  }), { decision: "refused", reason: "policy_rejected" });
  assert.equal(
    (await runtime.image()).evidence_inbox_cursors[0]?.sequence,
    1,
  );
  assert.deepEqual(await runtime.ingestEvidenceHoldEnvelope({
    envelope: signedResolution,
    expectedSourceId: "unknown-authority",
    initialMessageDigest: "inbox-genesis",
    authenticator,
  }), { decision: "refused", reason: "source_mismatch" });
  runtime.close();
});

test("IndexedDB aborts a quota-shaped failure without publishing a head", async () => {
  const database = fixture();
  const store = await IndexedDbPlayerLocalStore.open(
    database.factory,
    database.name,
    database.config,
    {
      injectWriteFault(point) {
        if (point === "after_outbox") {
          throw new DOMException("simulated quota exhaustion", "QuotaExceededError");
        }
      },
    },
  );
  const before = await store.image();
  await assert.rejects(
    store.commitSeal(sealWriteSet(before)),
    (error) => error instanceof DOMException && error.name === "QuotaExceededError",
  );
  assert.deepEqual(await store.image(), before);
  await store.close();
});

test("IndexedDB migrates a legacy database and fails closed on a newer schema", async () => {
  const factory = new IDBFactory();
  const legacyName = `player-local-legacy-${crypto.randomUUID()}`;
  const legacy = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = factory.open(legacyName, 1);
    request.onupgradeneeded = () => request.result.createObjectStore("legacy");
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  legacy.close();
  const migrated = await IndexedDbPlayerLocalStore.open(
    factory,
    legacyName,
    configuration,
  );
  assert.deepEqual((await migrated.image()).head, {
    boundary,
    epoch: -1,
    checkpoint_digest: "genesis",
  });
  await migrated.close();

  const newerName = `player-local-newer-${crypto.randomUUID()}`;
  const newer = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = factory.open(newerName, 7);
    request.onupgradeneeded = () => {
      const marker = request.result.createObjectStore("marker");
      marker.put("unchanged", "state");
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  newer.close();
  await assert.rejects(
    IndexedDbPlayerLocalStore.open(factory, newerName, configuration),
    (error) => error instanceof DOMException && error.name === "VersionError",
  );
  const reopened = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = factory.open(newerName, 7);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  const marker = reopened.transaction("marker", "readonly")
    .objectStore("marker").get("state");
  assert.equal(await new Promise((resolve, reject) => {
    marker.onsuccess = () => resolve(marker.result);
    marker.onerror = () => reject(marker.error);
  }), "unchanged");
  reopened.close();
});

test("IndexedDB fails closed when a schema upgrade is blocked", async () => {
  const factory = new IDBFactory();
  const name = `player-local-blocked-${crypto.randomUUID()}`;
  const blocker = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = factory.open(name, 1);
    request.onupgradeneeded = () => request.result.createObjectStore("legacy");
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });

  await assert.rejects(
    IndexedDbPlayerLocalStore.open(factory, name, configuration),
    (error) =>
      error instanceof PlayerLocalIndexedDbCorruptError &&
      error.message.includes("upgrade is blocked"),
  );
  blocker.close();
});

runPlayerLocalStorageConformance(
  "IndexedDB",
  async (_t, outboxCapacity) => {
    const factory = new IDBFactory();
    const name = `player-local-suite-${crypto.randomUUID()}`;
    const suiteConfiguration = {
      ...configuration,
      outbox_capacity: outboxCapacity,
    };
    return {
      configuration: suiteConfiguration,
      open: () => IndexedDbPlayerLocalStore.open(
        factory,
        name,
        suiteConfiguration,
      ),
    };
  },
);
