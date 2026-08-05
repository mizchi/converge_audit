import type {
  GameState,
  InputFrame,
  InventoryItem,
  StepEffect,
} from "../kernel";

export interface AuditDigestAdapter {
  hashString(value: string): string;
  merkleRoot(payloads: string[]): string;
}

export interface PendingAuditEvent {
  tick: number;
  canonicalPayload: string;
  createdAssetIds: string[];
}

export interface GameMicroCheckpoint {
  version: 1;
  epoch: number;
  firstTick: number;
  lastTick: number;
  eventCount: number;
  eventRoot: string;
  stateDigest: string;
  previousCheckpoint: string;
  checkpointDigest: string;
  canonicalEnvelope: string;
  createdAssetIds: string[];
}

export interface RetainedAuditSegment {
  epoch: number;
  checkpointDigest: string;
  events: PendingAuditEvent[];
}

export interface GameAuditJournalState {
  version: 1;
  seed: number;
  playerId: string;
  ownerPublicKey: string;
  cadenceTicks: number;
  genesisDigest: string;
  nextTick: number;
  pending: PendingAuditEvent[];
  checkpoints: GameMicroCheckpoint[];
  retainedSegments: RetainedAuditSegment[];
  acknowledgedEpoch: number;
  acknowledgedTick: number;
}

export interface AuditTick {
  input: InputFrame;
  effects: StepEffect[];
  state: GameState;
}

export type AppendAuditTickResult =
  | {
      ok: true;
      state: GameAuditJournalState;
      checkpoint?: GameMicroCheckpoint;
    }
  | {
      ok: false;
      reason:
        | "tick_mismatch"
        | "state_mismatch"
        | "invalid_axis"
        | "effect_tick_mismatch"
        | "duplicate_asset";
    };

export type AcknowledgeAuditCheckpointResult =
  | { ok: true; state: GameAuditJournalState }
  | { ok: false; reason: "unknown_checkpoint" | "ack_gap" };

function isAxis(value: number): boolean {
  return value === -1 || value === 0 || value === 1;
}

function canonicalItem(item: InventoryItem): unknown[] {
  return [
    item.assetId,
    item.ownerId,
    item.itemType,
    item.rarity,
    item.power,
    item.sourceEnemyId,
    item.killTick,
    item.dropIndex,
  ];
}

function canonicalEffect(effect: StepEffect): unknown[] {
  switch (effect.kind) {
    case "auto_attack":
      return [effect.kind, effect.tick, effect.enemyId, effect.damage];
    case "enemy_killed":
      return [effect.kind, effect.tick, effect.enemyId];
    case "item_dropped":
      return [
        effect.kind,
        effect.tick,
        effect.drop.id,
        effect.drop.x,
        effect.drop.y,
        canonicalItem(effect.drop.item),
      ];
    case "item_picked_up":
      return [effect.kind, effect.tick, effect.assetId];
    case "telegraph_resolved":
      return [
        effect.kind,
        effect.resolveTick,
        effect.telegraphId,
        effect.outcome,
      ];
  }
}

function effectTick(effect: StepEffect): number {
  return effect.kind === "telegraph_resolved" ? effect.resolveTick : effect.tick;
}

export function canonicalGameState(state: GameState): string {
  const enemies = state.enemies
    .map((enemy) => [enemy.id, enemy.x, enemy.y, enemy.hp, enemy.maxHp])
    .sort((left, right) => String(left[0]).localeCompare(String(right[0])));
  const telegraphs = state.telegraphs
    .map((telegraph) => [
      telegraph.id,
      telegraph.x,
      telegraph.y,
      telegraph.radius,
      telegraph.startTick,
      telegraph.resolveTick,
      telegraph.damage,
    ])
    .sort((left, right) => String(left[0]).localeCompare(String(right[0])));
  const drops = state.drops
    .map((drop) => [drop.id, drop.x, drop.y, canonicalItem(drop.item)])
    .sort((left, right) => String(left[0]).localeCompare(String(right[0])));
  const inventory = state.inventory
    .map(canonicalItem)
    .sort((left, right) => String(left[0]).localeCompare(String(right[0])));
  return JSON.stringify([
    "audit-survivors-state-v1",
    state.seed,
    state.tick,
    [
      state.player.id,
      state.player.x,
      state.player.y,
      state.player.hp,
      state.player.maxHp,
    ],
    enemies,
    telegraphs,
    drops,
    inventory,
  ]);
}

export function canonicalAuditGenesis(
  seed: number,
  playerId: string,
  ownerPublicKey: string,
): string {
  return JSON.stringify([
    "audit-survivors-genesis-v2",
    seed >>> 0,
    playerId,
    ownerPublicKey,
  ]);
}

export function canonicalMicroCheckpointEnvelope(
  checkpoint: Pick<
    GameMicroCheckpoint,
    | "epoch"
    | "firstTick"
    | "lastTick"
    | "eventCount"
    | "eventRoot"
    | "stateDigest"
    | "previousCheckpoint"
    | "createdAssetIds"
  >,
): string {
  return JSON.stringify([
    "audit-survivors-micro-checkpoint-v1",
    checkpoint.epoch,
    checkpoint.firstTick,
    checkpoint.lastTick,
    checkpoint.eventCount,
    checkpoint.eventRoot,
    checkpoint.stateDigest,
    checkpoint.previousCheckpoint,
    checkpoint.createdAssetIds,
  ]);
}

export function canonicalAuditEvent(
  tick: Pick<AuditTick, "input" | "effects">,
): string {
  const effects = tick.effects
    .map(canonicalEffect)
    .map((effect) => JSON.stringify(effect))
    .sort()
    .map((effect) => JSON.parse(effect));
  return JSON.stringify([
    "audit-survivors-event-v1",
    tick.input.tick,
    tick.input.horizontal,
    tick.input.vertical,
    effects,
  ]);
}

export type DecodeCanonicalAuditEventResult =
  | { ok: true; input: InputFrame }
  | { ok: false; reason: "invalid_event_encoding" };

export function decodeCanonicalAuditEvent(
  payload: string,
): DecodeCanonicalAuditEventResult {
  try {
    const value: unknown = JSON.parse(payload);
    if (
      !Array.isArray(value) ||
      value.length !== 5 ||
      value[0] !== "audit-survivors-event-v1" ||
      !Number.isSafeInteger(value[1]) ||
      !isAxis(value[2] as number) ||
      !isAxis(value[3] as number) ||
      !Array.isArray(value[4]) ||
      JSON.stringify(value) !== payload
    ) {
      return { ok: false, reason: "invalid_event_encoding" };
    }
    return {
      ok: true,
      input: {
        tick: value[1] as number,
        horizontal: value[2] as InputFrame["horizontal"],
        vertical: value[3] as InputFrame["vertical"],
      },
    };
  } catch {
    return { ok: false, reason: "invalid_event_encoding" };
  }
}

export function createGameAuditJournal(
  input: {
    seed: number;
    playerId: string;
    ownerPublicKey: string;
    cadenceTicks: number;
  },
  digest: AuditDigestAdapter,
): GameAuditJournalState {
  if (!Number.isSafeInteger(input.seed)) {
    throw new Error("audit seed must be a safe integer");
  }
  if (input.playerId.length === 0) {
    throw new Error("audit player id must not be empty");
  }
  if (!/^[0-9a-f]{64}$/.test(input.ownerPublicKey)) {
    throw new Error("audit owner public key must be 32-byte lower hex");
  }
  if (!Number.isSafeInteger(input.cadenceTicks) || input.cadenceTicks <= 0) {
    throw new Error("audit cadence must be a positive safe integer");
  }
  const seed = input.seed >>> 0;
  const genesisDigest = digest.hashString(
    canonicalAuditGenesis(seed, input.playerId, input.ownerPublicKey),
  );
  return {
    version: 1,
    seed,
    playerId: input.playerId,
    ownerPublicKey: input.ownerPublicKey,
    cadenceTicks: input.cadenceTicks,
    genesisDigest,
    nextTick: 1,
    pending: [],
    checkpoints: [],
    retainedSegments: [],
    acknowledgedEpoch: -1,
    acknowledgedTick: 0,
  };
}

export function appendAuditTick(
  journal: GameAuditJournalState,
  tick: AuditTick,
  digest: AuditDigestAdapter,
): AppendAuditTickResult {
  if (tick.input.tick !== journal.nextTick) {
    return { ok: false, reason: "tick_mismatch" };
  }
  if (!isAxis(tick.input.horizontal) || !isAxis(tick.input.vertical)) {
    return { ok: false, reason: "invalid_axis" };
  }
  if (
    tick.state.tick !== tick.input.tick ||
    tick.state.seed !== journal.seed ||
    tick.state.player.id !== journal.playerId
  ) {
    return { ok: false, reason: "state_mismatch" };
  }
  if (tick.effects.some((effect) => effectTick(effect) !== tick.input.tick)) {
    return { ok: false, reason: "effect_tick_mismatch" };
  }
  const createdAssetIds = tick.effects
    .filter((effect) => effect.kind === "item_dropped")
    .map((effect) => effect.drop.item.assetId)
    .sort();
  if (new Set(createdAssetIds).size !== createdAssetIds.length) {
    return { ok: false, reason: "duplicate_asset" };
  }
  const pending = [...journal.pending, {
    tick: tick.input.tick,
    canonicalPayload: canonicalAuditEvent(tick),
    createdAssetIds,
  }];
  const baseState: GameAuditJournalState = {
    ...journal,
    nextTick: journal.nextTick + 1,
    pending,
  };
  if (pending.length < journal.cadenceTicks) {
    return { ok: true, state: baseState };
  }

  const checkpointAssets = pending.flatMap((event) => event.createdAssetIds).sort();
  if (new Set(checkpointAssets).size !== checkpointAssets.length) {
    return { ok: false, reason: "duplicate_asset" };
  }
  const epoch = journal.checkpoints.length;
  const previousCheckpoint = epoch === 0
    ? journal.genesisDigest
    : journal.checkpoints[epoch - 1].checkpointDigest;
  const eventRoot = digest.merkleRoot(
    pending.map((event) => event.canonicalPayload),
  );
  const stateDigest = digest.hashString(canonicalGameState(tick.state));
  const envelopeFields = {
    epoch,
    firstTick: pending[0].tick,
    lastTick: tick.input.tick,
    eventCount: pending.length,
    eventRoot,
    stateDigest,
    previousCheckpoint,
    createdAssetIds: checkpointAssets,
  };
  const canonicalEnvelope = canonicalMicroCheckpointEnvelope(envelopeFields);
  const checkpoint: GameMicroCheckpoint = {
    version: 1,
    ...envelopeFields,
    checkpointDigest: digest.hashString(canonicalEnvelope),
    canonicalEnvelope,
    createdAssetIds: checkpointAssets,
  };
  return {
    ok: true,
    state: {
      ...baseState,
      pending: [],
      checkpoints: [...journal.checkpoints, checkpoint],
      retainedSegments: [...journal.retainedSegments, {
        epoch,
        checkpointDigest: checkpoint.checkpointDigest,
        events: pending,
      }],
    },
    checkpoint,
  };
}

export function acknowledgeAuditCheckpoint(
  journal: GameAuditJournalState,
  checkpointDigest: string,
): AcknowledgeAuditCheckpointResult {
  const epoch = journal.checkpoints.findIndex(
    (checkpoint) => checkpoint.checkpointDigest === checkpointDigest,
  );
  if (epoch < 0) return { ok: false, reason: "unknown_checkpoint" };
  if (epoch <= journal.acknowledgedEpoch) {
    return { ok: true, state: journal };
  }
  if (epoch !== journal.acknowledgedEpoch + 1) {
    return { ok: false, reason: "ack_gap" };
  }
  return {
    ok: true,
    state: {
      ...journal,
      acknowledgedEpoch: epoch,
      acknowledgedTick: journal.checkpoints[epoch].lastTick,
    },
  };
}
