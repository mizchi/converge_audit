import type {
  AuditBoundary,
  CheckpointSealDraft,
  EpochClosureEvidence,
} from "../../../../player-local-runtime/contracts.ts";
import {
  playerLocalEvidenceHoldEnvelopeStatement,
  type PlayerLocalEvidenceHoldUnsignedEnvelope,
} from "../../../../player-local-runtime/evidence-hold-wire.ts";
import {
  audit_browser_ed25519_public_key,
  audit_browser_ed25519_sign,
  audit_browser_sha256,
} from "../../../../../_build/js/release/build/x/game_audit/browser_bridge/browser_bridge.js";
import {
  createMoonBitEd25519EvidenceHoldAuthenticator,
} from "./evidence-hold-authenticator.ts";
import { pollPlayerLocalEvidenceInbox } from "./evidence-inbox-poller.ts";
import { BrowserPlayerLocalCheckpointRuntime } from "./player-local-checkpoint-runtime.ts";

export interface BrowserPlayerLocalBenchmarkResult {
  engine: "chromium-indexeddb";
  epochs: number;
  retained_epochs: number;
  logical_image_bytes: number;
  logical_image_bytes_before_prune: number;
  initial_open_ms: number;
  checkpoint_ms: BrowserLatencySummary;
  ack_ms: BrowserLatencySummary;
  prune_ms: number;
  reload_ms: number;
  evidence_inbox_poll: {
    messages: number;
    response_bytes: number;
    total_ms: number;
    per_message_ms: number;
    last_sequence: number;
  };
  restored: {
    checkpoint_count: number;
    outbox_tombstones: number;
    ack_evidence: number;
    head_epoch: number;
    retention_anchor_epoch: number;
  };
}

interface BrowserLatencySummary {
  count: number;
  mean_ms: number;
  p50_ms: number;
  p95_ms: number;
  p99_ms: number;
  max_ms: number;
}

function summarize(values: number[]): BrowserLatencySummary {
  const sorted = [...values].sort((left, right) => left - right);
  const percentile = (ratio: number) =>
    sorted[Math.max(0, Math.ceil(sorted.length * ratio) - 1)] ?? 0;
  return {
    count: values.length,
    mean_ms: values.reduce((sum, value) => sum + value, 0) / values.length,
    p50_ms: percentile(0.5),
    p95_ms: percentile(0.95),
    p99_ms: percentile(0.99),
    max_ms: sorted.at(-1) ?? 0,
  };
}

async function benchmarkEvidenceInboxPoll(): Promise<
  BrowserPlayerLocalBenchmarkResult["evidence_inbox_poll"]
> {
  const pollBoundary: AuditBoundary = {
    protocol_version: 1,
    purpose: "checkpoint-v1",
    manifest_digest: "manifest-browser-poll-benchmark",
    scope_id: "player-browser-poll-benchmark",
    unit_id: "run-browser-poll-benchmark",
  };
  const runtime = await BrowserPlayerLocalCheckpointRuntime.open({
    factory: indexedDB,
    databaseName: `player-local-poll-benchmark-${crypto.randomUUID()}`,
    configuration: {
      boundary: pollBoundary,
      genesis_digest: "genesis",
      outbox_capacity: 1,
    },
  });
  const sealed = await runtime.seal({
    boundary: pollBoundary,
    epoch: 0,
    previous_checkpoint: "genesis",
    checkpoint_digest: "checkpoint-0",
    canonical_envelope: "envelope:checkpoint-0",
  }, {
    boundary: pollBoundary,
    epoch: 0,
    roster_digest: "roster",
    frontier_digest: "frontier",
    certificate_digest: "certificate",
  }, ["authority"]);
  if (sealed.decision !== "committed") {
    runtime.close();
    throw new Error(`poll benchmark seal refused: ${sealed.decision}`);
  }
  const seed =
    "000102030405060708090a0b0c0d0e0f" +
    "101112131415161718191a1b1c1d1e1f";
  const sourceId = "authority-benchmark";
  const initialMessageDigest = "inbox-benchmark-genesis";
  const messages: unknown[] = [];
  let previousMessageDigest = initialMessageDigest;
  for (let sequence = 0; sequence < 16; sequence += 1) {
    const holdId = `challenge-${sequence}`;
    const unsigned: PlayerLocalEvidenceHoldUnsignedEnvelope = {
      version: 1,
      source_id: sourceId,
      message_id: holdId,
      sequence,
      previous_message_digest: previousMessageDigest,
      operation: {
        kind: "place",
        hold: {
          boundary: pollBoundary,
          hold_id: holdId,
          epoch: 0,
          checkpoint_digest: "checkpoint-0",
          kind: "challenge",
          reference_digest: `challenge-reference-${sequence}`,
          state: { kind: "active" },
        },
      },
    };
    const messageDigest = audit_browser_sha256(
      playerLocalEvidenceHoldEnvelopeStatement(unsigned),
    );
    messages.push({
      ...unsigned,
      message_digest: messageDigest,
      authentication: {
        scheme: "moonbit-ed25519-v1",
        signature: audit_browser_ed25519_sign(seed, messageDigest),
      },
    });
    previousMessageDigest = messageDigest;
  }
  const responseText = JSON.stringify({
    version: 1,
    source_id: sourceId,
    after_sequence: -1,
    after_message_digest: initialMessageDigest,
    messages,
  });
  const responseBytes = new TextEncoder().encode(responseText).byteLength;
  const started = performance.now();
  const result = await pollPlayerLocalEvidenceInbox({
    runtime,
    endpoint: "https://audit.example/evidence-inbox",
    expectedSourceId: sourceId,
    initialMessageDigest,
    authenticator: createMoonBitEd25519EvidenceHoldAuthenticator({
      [sourceId]: audit_browser_ed25519_public_key(seed),
    }),
    deadlineAtMs: 2_000,
    maxMessagesPerPage: 16,
    maxResponseBytes: 1_048_576,
    requestTimeoutMs: 1_000,
    fetcher: (async () => new Response(responseText, {
      headers: { "content-type": "application/json" },
    })) as typeof fetch,
    now: () => 1_000,
  });
  const totalMs = performance.now() - started;
  runtime.close();
  if (result.decision !== "applied" || result.applied_messages !== 16) {
    throw new Error(`poll benchmark refused: ${result.decision}`);
  }
  return {
    messages: 16,
    response_bytes: responseBytes,
    total_ms: totalMs,
    per_message_ms: totalMs / 16,
    last_sequence: result.last_sequence,
  };
}

export async function benchmarkPlayerLocalIndexedDb(
  epochs: number,
): Promise<BrowserPlayerLocalBenchmarkResult> {
  if (!Number.isSafeInteger(epochs) || epochs <= 0 || epochs > 4_096) {
    throw new TypeError("invalid benchmark epoch count");
  }
  const databaseName = `player-local-browser-benchmark-${crypto.randomUUID()}`;
  const boundary: AuditBoundary = {
    protocol_version: 1,
    purpose: "checkpoint-v1",
    manifest_digest: "manifest-browser-benchmark",
    scope_id: "player-browser-benchmark",
    unit_id: "run-browser-benchmark",
  };
  const configuration = {
    boundary,
    genesis_digest: "genesis",
    outbox_capacity: 1,
  };
  const openStarted = performance.now();
  let runtime = await BrowserPlayerLocalCheckpointRuntime.open({
    factory: indexedDB,
    databaseName,
    configuration,
  });
  const initialOpenMs = performance.now() - openStarted;
  const sealMs: number[] = [];
  const ackMs: number[] = [];
  let previousCheckpoint = "genesis";
  for (let epoch = 0; epoch < epochs; epoch += 1) {
    const checkpointDigest = `checkpoint-${String(epoch).padStart(6, "0")}`;
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
      throw new Error(`seal refused: ${sealed.decision}`);
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
      throw new Error(`ACK refused: ${acknowledged}`);
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
  ) throw new Error(`prune refused: ${pruned.decision}`);
  const image = await runtime.image();
  const logicalImageBytes = new TextEncoder().encode(JSON.stringify(image)).length;
  runtime.close();
  const reloadStarted = performance.now();
  runtime = await BrowserPlayerLocalCheckpointRuntime.open({
    factory: indexedDB,
    databaseName,
    configuration,
  });
  const reloadMs = performance.now() - reloadStarted;
  const restored = await runtime.image();
  runtime.close();
  const evidenceInboxPoll = await benchmarkEvidenceInboxPoll();
  return {
    engine: "chromium-indexeddb",
    epochs,
    retained_epochs: retainedEpochs,
    logical_image_bytes: logicalImageBytes,
    logical_image_bytes_before_prune: logicalImageBytesBeforePrune,
    initial_open_ms: initialOpenMs,
    checkpoint_ms: summarize(sealMs),
    ack_ms: summarize(ackMs),
    prune_ms: pruneMs,
    reload_ms: reloadMs,
    evidence_inbox_poll: evidenceInboxPoll,
    restored: {
      checkpoint_count: restored.checkpoints.length,
      outbox_tombstones: restored.outbox.length,
      ack_evidence: restored.ack_history.length,
      head_epoch: restored.head.epoch,
      retention_anchor_epoch: restored.retention_anchor.epoch,
    },
  };
}

declare global {
  interface Window {
    __convergePlayerLocalBenchmark?: typeof benchmarkPlayerLocalIndexedDb;
  }
}

export function installPlayerLocalBenchmark(): void {
  window.__convergePlayerLocalBenchmark = benchmarkPlayerLocalIndexedDb;
}
