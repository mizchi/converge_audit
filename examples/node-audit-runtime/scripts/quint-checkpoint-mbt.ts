import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { MoonBitCheckpointPolicy } from "../src/moonbit-checkpoint-policy.ts";
import {
  PlayerLocalSqliteStore,
  type AuditBoundary,
  type CheckpointSealDraft,
  type PlayerLocalAuditEvent,
  type PlayerLocalSealWriteSet,
} from "../src/player-local-sqlite.ts";

type Peer = "P1" | "P2";
type Event = "EventA" | "EventB" | "EventC";

interface Digest {
  epoch: number;
  events: Event[];
}

interface Checkpoint {
  producer: Peer;
  epoch: number;
  parent: Digest;
  events: Event[];
}

interface ModelState {
  accepted: Map<Peer, Event[]>;
  headLog: Map<string, Checkpoint[]>;
  durableOutbox: Map<Peer, Checkpoint[]>;
}

interface ItfTrace {
  states: Array<Record<string, unknown>>;
}

interface PeerStore {
  boundary: AuditBoundary;
  path: string;
  store?: PlayerLocalSqliteStore;
}

const authorityId = "authority";
const eventMetadata: Record<
  Event,
  { owner: Peer; counter: number; epoch: number }
> = {
  EventA: { owner: "P1", counter: 0, epoch: 0 },
  EventB: { owner: "P2", counter: 0, epoch: 0 },
  EventC: { owner: "P1", counter: 1, epoch: 1 },
};

function record(value: unknown, label: string): Record<string, unknown> {
  assert(value !== null && typeof value === "object" && !Array.isArray(value), label);
  return value as Record<string, unknown>;
}

function numberValue(value: unknown): number {
  if (typeof value === "number") return value;
  const encoded = record(value, "expected ITF integer")["#bigint"];
  assert.equal(typeof encoded, "string", "expected ITF bigint string");
  const decoded = Number(encoded);
  assert(Number.isSafeInteger(decoded), "ITF integer exceeds host range");
  return decoded;
}

function variantTag(value: unknown): string {
  const tag = record(value, "expected ITF variant").tag;
  assert(typeof tag === "string", "expected ITF variant tag");
  return tag;
}

function setValues(value: unknown): unknown[] {
  const values = record(value, "expected ITF set")["#set"];
  assert(Array.isArray(values), "expected ITF set entries");
  return values;
}

function mapEntries(value: unknown): Array<[unknown, unknown]> {
  const entries = record(value, "expected ITF map")["#map"];
  assert(Array.isArray(entries), "expected ITF map entries");
  return entries.map((entry) => {
    assert(Array.isArray(entry) && entry.length === 2, "invalid ITF map entry");
    return [entry[0], entry[1]];
  });
}

function decodeEvents(value: unknown): Event[] {
  return setValues(value).map((event) => variantTag(event) as Event).sort();
}

function decodeDigest(value: unknown): Digest {
  const digest = record(value, "expected digest");
  return {
    epoch: numberValue(digest.epoch),
    events: decodeEvents(digest.events),
  };
}

function decodeCheckpoint(value: unknown): Checkpoint {
  const checkpoint = record(value, "expected checkpoint");
  return {
    producer: variantTag(checkpoint.producer) as Peer,
    epoch: numberValue(checkpoint.epoch),
    parent: decodeDigest(checkpoint.parent),
    events: decodeEvents(checkpoint.events),
  };
}

function nodeName(value: unknown): string {
  const node = record(value, "expected node");
  const tag = variantTag(node);
  if (tag === "Authority") return authorityId;
  assert.equal(tag, "PeerNode");
  return `peer:${variantTag(node.value)}`;
}

function decodeModelState(itfState: Record<string, unknown>): ModelState {
  const stateKey = Object.keys(itfState).find((key) => key.endsWith("::state"));
  assert(stateKey, "trace state is missing the protocol state variable");
  const state = record(itfState[stateKey], "expected protocol state");
  const accepted = new Map<Peer, Event[]>();
  for (const [key, value] of mapEntries(state.accepted)) {
    accepted.set(variantTag(key) as Peer, decodeEvents(value));
  }
  const headLog = new Map<string, Checkpoint[]>();
  for (const [key, value] of mapEntries(state.headLog)) {
    assert(Array.isArray(value), "expected checkpoint log");
    headLog.set(nodeName(key), value.map(decodeCheckpoint));
  }
  const durableOutbox = new Map<Peer, Checkpoint[]>();
  for (const [key, value] of mapEntries(state.durableOutbox)) {
    durableOutbox.set(
      variantTag(key) as Peer,
      setValues(value).map(decodeCheckpoint),
    );
  }
  return { accepted, headLog, durableOutbox };
}

function checkpointDigest(checkpoint: Checkpoint): string {
  return `model:${checkpoint.epoch}:${checkpoint.events.join(",")}`;
}

function digestValue(digest: Digest): string {
  return digest.epoch === 0 && digest.events.length === 0
    ? "genesis"
    : `model:${digest.epoch}:${digest.events.join(",")}`;
}

function canonicalEnvelope(checkpoint: Checkpoint): string {
  return JSON.stringify({
    epoch: checkpoint.epoch,
    events: checkpoint.events,
    parent: checkpoint.parent,
  });
}

function localEvent(event: Event, boundary: AuditBoundary): PlayerLocalAuditEvent {
  const metadata = eventMetadata[event];
  return {
    boundary,
    author_id: metadata.owner,
    counter: metadata.counter,
    epoch: metadata.epoch,
    event_digest: event,
    canonical_event: `model-event:${event}`,
  };
}

function activeOutboxCount(store: PlayerLocalSqliteStore): number {
  return store.image().outbox.filter((entry) => entry.state.kind !== "acknowledged").length;
}

function openPeer(peer: Peer, path: string): PeerStore {
  const boundary: AuditBoundary = {
    protocol_version: 1,
    purpose: "quint-checkpoint-mbt-v1",
    manifest_digest: "quint-model",
    scope_id: peer,
    unit_id: "checkpoint-delivery",
  };
  return {
    boundary,
    path,
    store: PlayerLocalSqliteStore.open(path, {
      boundary,
      genesis_digest: "genesis",
      outbox_capacity: 1,
    }),
  };
}

function requireOpen(peer: PeerStore): PlayerLocalSqliteStore {
  assert(peer.store, `peer store is closed: ${peer.boundary.scope_id}`);
  return peer.store;
}

function reopen(peer: PeerStore): void {
  assert.equal(peer.store, undefined, "peer store was already open");
  peer.store = PlayerLocalSqliteStore.open(peer.path, {
    boundary: peer.boundary,
    genesis_digest: "genesis",
    outbox_capacity: 1,
  });
}

function inspectImage(peer: PeerStore) {
  if (peer.store) return peer.store.image();
  const store = PlayerLocalSqliteStore.open(peer.path, {
    boundary: peer.boundary,
    genesis_digest: "genesis",
    outbox_capacity: 1,
  });
  try {
    return store.image();
  } finally {
    store.close();
  }
}

function checkpointFromPeerHead(state: ModelState, peer: Peer): Checkpoint {
  const log = state.headLog.get(`peer:${peer}`) ?? [];
  const checkpoint = log.at(-1);
  assert(checkpoint, `model peer ${peer} has no checkpoint`);
  return checkpoint;
}

function prepareWriteSet(
  policy: MoonBitCheckpointPolicy,
  store: PlayerLocalSqliteStore,
  checkpoint: Checkpoint,
): PlayerLocalSealWriteSet {
  const image = store.image();
  const epoch = checkpoint.epoch - 1;
  const digest = checkpointDigest(checkpoint);
  const previous = digestValue(checkpoint.parent);
  const envelope = canonicalEnvelope(checkpoint);
  const known = image.checkpoints.find((value) => value.epoch === epoch);
  const closure = image.consumed_closures.find((value) => value.epoch === epoch);
  const activeCount = activeOutboxCount(store);
  const preparation = policy.prepareSeal({
    boundary: image.boundary,
    closure: {
      epoch,
      roster_digest: `roster:${epoch}`,
      frontier_digest: `frontier:${epoch}`,
      certificate_digest: `certificate:${epoch}`,
    },
    current_epoch: image.head.epoch,
    current_digest: image.head.checkpoint_digest,
    incoming_epoch_known: known !== undefined,
    known_digest_matches: known?.checkpoint_digest === digest,
    known_seal_complete: known !== undefined &&
      known.checkpoint_digest === digest &&
      closure !== undefined &&
      image.outbox.some((entry) =>
        entry.epoch === epoch && entry.destination_id === authorityId
      ),
    closure_consumed: closure !== undefined,
    outbox_entry_count: activeCount,
    outbox_capacity: image.outbox_capacity,
    next_created_order: image.next_created_order,
    checkpoint_epoch: epoch,
    previous_checkpoint: previous,
    checkpoint_digest: digest,
    canonical_envelope: envelope,
    destinations: [authorityId],
  });
  assert.equal(preparation.decision, "prepared", JSON.stringify(preparation));
  if (preparation.decision !== "prepared") throw new Error("unreachable");
  const draft: CheckpointSealDraft = {
    boundary: image.boundary,
    epoch,
    previous_checkpoint: previous,
    checkpoint_digest: digest,
    canonical_envelope: envelope,
  };
  return {
    expected_revision: image.storage_revision,
    expected_snapshot: {
      boundary: image.boundary,
      current_epoch: image.head.epoch,
      current_digest: image.head.checkpoint_digest,
      incoming_epoch_known: known !== undefined,
      known_digest_matches: known?.checkpoint_digest === digest,
      known_seal_complete: false,
      closure_consumed: closure !== undefined,
      outbox_entry_count: activeCount,
      outbox_capacity: image.outbox_capacity,
      next_created_order: image.next_created_order,
    },
    checkpoint: draft,
    next_head: {
      boundary: image.boundary,
      epoch: preparation.epoch,
      checkpoint_digest: preparation.digest,
    },
    outbox_entries: preparation.outbox.map((entry) => ({
      boundary: image.boundary,
      ...entry,
      state: { kind: "pending" as const },
    })),
    consumed_closure: {
      boundary: image.boundary,
      epoch: preparation.closure_epoch,
      roster_digest: `roster:${epoch}`,
      frontier_digest: `frontier:${epoch}`,
      certificate_digest: `certificate:${epoch}`,
    },
    next_outbox_entry_count: preparation.next_outbox_entry_count,
    next_created_order: preparation.next_created_order,
  };
}

function compareProjection(
  model: ModelState,
  peers: Map<Peer, PeerStore>,
  authority: string[],
  action: string,
): void {
  for (const peerName of ["P1", "P2"] as const) {
    const image = inspectImage(peers.get(peerName)!);
    assert.deepEqual(
      image.events.map((event) => event.event_digest).sort(),
      model.accepted.get(peerName),
      `${action}: accepted events diverged for ${peerName}`,
    );
    assert.deepEqual(
      image.checkpoints.map((checkpoint) => checkpoint.checkpoint_digest),
      (model.headLog.get(`peer:${peerName}`) ?? []).map(checkpointDigest),
      `${action}: checkpoint chain diverged for ${peerName}`,
    );
    assert.deepEqual(
      image.outbox
        .filter((entry) => entry.state.kind !== "acknowledged")
        .map((entry) => entry.checkpoint_digest)
        .sort(),
      (model.durableOutbox.get(peerName) ?? []).map(checkpointDigest).sort(),
      `${action}: durable outbox diverged for ${peerName}`,
    );
  }
  assert.deepEqual(
    authority,
    (model.headLog.get(authorityId) ?? []).map(checkpointDigest),
    `${action}: authority head diverged`,
  );
}

async function replayTrace(
  trace: ItfTrace,
  policy: MoonBitCheckpointPolicy,
  traceIndex: number,
): Promise<void> {
  assert.equal(trace.states.length, 11, "MBT driver trace did not complete");
  const directory = await mkdtemp(join(tmpdir(), `bft-quint-replay-${traceIndex}-`));
  const peers = new Map<Peer, PeerStore>([
    ["P1", openPeer("P1", join(directory, "p1.sqlite"))],
    ["P2", openPeer("P2", join(directory, "p2.sqlite"))],
  ]);
  const authority: string[] = [];
  try {
    for (const event of ["EventA", "EventC"] as const) {
      assert.equal(
        requireOpen(peers.get("P1")!).admitEvent(localEvent(event, peers.get("P1")!.boundary)).decision,
        "stored",
      );
    }
    assert.equal(
      requireOpen(peers.get("P2")!).admitEvent(localEvent("EventB", peers.get("P2")!.boundary)).decision,
      "stored",
    );

    for (const [index, itfState] of trace.states.entries()) {
      const action = itfState["mbt::actionTaken"];
      assert.equal(typeof action, "string", "trace is missing mbt::actionTaken");
      const model = decodeModelState(itfState);
      if (index === 0) {
        assert.equal(action, "init");
      } else if (action === "gossipEpoch1Event") {
        // Transport enqueue does not mutate durable player state.
      } else if (action === "deliverEpoch1Event") {
        const peer = peers.get("P1")!;
        assert.equal(
          requireOpen(peer).admitEvent(localEvent("EventB", peer.boundary)).decision,
          "stored",
        );
      } else if (action === "sealEpoch1" || action === "sealEpoch2") {
        const store = requireOpen(peers.get("P1")!);
        const checkpoint = checkpointFromPeerHead(model, "P1");
        assert.deepEqual(
          store.commitSeal(prepareWriteSet(policy, store, checkpoint)),
          { decision: "committed" },
          `${action}: implementation refused a model-valid seal`,
        );
      } else if (action === "crashAfterSeal") {
        const peer = peers.get("P1")!;
        requireOpen(peer).close();
        peer.store = undefined;
      } else if (action === "restartWithDurableOutbox") {
        reopen(peers.get("P1")!);
      } else if (action === "sendEpoch1" || action === "sendEpoch2") {
        const store = requireOpen(peers.get("P1")!);
        const checkpoint = checkpointFromPeerHead(model, "P1");
        const digest = checkpointDigest(checkpoint);
        const entry = store.image().outbox.find((value) =>
          value.checkpoint_digest === digest && value.state.kind !== "acknowledged"
        );
        assert(entry, `${action}: model checkpoint is missing from physical outbox`);
        assert(
          store.claimOutbox(entry.created_order, index * 10, 1),
          `${action}: physical outbox was not retryable`,
        );
      } else if (action === "receiveEpoch1" || action === "receiveEpoch2") {
        const store = requireOpen(peers.get("P1")!);
        const checkpoint = checkpointFromPeerHead(model, "P1");
        const epoch = checkpoint.epoch - 1;
        const digest = checkpointDigest(checkpoint);
        const previous = digestValue(checkpoint.parent);
        const known = authority[epoch];
        const decision = policy.classifyHead({
          boundary_matches: true,
          epoch_known: known !== undefined,
          known_digest_matches: known === digest,
          current_epoch: authority.length - 1,
          incoming_epoch: epoch,
          parent_matches: previous === (authority.at(-1) ?? "genesis"),
        });
        assert(decision === "advance" || decision === "duplicate", decision);
        if (decision === "advance") authority.push(digest);
        const entry = store.image().outbox.find((value) =>
          value.destination_id === authorityId &&
          value.checkpoint_digest === digest &&
          value.state.kind !== "acknowledged"
        );
        assert(entry, `${action}: physical outbox entry is missing`);
        assert.equal(
          policy.acknowledgeOutbox({
            boundary: entry.boundary,
            destination_id: entry.destination_id,
            epoch: entry.epoch,
            checkpoint_digest: entry.checkpoint_digest,
            canonical_envelope: entry.canonical_envelope,
            created_order: entry.created_order,
            ack_boundary: entry.boundary,
            ack_authority_id: authorityId,
            ack_epoch: entry.epoch,
            ack_checkpoint_digest: entry.checkpoint_digest,
            ack_decision: decision === "advance" ? "accepted" : "duplicate",
            authentication_succeeded: true,
          }),
          "acknowledged",
        );
        assert.deepEqual(
          store.acknowledgeOutbox({
            boundary: entry.boundary,
            authority_id: authorityId,
            epoch: entry.epoch,
            checkpoint_digest: entry.checkpoint_digest,
            decision: decision === "advance" ? "accepted" : "duplicate",
          }),
          { decision: "updated" },
        );
      } else {
        assert.fail(`unsupported MBT action: ${action}`);
      }
      compareProjection(model, peers, authority, action);
    }
    const finalState = trace.states.at(-1)!;
    assert.equal(numberValue(finalState.phase), 10);
  } finally {
    for (const peer of peers.values()) peer.store?.close();
    await rm(directory, { recursive: true, force: true });
  }
}

const traceDirectory = process.argv[2];
assert(traceDirectory, "usage: quint-checkpoint-mbt.ts TRACE_DIRECTORY");
const files = (await readdir(traceDirectory))
  .filter((file) => file.endsWith(".itf.json"))
  .sort();
assert(files.length > 0, "Quint did not generate any ITF traces");
const policy = await MoonBitCheckpointPolicy.load();
for (const [index, file] of files.entries()) {
  const trace = JSON.parse(
    await readFile(join(traceDirectory, file), "utf8"),
  ) as ItfTrace;
  await replayTrace(trace, policy, index);
}
console.log(`replayed ${files.length} Quint checkpoint trace(s) against MoonBit + SQLite`);
