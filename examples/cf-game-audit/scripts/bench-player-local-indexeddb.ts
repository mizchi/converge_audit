import { IDBFactory } from "fake-indexeddb";

import type {
  AuditBoundary,
  CheckpointSealDraft,
  EpochClosureEvidence,
} from "../../player-local-runtime/contracts.ts";
import { summarizeLatency } from "../src/benchmark-metrics.ts";
import { BrowserPlayerLocalCheckpointRuntime } from "../web/src/audit/player-local-checkpoint-runtime.ts";

const epochs = Number(
  process.env.AUDIT_PLAYER_LOCAL_INDEXEDDB_BENCH_EPOCHS ?? 128,
);
if (!Number.isSafeInteger(epochs) || epochs <= 0 || epochs > 4_096) {
  throw new TypeError("invalid AUDIT_PLAYER_LOCAL_INDEXEDDB_BENCH_EPOCHS");
}

const boundary: AuditBoundary = {
  protocol_version: 1,
  purpose: "checkpoint-v1",
  manifest_digest: "manifest-benchmark",
  scope_id: "player-benchmark",
  unit_id: "run-benchmark",
};
const factory = new IDBFactory();
const databaseName = "player-local-indexeddb-benchmark";

const openStarted = performance.now();
let runtime = await BrowserPlayerLocalCheckpointRuntime.open({
  factory,
  databaseName,
  configuration: {
    boundary,
    genesis_digest: "genesis",
    outbox_capacity: 1,
  },
});
const initialOpenMs = performance.now() - openStarted;

const sealMs: number[] = [];
const ackMs: number[] = [];
let previousCheckpoint = "genesis";
for (let epoch = 0; epoch < epochs; epoch += 1) {
  const checkpointDigest = `checkpoint-${epoch.toString().padStart(6, "0")}`;
  const checkpoint: CheckpointSealDraft = {
    boundary,
    epoch,
    previous_checkpoint: previousCheckpoint,
    checkpoint_digest: checkpointDigest,
    canonical_envelope: `envelope:${checkpointDigest}`,
  };
  const closure: EpochClosureEvidence = {
    boundary,
    epoch,
    roster_digest: "roster",
    frontier_digest: `frontier-${epoch}`,
    certificate_digest: `certificate-${epoch}`,
  };
  const sealStarted = performance.now();
  const sealed = await runtime.seal(checkpoint, closure, ["authority"]);
  sealMs.push(performance.now() - sealStarted);
  if (sealed.decision !== "committed") {
    throw new Error(`benchmark seal refused at ${epoch}: ${sealed.decision}`);
  }
  const ackStarted = performance.now();
  const acknowledged = await runtime.acknowledge({
    authorityId: "authority",
    checkpointDigest,
    decision: "accepted",
    authenticationSucceeded: true,
  });
  ackMs.push(performance.now() - ackStarted);
  if (acknowledged !== "acknowledged") {
    throw new Error(`benchmark ACK refused at ${epoch}: ${acknowledged}`);
  }
  previousCheckpoint = checkpointDigest;
}

const beforePrune = await runtime.image();
const logicalImageBytesBeforePrune = new TextEncoder().encode(
  JSON.stringify(beforePrune),
).length;
const retainedEpochs = Math.min(120, epochs);
const pruneStarted = performance.now();
const pruned = await runtime.prune({
  retain_from_epoch: epochs - retainedEpochs,
  protected_epochs: [],
});
const pruneMs = performance.now() - pruneStarted;
if (
  epochs > retainedEpochs && pruned.decision !== "pruned" ||
  epochs === retainedEpochs && pruned.decision !== "no_change"
) throw new Error(`benchmark prune refused: ${pruned.decision}`);
const image = await runtime.image();
const logicalImageBytes = new TextEncoder().encode(JSON.stringify(image)).length;
runtime.close();

const reloadStarted = performance.now();
runtime = await BrowserPlayerLocalCheckpointRuntime.open({
  factory,
  databaseName,
  configuration: {
    boundary,
    genesis_digest: "genesis",
    outbox_capacity: 1,
  },
});
const reloadMs = performance.now() - reloadStarted;
const restored = await runtime.image();
runtime.close();

console.log(JSON.stringify({
  engine: "fake-indexeddb-node-reference",
  epochs,
  retained_epochs: retainedEpochs,
  logical_image_bytes: logicalImageBytes,
  logical_image_bytes_before_prune: logicalImageBytesBeforePrune,
  initial_open_ms: Math.round(initialOpenMs * 1_000) / 1_000,
  checkpoint_ms: summarizeLatency(sealMs),
  ack_ms: summarizeLatency(ackMs),
  prune_ms: Math.round(pruneMs * 1_000) / 1_000,
  reload_ms: Math.round(reloadMs * 1_000) / 1_000,
  restored: {
    checkpoint_count: restored.checkpoints.length,
    outbox_tombstones: restored.outbox.length,
    ack_evidence: restored.ack_history.length,
    head_epoch: restored.head.epoch,
    retention_anchor_epoch: restored.retention_anchor.epoch,
  },
}, null, 2));
