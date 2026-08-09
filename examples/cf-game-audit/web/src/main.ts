import {
  acknowledgeAuditCheckpoint,
  appendAuditTick,
  createGameAuditJournal,
  type GameAuditJournalState,
  type GameMicroCheckpoint,
} from "../../game/audit/journal";
import {
  buildGameCheckpointVerificationRequest,
  authenticateGameItemVerificationRequest,
  buildGameItemVerificationRequest,
  type GameItemVerificationRequest,
} from "../../game/authority/item-verification";
import {
  signGameMarketListingCancelProof,
  signGameMarketListingProof,
} from "../../game/authority/owner-authentication";
import { IndexedDbRunSnapshotStore } from "./audit/indexeddb";
import { BrowserPlayerLocalCheckpointRuntime } from "./audit/player-local-checkpoint-runtime";
import {
  deviceKeyFromSeedHex,
  generateDeviceKey,
  type ReferenceGameDeviceKey,
} from "./audit/device-key";
import { moonBitAuditDigest } from "./audit/moonbit";
import {
  requestGameAssetLineageStatus,
  requestGameCheckpointVerification,
  requestGameItemVerification,
  requestGameMarketListingCancellation,
  requestGameMarketListing,
  type GameAssetLineageStatus,
  type RequestGameCheckpointVerificationResult,
  type RequestGameItemVerificationResult,
} from "./audit/authority-client";
import { createRunSnapshot, restoreRunSnapshot } from "../../game/audit/snapshot";
import { DEFAULT_GAME_RULES } from "../../game/content";
import type {
  AuditBoundary,
  CheckpointSealDraft,
  EpochClosureEvidence,
  PlayerLocalStoreConfiguration,
} from "../../../player-local-runtime/contracts";
import {
  advanceGame,
  applyItemVerification,
  createInitialGame,
  listingEligibility,
  type GameState,
  type InventoryItem,
  type StepEffect,
} from "../../game/kernel";

const TICK_MS = 1_000 / 30;
const MAX_CATCH_UP_TICKS = 5;
const movementKeys = new Set([
  "ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown",
  "KeyA", "KeyD", "KeyW", "KeyS",
]);
const pressed = new Set<string>();
const snapshotStore = new IndexedDbRunSnapshotStore();
let persistenceQueue = Promise.resolve();
let localCheckpointRuntime:
  | Promise<BrowserPlayerLocalCheckpointRuntime>
  | undefined;
const LOCAL_AUTHORITY_ID = "authority";
const LOCAL_OUTBOX_CAPACITY = 256;
/** PvE preset: retain one-second micro checkpoints for two minutes. */
const LOCAL_APPEAL_RETENTION_EPOCHS = 120;

if (new URL(location.href).searchParams.has("playerLocalBench")) {
  void import("./audit/player-local-benchmark").then((module) => {
    module.installPlayerLocalBenchmark();
  });
}

function element<T extends HTMLElement>(id: string): T {
  const value = document.getElementById(id);
  if (!value) throw new Error(`missing element: ${id}`);
  return value as T;
}

const canvas = element<HTMLCanvasElement>("arena");
const maybeContext = canvas.getContext("2d");
if (!maybeContext) throw new Error("2D canvas is unavailable");
const context: CanvasRenderingContext2D = maybeContext;
const hpElement = element<HTMLElement>("hp");
const tickElement = element<HTMLElement>("tick");
const enemyCountElement = element<HTMLElement>("enemy-count");
const inventoryCountElement = element<HTMLElement>("inventory-count");
const auditStatusElement = element<HTMLElement>("audit-status");
const microStageElement = element<HTMLLIElement>("micro-stage");
const authorityStageElement = element<HTMLLIElement>("authority-stage");
const marketStageElement = element<HTMLLIElement>("market-stage");
const microCountElement = element<HTMLElement>("micro-count");
const pendingCountElement = element<HTMLElement>("pending-count");
const rollbackTickElement = element<HTMLElement>("rollback-tick");
const checkpointRootElement = element<HTMLElement>("checkpoint-root");
const inventoryElement = element<HTMLElement>("inventory");
const eventLogElement = element<HTMLOListElement>("event-log");
const seedInput = element<HTMLInputElement>("seed");
const restartButton = element<HTMLButtonElement>("restart");

function seedFromLocation(): number {
  const query = new URL(location.href).searchParams.get("seed");
  const parsed = Number(query ?? seedInput.value);
  return Number.isSafeInteger(parsed) ? parsed : 0x1234;
}

function runIdFromLocation(): string {
  const url = new URL(location.href);
  const requested = url.searchParams.get("run");
  const runId = requested && /^[A-Za-z0-9_-]{1,64}$/.test(requested)
    ? requested
    : crypto.randomUUID();
  if (requested !== runId) {
    url.searchParams.set("run", runId);
    history.replaceState(null, "", url);
  }
  return runId;
}

let state = createInitialGame({ seed: seedFromLocation(), playerId: "local-player" });
let runId = runIdFromLocation();
function newAuditJournal(
  game: GameState,
  ownerPublicKey: string,
): GameAuditJournalState {
  return createGameAuditJournal({
    seed: game.seed,
    playerId: game.player.id,
    ownerPublicKey,
    cadenceTicks: 30,
  }, moonBitAuditDigest);
}

let deviceKey: ReferenceGameDeviceKey;
let auditJournal: GameAuditJournalState;
let previousState = state;
let accumulated = 0;
let lastFrame = performance.now();
const eventLines: string[] = [];
const pendingItemVerifications = new Set<string>();
const failedItemVerifications = new Map<string, string>();
const pendingMarketListings = new Set<string>();
const failedMarketListings = new Map<string, string>();
const listedItems = new Map<string, string>();
const listingNonces = new Map<string, string>();
const lineageStatuses = new Map<string, GameAssetLineageStatus>();
const pendingLineageStatusRequests = new Set<string>();
const pendingMarketCancellations = new Set<string>();
const failedMarketCancellations = new Map<string, string>();
let verificationGeneration = 0;
let authorityVerificationQueue = Promise.resolve();
seedInput.value = String(state.seed);

function runStorageKey(game: GameState): string {
  return `audit-survivors-v2:${game.player.id}:${game.seed}:${runId}`;
}

function reportPersistenceFailure(error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  eventLines.unshift(`local DB error: ${message}`);
  eventLines.splice(12);
}

function addEventLine(line: string): void {
  eventLines.unshift(line);
  eventLines.splice(12);
}

function playerLocalBoundary(
  storageKey: string,
  game: GameState,
  audit: GameAuditJournalState,
): AuditBoundary {
  return {
    protocol_version: 1,
    purpose: "reference-game-checkpoint-v1",
    manifest_digest: moonBitAuditDigest.hashString(JSON.stringify([
      "reference-game-local-manifest-v1",
      DEFAULT_GAME_RULES,
    ])),
    scope_id: game.player.id,
    unit_id: storageKey,
  };
}

function playerLocalCheckpoint(
  boundary: AuditBoundary,
  checkpoint: GameMicroCheckpoint,
): CheckpointSealDraft {
  return {
    boundary,
    epoch: checkpoint.epoch,
    previous_checkpoint: checkpoint.previousCheckpoint,
    checkpoint_digest: checkpoint.checkpointDigest,
    canonical_envelope: checkpoint.canonicalEnvelope,
  };
}

function playerLocalClosure(
  boundary: AuditBoundary,
  audit: GameAuditJournalState,
  checkpoint: GameMicroCheckpoint,
): EpochClosureEvidence {
  return {
    boundary,
    epoch: checkpoint.epoch,
    roster_digest: moonBitAuditDigest.hashString(JSON.stringify([
      "reference-game-local-roster-v1",
      audit.playerId,
      audit.ownerPublicKey,
    ])),
    frontier_digest: checkpoint.eventRoot,
    certificate_digest: moonBitAuditDigest.hashString(JSON.stringify([
      "reference-game-local-closure-v1",
      checkpoint.checkpointDigest,
      checkpoint.eventRoot,
      checkpoint.stateDigest,
    ])),
  };
}

async function openPlayerLocalRuntime(
  storageKey: string,
  game: GameState,
  audit: GameAuditJournalState,
): Promise<BrowserPlayerLocalCheckpointRuntime> {
  const boundary = playerLocalBoundary(storageKey, game, audit);
  const configuration: PlayerLocalStoreConfiguration = {
    boundary,
    genesis_digest: audit.genesisDigest,
    outbox_capacity: LOCAL_OUTBOX_CAPACITY,
  };
  const runtime = await BrowserPlayerLocalCheckpointRuntime.open({
    factory: indexedDB,
    databaseName: `converge-player-local-v1:${storageKey}`,
    configuration,
  });
  const retained = await runtime.image();
  for (const checkpoint of audit.checkpoints) {
    if (checkpoint.epoch <= retained.retention_anchor.epoch) continue;
    const sealed = await runtime.seal(
      playerLocalCheckpoint(boundary, checkpoint),
      playerLocalClosure(boundary, audit, checkpoint),
      [LOCAL_AUTHORITY_ID],
    );
    if (sealed.decision !== "committed" && sealed.decision !== "duplicate") {
      runtime.close();
      const reason = "reason" in sealed ? sealed.reason : sealed.decision;
      throw new Error(
        `player-local checkpoint migration refused: ${reason}`,
      );
    }
    if (checkpoint.epoch <= audit.acknowledgedEpoch) {
      await runtime.acknowledge({
        authorityId: LOCAL_AUTHORITY_ID,
        checkpointDigest: checkpoint.checkpointDigest,
        decision: "duplicate",
        authenticationSucceeded: true,
      });
    }
  }
  return runtime;
}

function replacePlayerLocalRuntime(
  storageKey: string,
  game: GameState,
  audit: GameAuditJournalState,
): void {
  const previous = localCheckpointRuntime;
  localCheckpointRuntime = (previous
    ? previous.then((runtime) => runtime.close(), () => undefined)
    : Promise.resolve())
    .then(() => openPlayerLocalRuntime(storageKey, game, audit));
}

async function acknowledgePlayerLocalCheckpoint(
  checkpointDigest: string,
): Promise<void> {
  await persistenceQueue;
  const runtime = await localCheckpointRuntime;
  if (!runtime) throw new Error("player-local checkpoint runtime is unavailable");
  const decision = await runtime.acknowledge({
    authorityId: LOCAL_AUTHORITY_ID,
    checkpointDigest,
    decision: "accepted",
    authenticationSucceeded: true,
  });
  if (decision === "not_found") {
    throw new Error("player-local checkpoint outbox is missing");
  }
  const acknowledged = auditJournal.checkpoints.find((checkpoint) =>
    checkpoint.checkpointDigest === checkpointDigest
  );
  if (acknowledged) {
    const retainFromEpoch = Math.max(
      0,
      acknowledged.epoch - LOCAL_APPEAL_RETENTION_EPOCHS + 1,
    );
    const pruned = await runtime.prune({
      retain_from_epoch: retainFromEpoch,
      protected_epochs: [],
    });
    if (pruned.decision === "refused") {
      throw new Error(`player-local prune refused: ${pruned.reason}`);
    }
  }
}

function persistSealedRun(checkpoint: GameMicroCheckpoint): void {
  const key = runStorageKey(state);
  const snapshot = createRunSnapshot(
    state,
    auditJournal,
    Date.now(),
    moonBitAuditDigest,
  );
  persistenceQueue = persistenceQueue
    .then(async () => {
      await snapshotStore.save(key, snapshot);
      const runtime = await localCheckpointRuntime;
      if (!runtime) {
        throw new Error("player-local checkpoint runtime is unavailable");
      }
      const boundary = playerLocalBoundary(key, snapshot.game, snapshot.audit);
      const sealed = await runtime.seal(
        playerLocalCheckpoint(boundary, checkpoint),
        playerLocalClosure(boundary, snapshot.audit, checkpoint),
        [LOCAL_AUTHORITY_ID],
      );
      if (sealed.decision !== "committed" && sealed.decision !== "duplicate") {
        const reason = "reason" in sealed ? sealed.reason : sealed.decision;
        throw new Error(`player-local checkpoint refused: ${reason}`);
      }
    })
    .catch(reportPersistenceFailure);
}

window.addEventListener("keydown", (event) => {
  if (!movementKeys.has(event.code)) return;
  event.preventDefault();
  pressed.add(event.code);
});
window.addEventListener("keyup", (event) => pressed.delete(event.code));
window.addEventListener("blur", () => pressed.clear());

restartButton.addEventListener("click", () => {
  const requestedSeed = Number(seedInput.value);
  const seed = Number.isSafeInteger(requestedSeed) ? requestedSeed : 0x1234;
  runId = crypto.randomUUID();
  const url = new URL(location.href);
  url.searchParams.set("seed", String(seed >>> 0));
  url.searchParams.set("run", runId);
  history.replaceState(null, "", url);
  state = createInitialGame({ seed, playerId: "local-player" });
  deviceKey = generateDeviceKey();
  auditJournal = newAuditJournal(state, deviceKey.publicKey);
  const key = runStorageKey(state);
  replacePlayerLocalRuntime(key, state, auditJournal);
  const seedHex = deviceKey.seedHex;
  persistenceQueue = persistenceQueue
    .then(() => snapshotStore.saveDeviceSeed(key, seedHex))
    .catch(reportPersistenceFailure);
  verificationGeneration += 1;
  authorityVerificationQueue = Promise.resolve();
  pendingItemVerifications.clear();
  failedItemVerifications.clear();
  pendingMarketListings.clear();
  failedMarketListings.clear();
  listedItems.clear();
  listingNonces.clear();
  lineageStatuses.clear();
  pendingLineageStatusRequests.clear();
  pendingMarketCancellations.clear();
  failedMarketCancellations.clear();
  previousState = state;
  accumulated = 0;
  eventLines.length = 0;
  updateInterface();
});

function inputAxis(negative: string[], positive: string[]): -1 | 0 | 1 {
  const backward = negative.some((key) => pressed.has(key));
  const forward = positive.some((key) => pressed.has(key));
  return backward === forward ? 0 : backward ? -1 : 1;
}

function describeEffect(effect: StepEffect): string | undefined {
  switch (effect.kind) {
    case "telegraph_resolved":
      return `t${effect.resolveTick} AoE ${effect.outcome}`;
    case "enemy_killed":
      return `t${effect.tick} ${effect.enemyId} defeated`;
    case "item_dropped":
      return `t${effect.tick} ${effect.drop.item.rarity} drop`;
    case "item_picked_up":
      return `t${effect.tick} loot picked up (provisional)`;
    case "auto_attack":
      return undefined;
  }
}

function recordEffects(effects: StepEffect[]): void {
  for (const effect of effects) {
    const line = describeEffect(effect);
    if (line) eventLines.unshift(line);
  }
  eventLines.splice(12);
}

function recordCheckpoint(checkpoint: GameMicroCheckpoint): void {
  addEventLine(
    `t${checkpoint.lastTick} micro e${checkpoint.epoch} ${checkpoint.checkpointDigest.slice(0, 10)}…`,
  );
}

function verificationUnit(game: GameState): string {
  return `reference:${game.player.id}:${game.seed}:${runId}`;
}

function authorityFailureReason(
  result:
    | RequestGameCheckpointVerificationResult
    | RequestGameItemVerificationResult,
): string {
  return result.ok
    ? "unexpected_success"
    : result.reason === "authority_refused"
    ? result.error
    : result.reason;
}

async function verifyItemWithBackfill(
  assetId: string,
  request: GameItemVerificationRequest,
  unit: string,
  generation: number,
): Promise<void> {
  for (
    let epoch = auditJournal.acknowledgedEpoch + 1;
    epoch < request.checkpoint.epoch;
    epoch += 1
  ) {
    if (generation !== verificationGeneration) return;
    let checkpointRequest;
    try {
      checkpointRequest = buildGameCheckpointVerificationRequest(
        auditJournal,
        epoch,
      );
    } catch (error) {
      throw new Error(error instanceof Error ? error.message : String(error));
    }
    const result = await requestGameCheckpointVerification(
      fetch,
      unit,
      checkpointRequest,
    );
    if (!result.ok) throw new Error(authorityFailureReason(result));
    const acknowledged = acknowledgeAuditCheckpoint(
      auditJournal,
      result.receipt.checkpointDigest,
    );
    if (!acknowledged.ok) {
      throw new Error(`checkpoint receipt refused locally: ${acknowledged.reason}`);
    }
    auditJournal = acknowledged.state;
    await acknowledgePlayerLocalCheckpoint(result.receipt.checkpointDigest);
    addEventLine(`authority checkpoint e${epoch} verified`);
    updateInterface();
  }

  if (generation !== verificationGeneration) return;
  const result = await requestGameItemVerification(fetch, unit, request);
  if (!result.ok) throw new Error(authorityFailureReason(result));
  const applied = applyItemVerification(state, result.receipt);
  if (!applied.ok) {
    throw new Error(`authority receipt refused locally: ${applied.reason}`);
  }
  const acknowledged = acknowledgeAuditCheckpoint(
    auditJournal,
    result.receipt.checkpointDigest,
  );
  if (!acknowledged.ok) {
    throw new Error(`checkpoint receipt refused locally: ${acknowledged.reason}`);
  }
  state = applied.state;
  auditJournal = acknowledged.state;
  await acknowledgePlayerLocalCheckpoint(result.receipt.checkpointDigest);
  failedItemVerifications.delete(assetId);
  lineageStatuses.set(assetId, {
    assetId,
    eligibility: "eligible",
    settlementStatus: "finalized",
    openRevocations: 0,
    lineageCases: [],
  });
  addEventLine(
    `authority verified ${assetId} (${result.receipt.authorityReceiptId.slice(0, 10)}…)`,
  );
}

function scheduleItemVerification(assetId: string): void {
  const item = state.inventory.find((value) => value.assetId === assetId);
  if (
    !item ||
    item.audit.status === "verified" ||
    pendingItemVerifications.has(assetId)
  ) {
    return;
  }
  let request;
  try {
    const unit = verificationUnit(state);
    request = authenticateGameItemVerificationRequest(
      unit,
      buildGameItemVerificationRequest(auditJournal, assetId),
      moonBitAuditDigest,
      deviceKey,
    );
  } catch {
    // A drop can be picked up before its 30-event segment is sealed. The next
    // checkpoint callback retries it without turning normal pending time into
    // an authority failure.
    return;
  }
  const generation = verificationGeneration;
  const unit = verificationUnit(state);
  pendingItemVerifications.add(assetId);
  failedItemVerifications.delete(assetId);

  // The pending state is painted once before network completion so the local-first
  // transition remains visible and testable without a fixed timer.
  requestAnimationFrame(() => {
    if (generation !== verificationGeneration) return;
    authorityVerificationQueue = authorityVerificationQueue
      .then(() => verifyItemWithBackfill(assetId, request, unit, generation))
      .catch((error: unknown) => {
        if (generation !== verificationGeneration) return;
        const reason = error instanceof Error ? error.message : String(error);
        failedItemVerifications.set(assetId, reason);
        addEventLine(`authority verification failed: ${reason}`);
      })
      .finally(() => {
        if (generation !== verificationGeneration) return;
        pendingItemVerifications.delete(assetId);
        updateInterface();
      });
  });
}

function scheduleMarketListing(item: InventoryItem): void {
  if (
    item.audit.status !== "verified" ||
    pendingMarketListings.has(item.assetId) ||
    listedItems.has(item.assetId)
  ) {
    return;
  }
  const generation = verificationGeneration;
  pendingMarketListings.add(item.assetId);
  failedMarketListings.delete(item.assetId);
  updateInterface();
  const unit = verificationUnit(state);
  const listingNonce = listingNonces.get(item.assetId) ??
    randomListingNonce();
  listingNonces.set(item.assetId, listingNonce);
  const ownerSignature = signGameMarketListingProof(
    unit,
    {
      assetId: item.assetId,
      sellerId: item.ownerId,
      authorityReceiptId: item.audit.authorityReceiptId,
      ownerPublicKey: deviceKey.publicKey,
      ownerVersion: item.audit.ownerVersion,
      ownerHeadId: item.audit.ownerHeadId,
      listingNonce,
    },
    moonBitAuditDigest,
    deviceKey,
  );
  void requestGameMarketListing(fetch, unit, {
    assetId: item.assetId,
    sellerId: item.ownerId,
    authorityReceiptId: item.audit.authorityReceiptId,
    ownerPublicKey: deviceKey.publicKey,
    ownerVersion: item.audit.ownerVersion,
    ownerHeadId: item.audit.ownerHeadId,
    listingNonce,
    ownerSignature,
  }).then((result) => {
    if (generation !== verificationGeneration) return;
    pendingMarketListings.delete(item.assetId);
    if (!result.ok) {
      const reason = result.reason === "authority_refused"
        ? result.error
        : result.reason === "listing_refused"
        ? result.decision
        : result.reason;
      failedMarketListings.set(item.assetId, reason);
      if (result.reason === "listing_refused" && result.lineageStatus) {
        lineageStatuses.set(item.assetId, result.lineageStatus);
      }
      if (result.reason === "listing_refused" &&
        result.decision === "listing_canceled") {
        listingNonces.delete(item.assetId);
      }
      addEventLine(`market listing failed: ${reason}`);
      updateInterface();
      return;
    }
    listedItems.set(item.assetId, result.listing.listingId);
    lineageStatuses.set(item.assetId, {
      assetId: item.assetId,
      eligibility: "eligible",
      settlementStatus: "finalized",
      openRevocations: 0,
      lineageCases: [],
    });
    failedMarketListings.delete(item.assetId);
    addEventLine(
      `market listed ${item.assetId} (${result.listing.listingId.slice(0, 10)}…)`,
    );
    updateInterface();
  });
}

function scheduleLineageStatusRefresh(item: InventoryItem): void {
  if (
    item.audit.status !== "verified" ||
    pendingLineageStatusRequests.has(item.assetId)
  ) return;
  const generation = verificationGeneration;
  pendingLineageStatusRequests.add(item.assetId);
  updateInterface();
  void requestGameAssetLineageStatus(
    fetch,
    verificationUnit(state),
    item.assetId,
  ).then((result) => {
    if (generation !== verificationGeneration) return;
    pendingLineageStatusRequests.delete(item.assetId);
    if (!result.ok) {
      const reason = result.reason === "authority_refused"
        ? result.error
        : result.reason;
      addEventLine(`lineage status failed: ${reason}`);
      updateInterface();
      return;
    }
    lineageStatuses.set(item.assetId, result.status);
    if (result.status.settlementStatus === "finalized") {
      failedMarketListings.delete(item.assetId);
    }
    addEventLine(
      `lineage status ${item.assetId}: ${result.status.settlementStatus}`,
    );
    updateInterface();
  });
}

function randomListingNonce(): string {
  return Array.from(
    crypto.getRandomValues(new Uint8Array(32)),
    (value) => value.toString(16).padStart(2, "0"),
  ).join("");
}

function scheduleMarketListingCancellation(item: InventoryItem): void {
  const listingId = listedItems.get(item.assetId);
  const listingNonce = listingNonces.get(item.assetId);
  if (
    item.audit.status !== "verified" ||
    !listingId ||
    !listingNonce ||
    pendingMarketCancellations.has(item.assetId)
  ) {
    return;
  }
  const generation = verificationGeneration;
  pendingMarketCancellations.add(item.assetId);
  failedMarketCancellations.delete(item.assetId);
  updateInterface();
  const unit = verificationUnit(state);
  const boundary = {
    listingId,
    assetId: item.assetId,
    sellerId: item.ownerId,
    authorityReceiptId: item.audit.authorityReceiptId,
    ownerPublicKey: deviceKey.publicKey,
    ownerVersion: item.audit.ownerVersion,
    ownerHeadId: item.audit.ownerHeadId,
    listingNonce,
  };
  const cancelSignature = signGameMarketListingCancelProof(
    unit,
    boundary,
    moonBitAuditDigest,
    deviceKey,
  );
  void requestGameMarketListingCancellation(fetch, unit, {
    ...boundary,
    cancelSignature,
  }).then((result) => {
    if (generation !== verificationGeneration) return;
    pendingMarketCancellations.delete(item.assetId);
    if (!result.ok) {
      const reason = result.reason === "authority_refused"
        ? result.error
        : result.reason === "cancellation_refused"
        ? result.decision
        : result.reason;
      failedMarketCancellations.set(item.assetId, reason);
      addEventLine(`market cancellation failed: ${reason}`);
      updateInterface();
      return;
    }
    listedItems.delete(item.assetId);
    listingNonces.delete(item.assetId);
    failedMarketCancellations.delete(item.assetId);
    addEventLine(
      `market canceled ${item.assetId} (${result.listing.listingId.slice(0, 10)}…)`,
    );
    updateInterface();
  });
}

function updateInterface(): void {
  hpElement.textContent = `${state.player.hp} / ${state.player.maxHp}`;
  tickElement.textContent = String(state.tick);
  enemyCountElement.textContent = String(state.enemies.length);
  inventoryCountElement.textContent = String(state.inventory.length);
  microCountElement.textContent = String(auditJournal.checkpoints.length);
  pendingCountElement.textContent =
    `${auditJournal.pending.length} / ${auditJournal.cadenceTicks}`;
  rollbackTickElement.textContent = String(auditJournal.acknowledgedTick);
  const latest = auditJournal.checkpoints.at(-1);
  checkpointRootElement.textContent = latest
    ? `${latest.checkpointDigest.slice(0, 18)}…`
    : "—";
  auditStatusElement.textContent = latest
    ? `local checkpoint e${latest.epoch} / ACK待ち`
    : `recording ${auditJournal.pending.length} / ${auditJournal.cadenceTicks}`;
  microStageElement.classList.toggle("active", latest !== undefined);
  authorityStageElement.classList.toggle(
    "active",
    pendingItemVerifications.size > 0 ||
      state.inventory.some((item) => item.audit.status === "verified"),
  );
  marketStageElement.classList.toggle("active", listedItems.size > 0);
  renderInventory(state.inventory);
  eventLogElement.replaceChildren(...eventLines.map((line) => {
    const item = document.createElement("li");
    item.textContent = line;
    return item;
  }));
}

function renderInventory(items: InventoryItem[]): void {
  if (items.length === 0) {
    inventoryElement.className = "inventory empty-state";
    inventoryElement.textContent = "戦利品はまだない";
    return;
  }
  inventoryElement.className = "inventory";
  inventoryElement.replaceChildren(...items.map((item) => {
    const card = document.createElement("article");
    card.className = "item-card";
    const name = document.createElement("div");
    name.className = `item-name rarity-${item.rarity}`;
    const itemType = document.createElement("span");
    itemType.textContent = item.itemType;
    const itemPower = document.createElement("span");
    itemPower.textContent = `+${item.power}`;
    name.append(itemType, itemPower);
    const meta = document.createElement("div");
    meta.className = "item-meta";
    const settlement = lineageStatuses.get(item.assetId)?.settlementStatus ??
      (item.audit.status === "verified" ? "finalized" : "provisional");
    card.classList.add(`settlement-${settlement}`);
    meta.textContent = settlement === "quarantined"
      ? `${item.rarity} · quarantined · appeal open`
      : settlement === "expired"
      ? `${item.rarity} · expired · listing blocked`
      : listedItems.has(item.assetId)
      ? `${item.rarity} · market listed`
      : settlement === "finalized"
      ? `${item.rarity} · finalized`
      : `${item.rarity} · provisional`;
    const listing = document.createElement("button");
    listing.type = "button";
    const eligibility = listingEligibility(item);
    const failed = failedItemVerifications.has(item.assetId);
    const marketFailed = failedMarketListings.has(item.assetId);
    const marketPending = pendingMarketListings.has(item.assetId);
    const listed = listedItems.has(item.assetId);
    const cancellationPending = pendingMarketCancellations.has(item.assetId);
    const cancellationFailed = failedMarketCancellations.has(item.assetId);
    const lineageStatusPending = pendingLineageStatusRequests.has(item.assetId);
    const lineageBlocked = settlement === "quarantined" ||
      settlement === "expired";
    listing.disabled = cancellationPending || marketPending ||
      lineageStatusPending ||
      (!listed && !eligibility.allowed && !failed);
    listing.textContent = cancellationPending
      ? "取消中"
      : lineageStatusPending
      ? "状態確認中"
      : lineageBlocked
      ? "監査状態を再確認"
      : listed
      ? cancellationFailed ? "取消再試行" : "出品を取り消す"
      : marketPending
      ? "出品中"
      : eligibility.allowed
      ? marketFailed ? "出品再試行" : "マーケットへ出品"
      : failed
      ? "検証再試行"
      : "監査待ち";
    if (lineageBlocked && !lineageStatusPending) {
      listing.addEventListener("click", () => {
        scheduleLineageStatusRefresh(item);
      });
    } else if (listed && !cancellationPending) {
      listing.addEventListener("click", () => {
        scheduleMarketListingCancellation(item);
      });
    } else if (eligibility.allowed && !marketPending) {
      listing.addEventListener("click", () => {
        scheduleMarketListing(item);
      });
    } else if (failed) {
      listing.addEventListener("click", () => {
        failedItemVerifications.delete(item.assetId);
        scheduleItemVerification(item.assetId);
        updateInterface();
      });
    }
    card.append(name, meta, listing);
    return card;
  }));
}

function interpolated(
  previous: { x: number; y: number },
  current: { x: number; y: number },
  alpha: number,
) {
  return {
    x: previous.x + (current.x - previous.x) * alpha,
    y: previous.y + (current.y - previous.y) * alpha,
  };
}

function render(previous: GameState, current: GameState, alpha: number): void {
  context.clearRect(0, 0, canvas.width, canvas.height);
  context.fillStyle = "#0a1513";
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.strokeStyle = "rgba(130, 180, 165, 0.08)";
  context.lineWidth = 1;
  for (let x = 0; x <= canvas.width; x += 64) {
    context.beginPath(); context.moveTo(x, 0); context.lineTo(x, canvas.height); context.stroke();
  }
  for (let y = 0; y <= canvas.height; y += 64) {
    context.beginPath(); context.moveTo(0, y); context.lineTo(canvas.width, y); context.stroke();
  }

  for (const telegraph of current.telegraphs) {
    const duration = telegraph.resolveTick - telegraph.startTick;
    const progress = Math.max(0, Math.min(1, (current.tick - telegraph.startTick) / duration));
    context.beginPath();
    context.arc(telegraph.x, telegraph.y, telegraph.radius, 0, Math.PI * 2);
    context.fillStyle = `rgba(255, 166, 64, ${0.12 + progress * 0.28})`;
    context.fill();
    context.strokeStyle = "#ffb454";
    context.lineWidth = 3 + progress * 5;
    context.stroke();
    context.fillStyle = "#ffe8cc";
    context.font = "16px ui-monospace, monospace";
    context.textAlign = "center";
    context.fillText(
      `${Math.max(0, (telegraph.resolveTick - current.tick) / 30).toFixed(1)}s`,
      telegraph.x,
      telegraph.y + 5,
    );
  }

  for (const drop of current.drops) {
    context.save();
    context.translate(drop.x, drop.y);
    context.rotate(Math.PI / 4);
    context.fillStyle = drop.item.rarity === "legendary" ? "#ff922b" : "#ffd43b";
    context.shadowColor = context.fillStyle;
    context.shadowBlur = 18;
    context.fillRect(-9, -9, 18, 18);
    context.restore();
  }

  for (const enemy of current.enemies) {
    const old = previous.enemies.find((value) => value.id === enemy.id) ?? enemy;
    const position = interpolated(old, enemy, alpha);
    context.beginPath();
    context.arc(position.x, position.y, DEFAULT_GAME_RULES.enemyRadius, 0, Math.PI * 2);
    context.fillStyle = "#e85959";
    context.fill();
    context.fillStyle = "#1c2422";
    context.fillRect(position.x - 18, position.y - 27, 36, 4);
    context.fillStyle = "#ff8787";
    context.fillRect(position.x - 18, position.y - 27, 36 * enemy.hp / enemy.maxHp, 4);
  }

  const playerPosition = interpolated(previous.player, current.player, alpha);
  context.beginPath();
  context.arc(
    playerPosition.x,
    playerPosition.y,
    DEFAULT_GAME_RULES.playerRadius,
    0,
    Math.PI * 2,
  );
  context.fillStyle = "#63e6be";
  context.shadowColor = "#63e6be";
  context.shadowBlur = 16;
  context.fill();
  context.shadowBlur = 0;
}

function frame(now: number): void {
  accumulated += Math.min(250, now - lastFrame);
  lastFrame = now;
  let steps = 0;
  while (accumulated >= TICK_MS && steps < MAX_CATCH_UP_TICKS) {
    previousState = state;
    const input = {
      tick: state.tick + 1,
      horizontal: inputAxis(["ArrowLeft", "KeyA"], ["ArrowRight", "KeyD"]),
      vertical: inputAxis(["ArrowUp", "KeyW"], ["ArrowDown", "KeyS"]),
    } as const;
    const result = advanceGame(state, input);
    if (!result.ok) throw new Error(result.reason);
    state = result.state;
    recordEffects(result.effects);
    const audited = appendAuditTick(auditJournal, {
      input,
      effects: result.effects,
      state,
    }, moonBitAuditDigest);
    if (!audited.ok) throw new Error(`audit journal refused tick: ${audited.reason}`);
    auditJournal = audited.state;
    if (audited.checkpoint) {
      recordCheckpoint(audited.checkpoint);
      persistSealedRun(audited.checkpoint);
      for (const item of state.inventory) {
        if (item.audit.status === "provisional") {
          scheduleItemVerification(item.assetId);
        }
      }
    }
    for (const effect of result.effects) {
      if (effect.kind === "item_picked_up") {
        scheduleItemVerification(effect.assetId);
      }
    }
    accumulated -= TICK_MS;
    steps += 1;
  }
  if (steps === MAX_CATCH_UP_TICKS) accumulated = Math.min(accumulated, TICK_MS);
  if (steps > 0) updateInterface();
  render(previousState, state, accumulated / TICK_MS);
  requestAnimationFrame(frame);
}

async function start(): Promise<void> {
  restartButton.disabled = true;
  const storageKey = runStorageKey(state);
  try {
    const storedSeed = await snapshotStore.loadDeviceSeed(storageKey);
    deviceKey = storedSeed === undefined
      ? generateDeviceKey()
      : deviceKeyFromSeedHex(storedSeed);
    if (storedSeed === undefined) {
      await snapshotStore.saveDeviceSeed(storageKey, deviceKey.seedHex);
    }
  } catch (error) {
    reportPersistenceFailure(error);
    deviceKey = generateDeviceKey();
  }
  auditJournal = newAuditJournal(state, deviceKey.publicKey);
  try {
    const stored = await snapshotStore.load(storageKey);
    if (stored !== undefined) {
      const restored = restoreRunSnapshot(stored, moonBitAuditDigest);
      if (
        restored.ok &&
        restored.snapshot.audit.ownerPublicKey === deviceKey.publicKey
      ) {
        state = restored.snapshot.game;
        previousState = state;
        auditJournal = restored.snapshot.audit;
        eventLines.unshift(`t${state.tick} local checkpoint restored`);
      } else if (restored.ok) {
        eventLines.unshift("local snapshot refused: owner_key_mismatch");
      } else {
        eventLines.unshift(`local snapshot refused: ${restored.reason}`);
      }
    }
  } catch (error) {
    reportPersistenceFailure(error);
  } finally {
    restartButton.disabled = false;
  }
  replacePlayerLocalRuntime(storageKey, state, auditJournal);
  try {
    await localCheckpointRuntime;
  } catch (error) {
    reportPersistenceFailure(error);
  }
  lastFrame = performance.now();
  updateInterface();
  for (const item of state.inventory) {
    if (item.audit.status === "provisional") {
      scheduleItemVerification(item.assetId);
    }
  }
  render(previousState, state, 1);
  requestAnimationFrame(frame);
}

void start();
