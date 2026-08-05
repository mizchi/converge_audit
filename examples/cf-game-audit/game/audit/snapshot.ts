import type { GameState } from "../kernel";
import {
  canonicalAuditGenesis,
  canonicalGameState,
  canonicalMicroCheckpointEnvelope,
  type AuditDigestAdapter,
  type GameAuditJournalState,
  type GameMicroCheckpoint,
  type PendingAuditEvent,
  type RetainedAuditSegment,
} from "./journal";

export interface RunSnapshot {
  version: 1;
  savedAtMs: number;
  game: GameState;
  audit: GameAuditJournalState;
}

export type RestoreRunSnapshotResult =
  | { ok: true; snapshot: RunSnapshot }
  | {
      ok: false;
      reason:
        | "invalid_snapshot"
        | "journal_game_mismatch"
        | "event_root_mismatch"
        | "checkpoint_chain_mismatch"
        | "state_digest_mismatch";
    };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function hasBasicGameShape(value: unknown): value is GameState {
  if (!isRecord(value) || !isRecord(value.player)) return false;
  return isInteger(value.seed) &&
    isInteger(value.tick) &&
    typeof value.player.id === "string" &&
    isInteger(value.player.x) &&
    isInteger(value.player.y) &&
    isInteger(value.player.hp) &&
    isInteger(value.player.maxHp) &&
    Array.isArray(value.enemies) &&
    Array.isArray(value.telegraphs) &&
    Array.isArray(value.drops) &&
    Array.isArray(value.inventory);
}

function hasBasicAuditShape(value: unknown): value is GameAuditJournalState {
  if (!isRecord(value)) return false;
  return value.version === 1 &&
    isInteger(value.seed) &&
    typeof value.playerId === "string" &&
    typeof value.ownerPublicKey === "string" &&
    /^[0-9a-f]{64}$/.test(value.ownerPublicKey) &&
    isInteger(value.cadenceTicks) && value.cadenceTicks > 0 &&
    typeof value.genesisDigest === "string" &&
    isInteger(value.nextTick) &&
    Array.isArray(value.pending) &&
    Array.isArray(value.checkpoints) &&
    Array.isArray(value.retainedSegments) &&
    isInteger(value.acknowledgedEpoch) &&
    isInteger(value.acknowledgedTick);
}

function hasCheckpointShape(value: unknown): value is GameMicroCheckpoint {
  if (!isRecord(value)) return false;
  return value.version === 1 &&
    isInteger(value.epoch) &&
    isInteger(value.firstTick) &&
    isInteger(value.lastTick) &&
    isInteger(value.eventCount) &&
    typeof value.eventRoot === "string" &&
    typeof value.stateDigest === "string" &&
    typeof value.previousCheckpoint === "string" &&
    typeof value.checkpointDigest === "string" &&
    typeof value.canonicalEnvelope === "string" &&
    isStringArray(value.createdAssetIds);
}

function hasEventShape(value: unknown): value is PendingAuditEvent {
  if (!isRecord(value)) return false;
  return isInteger(value.tick) &&
    typeof value.canonicalPayload === "string" &&
    isStringArray(value.createdAssetIds);
}

function hasSegmentShape(value: unknown): value is RetainedAuditSegment {
  if (!isRecord(value)) return false;
  return isInteger(value.epoch) &&
    typeof value.checkpointDigest === "string" &&
    Array.isArray(value.events) && value.events.every(hasEventShape);
}

export function restoreRunSnapshot(
  value: unknown,
  digest: AuditDigestAdapter,
): RestoreRunSnapshotResult {
  if (
    !isRecord(value) ||
    value.version !== 1 ||
    !isInteger(value.savedAtMs) ||
    value.savedAtMs < 0 ||
    !hasBasicGameShape(value.game) ||
    !hasBasicAuditShape(value.audit)
  ) {
    return { ok: false, reason: "invalid_snapshot" };
  }
  const snapshot = value as unknown as RunSnapshot;
  const { game, audit } = snapshot;
  if (
    audit.seed !== game.seed ||
    audit.playerId !== game.player.id ||
    audit.nextTick !== game.tick + 1 ||
    audit.pending.length !== 0
  ) {
    return { ok: false, reason: "journal_game_mismatch" };
  }
  if (
    audit.genesisDigest !== digest.hashString(
      canonicalAuditGenesis(audit.seed, audit.playerId, audit.ownerPublicKey),
    ) ||
    audit.checkpoints.length === 0 ||
    audit.checkpoints.length !== audit.retainedSegments.length
  ) {
    return { ok: false, reason: "checkpoint_chain_mismatch" };
  }

  let expectedTick = 1;
  let previousCheckpoint = audit.genesisDigest;
  for (let epoch = 0; epoch < audit.checkpoints.length; epoch += 1) {
    const checkpoint = audit.checkpoints[epoch];
    const segment = audit.retainedSegments[epoch];
    if (
      !hasCheckpointShape(checkpoint) ||
      !hasSegmentShape(segment) ||
      checkpoint.epoch !== epoch ||
      segment.epoch !== epoch ||
      segment.checkpointDigest !== checkpoint.checkpointDigest ||
      checkpoint.previousCheckpoint !== previousCheckpoint ||
      checkpoint.eventCount !== audit.cadenceTicks ||
      segment.events.length !== checkpoint.eventCount ||
      checkpoint.firstTick !== expectedTick ||
      checkpoint.lastTick !== expectedTick + checkpoint.eventCount - 1
    ) {
      return { ok: false, reason: "checkpoint_chain_mismatch" };
    }
    for (const event of segment.events) {
      if (event.tick !== expectedTick) {
        return { ok: false, reason: "checkpoint_chain_mismatch" };
      }
      expectedTick += 1;
    }
    const eventRoot = digest.merkleRoot(
      segment.events.map((event) => event.canonicalPayload),
    );
    if (eventRoot !== checkpoint.eventRoot) {
      return { ok: false, reason: "event_root_mismatch" };
    }
    const createdAssetIds = segment.events
      .flatMap((event) => event.createdAssetIds)
      .sort();
    if (
      new Set(createdAssetIds).size !== createdAssetIds.length ||
      JSON.stringify(createdAssetIds) !== JSON.stringify(checkpoint.createdAssetIds)
    ) {
      return { ok: false, reason: "checkpoint_chain_mismatch" };
    }
    const canonicalEnvelope = canonicalMicroCheckpointEnvelope(checkpoint);
    if (
      canonicalEnvelope !== checkpoint.canonicalEnvelope ||
      digest.hashString(canonicalEnvelope) !== checkpoint.checkpointDigest
    ) {
      return { ok: false, reason: "checkpoint_chain_mismatch" };
    }
    previousCheckpoint = checkpoint.checkpointDigest;
  }

  const latest = audit.checkpoints.at(-1)!;
  if (latest.lastTick !== game.tick || expectedTick !== game.tick + 1) {
    return { ok: false, reason: "journal_game_mismatch" };
  }
  try {
    if (digest.hashString(canonicalGameState(game)) !== latest.stateDigest) {
      return { ok: false, reason: "state_digest_mismatch" };
    }
  } catch {
    return { ok: false, reason: "invalid_snapshot" };
  }
  if (
    audit.acknowledgedEpoch < -1 ||
    audit.acknowledgedEpoch >= audit.checkpoints.length ||
    audit.acknowledgedTick !== (audit.acknowledgedEpoch < 0
      ? 0
      : audit.checkpoints[audit.acknowledgedEpoch].lastTick)
  ) {
    return { ok: false, reason: "checkpoint_chain_mismatch" };
  }
  return { ok: true, snapshot };
}

export function createRunSnapshot(
  game: GameState,
  audit: GameAuditJournalState,
  savedAtMs: number,
  digest: AuditDigestAdapter,
): RunSnapshot {
  if (
    audit.pending.length !== 0 ||
    audit.checkpoints.length === 0 ||
    audit.checkpoints.at(-1)?.lastTick !== game.tick
  ) {
    throw new Error("snapshot requires a sealed checkpoint boundary");
  }
  const snapshot: RunSnapshot = {
    version: 1,
    savedAtMs,
    game,
    audit,
  };
  const restored = restoreRunSnapshot(snapshot, digest);
  if (!restored.ok) {
    throw new Error(`snapshot contract refused: ${restored.reason}`);
  }
  return snapshot;
}
