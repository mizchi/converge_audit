export type Axis = -1 | 0 | 1;

export interface InputFrame {
  tick: number;
  horizontal: Axis;
  vertical: Axis;
}

export interface PlayerState {
  id: string;
  x: number;
  y: number;
  hp: number;
  maxHp: number;
}

export interface EnemyState {
  id: string;
  x: number;
  y: number;
  hp: number;
  maxHp: number;
}

export interface TelegraphState {
  id: string;
  x: number;
  y: number;
  radius: number;
  startTick: number;
  resolveTick: number;
  damage: number;
}

export type ItemRarity = "common" | "magic" | "rare" | "legendary";

export type ItemAuditState =
  | { status: "provisional" }
  | {
      status: "verified";
      authorityReceiptId: string;
      ownerPublicKey: string;
      ownerVersion: number;
      ownerHeadId: string;
      checkpointDigest: string;
      inventoryEpoch: number;
    };

export interface InventoryItem {
  assetId: string;
  ownerId: string;
  itemType: string;
  rarity: ItemRarity;
  power: number;
  sourceEnemyId: string;
  killTick: number;
  dropIndex: number;
  audit: ItemAuditState;
}

export interface GroundDrop {
  id: string;
  x: number;
  y: number;
  item: InventoryItem;
}

export interface GameState {
  seed: number;
  tick: number;
  player: PlayerState;
  enemies: EnemyState[];
  telegraphs: TelegraphState[];
  drops: GroundDrop[];
  inventory: InventoryItem[];
}

export type StepEffect =
  | {
      kind: "auto_attack";
      enemyId: string;
      damage: number;
      tick: number;
    }
  | { kind: "enemy_killed"; enemyId: string; tick: number }
  | { kind: "item_dropped"; drop: GroundDrop; tick: number }
  | { kind: "item_picked_up"; assetId: string; tick: number }
  | {
      kind: "telegraph_resolved";
      telegraphId: string;
      outcome: "hit" | "dodged";
      resolveTick: number;
    };

export type AdvanceGameResult =
  | { ok: true; state: GameState; effects: StepEffect[] }
  | { ok: false; reason: "tick_mismatch" | "invalid_axis" };

export interface ItemVerificationReceipt {
  authorityReceiptId: string;
  assetId: string;
  ownerId: string;
  ownerPublicKey: string;
  ownerVersion: number;
  ownerHeadId: string;
  checkpointDigest: string;
  inventoryEpoch: number;
}

export type ApplyItemVerificationResult =
  | { ok: true; state: GameState }
  | {
      ok: false;
      reason:
        | "invalid_receipt"
        | "unknown_asset"
        | "owner_mismatch"
        | "verification_conflict";
    };

export type ListingEligibility =
  | { allowed: false; reason: "awaiting_checkpoint" }
  | {
      allowed: true;
      authorityReceiptId: string;
      ownerPublicKey: string;
      ownerVersion: number;
      ownerHeadId: string;
      checkpointDigest: string;
      inventoryEpoch: number;
    };
