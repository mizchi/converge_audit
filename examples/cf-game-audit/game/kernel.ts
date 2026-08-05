import { DEFAULT_GAME_RULES, ITEM_TYPES } from "./content";
import type {
  AdvanceGameResult,
  ApplyItemVerificationResult,
  Axis,
  EnemyState,
  GameState,
  GroundDrop,
  InputFrame,
  InventoryItem,
  ItemRarity,
  ItemVerificationReceipt,
  ListingEligibility,
  StepEffect,
} from "./contracts";

export type {
  Axis,
  GameState,
  InputFrame,
  InventoryItem,
  ItemVerificationReceipt,
  ListingEligibility,
  StepEffect,
} from "./contracts";

export interface CreateGameInput {
  seed: number;
  playerId: string;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function isAxis(value: number): value is Axis {
  return value === -1 || value === 0 || value === 1;
}

function squaredDistance(
  left: { x: number; y: number },
  right: { x: number; y: number },
): number {
  const dx = left.x - right.x;
  const dy = left.y - right.y;
  return dx * dx + dy * dy;
}

function moveToward(enemy: EnemyState, target: { x: number; y: number }): EnemyState {
  const dx = Math.sign(target.x - enemy.x);
  const dy = Math.sign(target.y - enemy.y);
  return {
    ...enemy,
    x: enemy.x + dx * DEFAULT_GAME_RULES.enemyMove,
    y: enemy.y + dy * DEFAULT_GAME_RULES.enemyMove,
  };
}

function mix32(value: number): number {
  let mixed = value >>> 0;
  mixed ^= mixed >>> 16;
  mixed = Math.imul(mixed, 0x7feb352d);
  mixed ^= mixed >>> 15;
  mixed = Math.imul(mixed, 0x846ca68b);
  mixed ^= mixed >>> 16;
  return mixed >>> 0;
}

function stringHash(value: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

function rarityFor(roll: number): ItemRarity {
  const bucket = roll % 1_000;
  if (bucket < 20) return "legendary";
  if (bucket < 140) return "rare";
  if (bucket < 440) return "magic";
  return "common";
}

function deriveDrop(
  seed: number,
  playerId: string,
  enemy: EnemyState,
  killTick: number,
  dropIndex: number,
): GroundDrop {
  const roll = mix32(
    seed ^ stringHash(enemy.id) ^ Math.imul(killTick, 0x9e3779b1) ^ dropIndex,
  );
  const rollHex = roll.toString(16).padStart(8, "0");
  const assetId = [
    "loot-v1",
    (seed >>> 0).toString(16),
    enemy.id,
    killTick,
    dropIndex,
    rollHex,
  ].join(":");
  const item: InventoryItem = {
    assetId,
    ownerId: playerId,
    itemType: ITEM_TYPES[roll % ITEM_TYPES.length],
    rarity: rarityFor(roll),
    power: 1 + ((roll >>> 12) % 100),
    sourceEnemyId: enemy.id,
    killTick,
    dropIndex,
    audit: { status: "provisional" },
  };
  return {
    id: `drop:${assetId}`,
    x: enemy.x,
    y: enemy.y,
    item,
  };
}

export function createInitialGame(input: CreateGameInput): GameState {
  if (!Number.isSafeInteger(input.seed)) {
    throw new Error("game seed must be a safe integer");
  }
  if (input.playerId.length === 0) {
    throw new Error("player id must not be empty");
  }
  const player = {
    id: input.playerId,
    x: 640,
    y: 360,
    hp: 3,
    maxHp: 3,
  };
  return {
    seed: input.seed >>> 0,
    tick: 0,
    player,
    enemies: [{ id: "enemy-0", x: 760, y: 360, hp: 60, maxHp: 60 }],
    telegraphs: [{
      id: "telegraph-0",
      x: player.x,
      y: player.y,
      radius: 96,
      startTick: 0,
      resolveTick: 45,
      damage: 1,
    }],
    drops: [],
    inventory: [],
  };
}

function movePlayer(state: GameState, input: InputFrame) {
  const diagonal = input.horizontal !== 0 && input.vertical !== 0;
  const distance = diagonal
    ? DEFAULT_GAME_RULES.diagonalMove
    : DEFAULT_GAME_RULES.axisMove;
  return {
    ...state.player,
    x: clamp(
      state.player.x + input.horizontal * distance,
      DEFAULT_GAME_RULES.playerRadius,
      DEFAULT_GAME_RULES.worldWidth - DEFAULT_GAME_RULES.playerRadius,
    ),
    y: clamp(
      state.player.y + input.vertical * distance,
      DEFAULT_GAME_RULES.playerRadius,
      DEFAULT_GAME_RULES.worldHeight - DEFAULT_GAME_RULES.playerRadius,
    ),
  };
}

function attackNearest(
  enemies: EnemyState[],
  player: GameState["player"],
  tick: number,
  seed: number,
): { enemies: EnemyState[]; drops: GroundDrop[]; effects: StepEffect[] } {
  if (tick % DEFAULT_GAME_RULES.autoAttackInterval !== 0) {
    return { enemies, drops: [], effects: [] };
  }
  const rangeSquared = DEFAULT_GAME_RULES.autoAttackRange ** 2;
  const target = enemies
    .filter((enemy) => squaredDistance(enemy, player) <= rangeSquared)
    .sort((left, right) =>
      squaredDistance(left, player) - squaredDistance(right, player) ||
      left.id.localeCompare(right.id)
    )[0];
  if (!target) return { enemies, drops: [], effects: [] };
  const effects: StepEffect[] = [{
    kind: "auto_attack",
    enemyId: target.id,
    damage: DEFAULT_GAME_RULES.autoAttackDamage,
    tick,
  }];
  const damaged = { ...target, hp: target.hp - DEFAULT_GAME_RULES.autoAttackDamage };
  if (damaged.hp > 0) {
    return {
      enemies: enemies.map((enemy) => enemy.id === target.id ? damaged : enemy),
      drops: [],
      effects,
    };
  }
  const drop = deriveDrop(seed, player.id, target, tick, 0);
  effects.push(
    { kind: "enemy_killed", enemyId: target.id, tick },
    { kind: "item_dropped", drop, tick },
  );
  return {
    enemies: enemies.filter((enemy) => enemy.id !== target.id),
    drops: [drop],
    effects,
  };
}

export function advanceGame(state: GameState, input: InputFrame): AdvanceGameResult {
  if (input.tick !== state.tick + 1) {
    return { ok: false, reason: "tick_mismatch" };
  }
  if (!isAxis(input.horizontal) || !isAxis(input.vertical)) {
    return { ok: false, reason: "invalid_axis" };
  }
  const playerAfterMove = movePlayer(state, input);
  const enemiesAfterMove = state.enemies.map((enemy) =>
    moveToward(enemy, playerAfterMove)
  );
  const attack = attackNearest(
    enemiesAfterMove,
    playerAfterMove,
    input.tick,
    state.seed,
  );
  const effects = [...attack.effects];
  let player = playerAfterMove;
  const remainingTelegraphs = [];
  for (const telegraph of state.telegraphs) {
    if (telegraph.resolveTick !== input.tick) {
      remainingTelegraphs.push(telegraph);
      continue;
    }
    const hit = squaredDistance(telegraph, player) <= telegraph.radius ** 2;
    if (hit) player = { ...player, hp: Math.max(0, player.hp - telegraph.damage) };
    effects.push({
      kind: "telegraph_resolved",
      telegraphId: telegraph.id,
      outcome: hit ? "hit" : "dodged",
      resolveTick: input.tick,
    });
  }
  const allDrops = [...state.drops, ...attack.drops];
  const pickedUp = allDrops.filter((drop) =>
    squaredDistance(drop, player) <= DEFAULT_GAME_RULES.pickupRadius ** 2
  );
  for (const drop of pickedUp) {
    effects.push({ kind: "item_picked_up", assetId: drop.item.assetId, tick: input.tick });
  }
  const pickedIds = new Set(pickedUp.map((drop) => drop.id));
  return {
    ok: true,
    state: {
      ...state,
      tick: input.tick,
      player,
      enemies: attack.enemies,
      telegraphs: remainingTelegraphs,
      drops: allDrops.filter((drop) => !pickedIds.has(drop.id)),
      inventory: [...state.inventory, ...pickedUp.map((drop) => drop.item)],
    },
    effects,
  };
}

export function listingEligibility(item: InventoryItem): ListingEligibility {
  return item.audit.status === "verified"
    ? {
        allowed: true,
        authorityReceiptId: item.audit.authorityReceiptId,
        ownerPublicKey: item.audit.ownerPublicKey,
        ownerVersion: item.audit.ownerVersion,
        ownerHeadId: item.audit.ownerHeadId,
        checkpointDigest: item.audit.checkpointDigest,
        inventoryEpoch: item.audit.inventoryEpoch,
      }
    : { allowed: false, reason: "awaiting_checkpoint" };
}

export function applyItemVerification(
  state: GameState,
  receipt: ItemVerificationReceipt,
): ApplyItemVerificationResult {
  if (
    receipt.authorityReceiptId.length === 0 ||
    receipt.assetId.length === 0 ||
    receipt.ownerId.length === 0 ||
    !/^[0-9a-f]{64}$/.test(receipt.ownerPublicKey) ||
    !Number.isSafeInteger(receipt.ownerVersion) ||
    receipt.ownerVersion < 0 ||
    !/^[0-9a-f]{64}$/.test(receipt.ownerHeadId) ||
    receipt.checkpointDigest.length === 0 ||
    !Number.isSafeInteger(receipt.inventoryEpoch) ||
    receipt.inventoryEpoch < 0
  ) {
    return { ok: false, reason: "invalid_receipt" };
  }
  const index = state.inventory.findIndex((item) => item.assetId === receipt.assetId);
  if (index < 0) return { ok: false, reason: "unknown_asset" };
  const item = state.inventory[index];
  if (item.ownerId !== receipt.ownerId) {
    return { ok: false, reason: "owner_mismatch" };
  }
  if (item.audit.status === "verified") {
    if (
      item.audit.authorityReceiptId !== receipt.authorityReceiptId ||
      item.audit.ownerPublicKey !== receipt.ownerPublicKey ||
      item.audit.ownerVersion !== receipt.ownerVersion ||
      item.audit.ownerHeadId !== receipt.ownerHeadId ||
      item.audit.checkpointDigest !== receipt.checkpointDigest ||
      item.audit.inventoryEpoch !== receipt.inventoryEpoch
    ) {
      return { ok: false, reason: "verification_conflict" };
    }
    return { ok: true, state };
  }
  const inventory = [...state.inventory];
  inventory[index] = {
    ...item,
    audit: {
      status: "verified",
      authorityReceiptId: receipt.authorityReceiptId,
      ownerPublicKey: receipt.ownerPublicKey,
      ownerVersion: receipt.ownerVersion,
      ownerHeadId: receipt.ownerHeadId,
      checkpointDigest: receipt.checkpointDigest,
      inventoryEpoch: receipt.inventoryEpoch,
    },
  };
  return { ok: true, state: { ...state, inventory } };
}
