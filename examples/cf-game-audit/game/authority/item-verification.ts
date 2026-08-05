import {
  canonicalAuditEvent,
  canonicalAuditGenesis,
  canonicalGameState,
  canonicalMicroCheckpointEnvelope,
  decodeCanonicalAuditEvent,
  type AuditDigestAdapter,
  type GameAuditJournalState,
} from "../audit/journal";
import {
  advanceGame,
  createInitialGame,
  type GameState,
  type InventoryItem,
} from "../kernel";
import {
  createInitialGameAssetOwnershipHead,
} from "./asset-ownership";
import {
  signGameItemOwnerProof,
  verifyGameItemOwnerProof,
  type GameOwnerSignatureVerifier,
  type GameOwnerSigner,
} from "./owner-authentication";

const CHECKPOINT_EVENT_COUNT = 30;
const MAX_EVENT_PAYLOAD_LENGTH = 32_768;

export interface GameItemVerificationWireCheckpoint {
  version: 1;
  epoch: number;
  first_tick: number;
  last_tick: number;
  event_count: number;
  event_root: string;
  state_digest: string;
  previous_checkpoint: string;
  checkpoint_digest: string;
  canonical_envelope: string;
  created_asset_ids: string[];
}

export interface GameItemVerificationWireEvent {
  tick: number;
  canonical_payload: string;
  created_asset_ids: string[];
}

export interface GameCheckpointVerificationRequest {
  version: 1;
  seed: number;
  player_id: string;
  owner_public_key: string;
  checkpoint: GameItemVerificationWireCheckpoint;
  events: GameItemVerificationWireEvent[];
}

export interface UnsignedGameItemVerificationRequest
  extends GameCheckpointVerificationRequest {
  asset_id: string;
}

export interface GameItemVerificationRequest
  extends UnsignedGameItemVerificationRequest {
  owner_signature: string;
}

export interface GameCheckpointVerificationParent {
  checkpointDigest: string;
  stateDigest: string;
  ownerPublicKey: string;
  state: GameState;
}

export interface GameItemAuthorityReceipt {
  version: 1;
  authorityReceiptId: string;
  assetId: string;
  ownerId: string;
  ownerPublicKey: string;
  ownerVersion: number;
  ownerHeadId: string;
  checkpointDigest: string;
  inventoryEpoch: number;
}

export type VerifyGameItemCreationResult =
  | {
      ok: true;
      receipt: GameItemAuthorityReceipt;
      item: InventoryItem;
      state: GameState;
      checkpoint: GameItemVerificationWireCheckpoint;
    }
  | {
      ok: false;
      reason:
        | "invalid_request"
        | "unsupported_checkpoint"
        | "unverified_parent"
        | "invalid_parent_state"
        | "invalid_event"
        | "event_replay_mismatch"
        | "checkpoint_mismatch"
        | "asset_not_created"
        | "owner_authentication_refused";
    };

export type VerifyGameCheckpointResult =
  | {
      ok: true;
      state: GameState;
      checkpoint: GameItemVerificationWireCheckpoint;
      createdItems: InventoryItem[];
    }
  | {
      ok: false;
      reason:
        | "invalid_request"
        | "unsupported_checkpoint"
        | "unverified_parent"
        | "invalid_parent_state"
        | "invalid_event"
        | "event_replay_mismatch"
        | "checkpoint_mismatch";
    };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSafeNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isBoundedString(value: unknown, maximum: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maximum;
}

function isStringArray(value: unknown, maximumItems: number): value is string[] {
  return Array.isArray(value) &&
    value.length <= maximumItems &&
    value.every((item) => isBoundedString(item, 1_024));
}

function isWireCheckpoint(
  value: unknown,
): value is GameItemVerificationWireCheckpoint {
  if (!isRecord(value)) return false;
  return value.version === 1 &&
    isSafeNonNegativeInteger(value.epoch) &&
    isSafeNonNegativeInteger(value.first_tick) &&
    isSafeNonNegativeInteger(value.last_tick) &&
    isSafeNonNegativeInteger(value.event_count) &&
    isBoundedString(value.event_root, 128) &&
    isBoundedString(value.state_digest, 128) &&
    isBoundedString(value.previous_checkpoint, 128) &&
    isBoundedString(value.checkpoint_digest, 128) &&
    isBoundedString(value.canonical_envelope, 8_192) &&
    isStringArray(value.created_asset_ids, 64);
}

function isWireEvent(value: unknown): value is GameItemVerificationWireEvent {
  if (!isRecord(value)) return false;
  return isSafeNonNegativeInteger(value.tick) &&
    isBoundedString(value.canonical_payload, MAX_EVENT_PAYLOAD_LENGTH) &&
    isStringArray(value.created_asset_ids, 64);
}

export function decodeGameCheckpointVerificationRequest(
  value: unknown,
): GameCheckpointVerificationRequest | undefined {
  if (!isRecord(value) || !Array.isArray(value.events)) return undefined;
  if (
    value.version !== 1 ||
    !isSafeNonNegativeInteger(value.seed) ||
    !isBoundedString(value.player_id, 256) ||
    !isBoundedString(value.owner_public_key, 64) ||
    !/^[0-9a-f]{64}$/.test(value.owner_public_key) ||
    !isWireCheckpoint(value.checkpoint) ||
    value.events.length !== CHECKPOINT_EVENT_COUNT ||
    !value.events.every(isWireEvent)
  ) {
    return undefined;
  }
  return value as unknown as GameCheckpointVerificationRequest;
}

function decodeItemRequest(value: unknown): GameItemVerificationRequest | undefined {
  const checkpointRequest = decodeGameCheckpointVerificationRequest(value);
  if (
    !checkpointRequest ||
    !isRecord(value) ||
    !isBoundedString(value.asset_id, 1_024) ||
    !isBoundedString(value.owner_signature, 128) ||
    !/^[0-9a-f]{128}$/.test(value.owner_signature)
  ) {
    return undefined;
  }
  return value as unknown as GameItemVerificationRequest;
}

function checkpointRequestAt(
  journal: GameAuditJournalState,
  epoch: number,
): GameCheckpointVerificationRequest {
  if (!Number.isSafeInteger(epoch) || epoch < 0) {
    throw new Error("checkpoint epoch must be a non-negative safe integer");
  }
  const checkpoint = journal.checkpoints[epoch];
  if (!checkpoint) throw new Error("checkpoint is unavailable");
  const segment = journal.retainedSegments.find((value) =>
    value.checkpointDigest === checkpoint.checkpointDigest
  );
  if (!segment) throw new Error("checkpoint transcript is unavailable");
  return {
    version: 1,
    seed: journal.seed,
    player_id: journal.playerId,
    owner_public_key: journal.ownerPublicKey,
    checkpoint: {
      version: 1,
      epoch: checkpoint.epoch,
      first_tick: checkpoint.firstTick,
      last_tick: checkpoint.lastTick,
      event_count: checkpoint.eventCount,
      event_root: checkpoint.eventRoot,
      state_digest: checkpoint.stateDigest,
      previous_checkpoint: checkpoint.previousCheckpoint,
      checkpoint_digest: checkpoint.checkpointDigest,
      canonical_envelope: checkpoint.canonicalEnvelope,
      created_asset_ids: [...checkpoint.createdAssetIds],
    },
    events: segment.events.map((event) => ({
      tick: event.tick,
      canonical_payload: event.canonicalPayload,
      created_asset_ids: [...event.createdAssetIds],
    })),
  };
}

export function buildGameCheckpointVerificationRequest(
  journal: GameAuditJournalState,
  epoch: number,
): GameCheckpointVerificationRequest {
  return checkpointRequestAt(journal, epoch);
}

export function buildGameItemVerificationRequest(
  journal: GameAuditJournalState,
  assetId: string,
): UnsignedGameItemVerificationRequest {
  const checkpoint = journal.checkpoints.find((value) =>
    value.createdAssetIds.includes(assetId)
  );
  if (!checkpoint) throw new Error("asset is not bound to a sealed checkpoint");
  const request = checkpointRequestAt(journal, checkpoint.epoch);
  return {
    ...request,
    asset_id: assetId,
  };
}

export function authenticateGameItemVerificationRequest(
  unit: string,
  request: UnsignedGameItemVerificationRequest,
  digest: AuditDigestAdapter,
  signer: GameOwnerSigner,
): GameItemVerificationRequest {
  const owner_signature = signGameItemOwnerProof(
    unit,
    {
      playerId: request.player_id,
      seed: request.seed,
      checkpointDigest: request.checkpoint.checkpoint_digest,
      assetId: request.asset_id,
      ownerPublicKey: request.owner_public_key,
    },
    digest,
    signer,
  );
  return { ...request, owner_signature };
}

export function verifyGameCheckpoint(
  input: unknown,
  digest: AuditDigestAdapter,
  parent?: GameCheckpointVerificationParent,
): VerifyGameCheckpointResult {
  const request = decodeGameCheckpointVerificationRequest(input);
  if (!request) return { ok: false, reason: "invalid_request" };
  const checkpoint = request.checkpoint;
  const firstTick = checkpoint.epoch * CHECKPOINT_EVENT_COUNT + 1;
  const lastTick = firstTick + CHECKPOINT_EVENT_COUNT - 1;
  if (
    !Number.isSafeInteger(firstTick) ||
    checkpoint.first_tick !== firstTick ||
    checkpoint.last_tick !== lastTick ||
    checkpoint.event_count !== CHECKPOINT_EVENT_COUNT
  ) {
    return { ok: false, reason: "unsupported_checkpoint" };
  }

  let state: GameState;
  let previousCheckpoint: string;
  if (checkpoint.epoch === 0) {
    state = createInitialGame({
      seed: request.seed,
      playerId: request.player_id,
    });
    previousCheckpoint = digest.hashString(
      canonicalAuditGenesis(
        request.seed,
        request.player_id,
        request.owner_public_key,
      ),
    );
  } else {
    if (!parent) return { ok: false, reason: "unverified_parent" };
    try {
      if (
        parent.checkpointDigest.length === 0 ||
        parent.stateDigest.length === 0 ||
        parent.ownerPublicKey !== request.owner_public_key ||
        parent.state.seed !== request.seed ||
        parent.state.player.id !== request.player_id ||
        parent.state.tick !== firstTick - 1 ||
        digest.hashString(canonicalGameState(parent.state)) !== parent.stateDigest
      ) {
        return { ok: false, reason: "invalid_parent_state" };
      }
    } catch {
      return { ok: false, reason: "invalid_parent_state" };
    }
    state = parent.state;
    previousCheckpoint = parent.checkpointDigest;
  }

  const createdItems: InventoryItem[] = [];
  const createdAssetIds: string[] = [];
  for (let index = 0; index < request.events.length; index += 1) {
    const event = request.events[index];
    const expectedTick = firstTick + index;
    const decoded = decodeCanonicalAuditEvent(event.canonical_payload);
    if (
      !decoded.ok ||
      event.tick !== expectedTick ||
      decoded.input.tick !== event.tick
    ) {
      return { ok: false, reason: "invalid_event" };
    }
    const advanced = advanceGame(state, decoded.input);
    if (!advanced.ok) return { ok: false, reason: "invalid_event" };
    const replayedPayload = canonicalAuditEvent({
      input: decoded.input,
      effects: advanced.effects,
    });
    if (replayedPayload !== event.canonical_payload) {
      return { ok: false, reason: "event_replay_mismatch" };
    }
    const eventItems = advanced.effects
      .filter((effect) => effect.kind === "item_dropped")
      .map((effect) => effect.drop.item);
    const eventAssetIds = eventItems.map((item) => item.assetId).sort();
    if (JSON.stringify(eventAssetIds) !== JSON.stringify(event.created_asset_ids)) {
      return { ok: false, reason: "event_replay_mismatch" };
    }
    createdItems.push(...eventItems);
    createdAssetIds.push(...eventAssetIds);
    state = advanced.state;
  }

  createdAssetIds.sort();
  const eventRoot = digest.merkleRoot(
    request.events.map((event) => event.canonical_payload),
  );
  const stateDigest = digest.hashString(canonicalGameState(state));
  const canonicalEnvelope = canonicalMicroCheckpointEnvelope({
    epoch: checkpoint.epoch,
    firstTick: checkpoint.first_tick,
    lastTick: checkpoint.last_tick,
    eventCount: checkpoint.event_count,
    eventRoot,
    stateDigest,
    previousCheckpoint,
    createdAssetIds,
  });
  if (
    eventRoot !== checkpoint.event_root ||
    stateDigest !== checkpoint.state_digest ||
    previousCheckpoint !== checkpoint.previous_checkpoint ||
    JSON.stringify(createdAssetIds) !== JSON.stringify(checkpoint.created_asset_ids) ||
    canonicalEnvelope !== checkpoint.canonical_envelope ||
    digest.hashString(canonicalEnvelope) !== checkpoint.checkpoint_digest
  ) {
    return { ok: false, reason: "checkpoint_mismatch" };
  }
  return { ok: true, state, checkpoint, createdItems };
}

export function verifyGameItemCreation(
  unit: string,
  input: unknown,
  digest: AuditDigestAdapter,
  signatureVerifier: GameOwnerSignatureVerifier,
  parent?: GameCheckpointVerificationParent,
): VerifyGameItemCreationResult {
  const request = decodeItemRequest(input);
  if (!request || !isBoundedString(unit, 128)) {
    return { ok: false, reason: "invalid_request" };
  }
  if (!verifyGameItemOwnerProof(
    unit,
    {
      playerId: request.player_id,
      seed: request.seed,
      checkpointDigest: request.checkpoint.checkpoint_digest,
      assetId: request.asset_id,
      ownerPublicKey: request.owner_public_key,
    },
    request.owner_signature,
    digest,
    signatureVerifier,
  )) {
    return { ok: false, reason: "owner_authentication_refused" };
  }
  const verified = verifyGameCheckpoint(request, digest, parent);
  if (!verified.ok) return verified;
  const checkpoint = verified.checkpoint;
  const item = verified.createdItems.find((value) =>
    value.assetId === request.asset_id
  );
  if (!item) return { ok: false, reason: "asset_not_created" };
  const authorityReceiptId = digest.hashString(JSON.stringify([
    "audit-survivors-authority-item-receipt-v1",
    unit,
    checkpoint.checkpoint_digest,
    item.assetId,
    item.ownerId,
    request.owner_public_key,
    checkpoint.epoch,
  ]));
  const ownerHead = createInitialGameAssetOwnershipHead(
    unit,
    {
      assetId: item.assetId,
      authorityReceiptId,
      ownerId: item.ownerId,
      ownerPublicKey: request.owner_public_key,
    },
    digest,
  );
  return {
    ok: true,
    item,
    state: verified.state,
    checkpoint,
    receipt: {
      version: 1,
      authorityReceiptId,
      assetId: item.assetId,
      ownerId: item.ownerId,
      ownerPublicKey: request.owner_public_key,
      ownerVersion: ownerHead.version,
      ownerHeadId: ownerHead.headId,
      checkpointDigest: checkpoint.checkpoint_digest,
      inventoryEpoch: checkpoint.epoch,
    },
  };
}
