export type { GameCommand } from "./commands.ts";
export { phaseOf } from "./commands.ts";
export { applyGameEvent, createGameDomain, validateGameCommand, type GameDomain } from "./domain.ts";
export type { GameEvent, GameRejection } from "./events.ts";
export { isAlive, playerOf, worldCodec, worldWith, type Player, type PlayerId, type World } from "./model.ts";
export { gameCommandOrder } from "./order.ts";
export {
  FIREBALL,
  LETHAL_HIT,
  LETHAL_RACE_WORLD,
  PLAYER_A,
  gameConfig,
  gameProtocol,
  type GameConfig,
  type GameProtocol,
  type GameState,
} from "./scenario.ts";
