export interface GameRules {
  worldWidth: number;
  worldHeight: number;
  playerRadius: number;
  enemyRadius: number;
  pickupRadius: number;
  axisMove: number;
  diagonalMove: number;
  enemyMove: number;
  autoAttackInterval: number;
  autoAttackRange: number;
  autoAttackDamage: number;
}

export const DEFAULT_GAME_RULES: GameRules = Object.freeze({
  worldWidth: 1_280,
  worldHeight: 720,
  playerRadius: 14,
  enemyRadius: 16,
  pickupRadius: 24,
  axisMove: 6,
  diagonalMove: 4,
  enemyMove: 2,
  autoAttackInterval: 15,
  autoAttackRange: 190,
  autoAttackDamage: 30,
});

export const ITEM_TYPES = Object.freeze([
  "ember-blade",
  "storm-ring",
  "bone-charm",
  "void-boots",
]);
