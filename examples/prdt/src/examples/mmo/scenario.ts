/**
 * Wiring for the MMO sample and the reference "lethal damage races a skill"
 * scenario from the design notes.
 */
import { jsonCodec } from "../../core/codec.ts";
import { sha256Hasher, type Hasher } from "../../core/hash.ts";
import type { Finalizer } from "../../finalizer/finalizer.ts";
import {
  createProtocol,
  type ReplicatedDomainConfig,
  type ReplicatedDomainProtocol,
  type ReplicatedDomainState,
} from "../../prdt/replicated-domain.ts";
import type { GameCommand } from "./commands.ts";
import { createGameDomain } from "./domain.ts";
import type { GameEvent, GameRejection } from "./events.ts";
import { worldCodec, worldWith, type World } from "./model.ts";
import { gameCommandOrder } from "./order.ts";

export type GameProtocol = ReplicatedDomainProtocol<World, GameCommand, GameEvent, GameRejection>;
export type GameConfig = ReplicatedDomainConfig<World, GameCommand, GameEvent, GameRejection>;
export type GameState = ReplicatedDomainState<World, GameCommand, GameEvent, GameRejection>;

export const PLAYER_A = "player-a";

/** Player A: HP=10, MP=100 */
export const LETHAL_RACE_WORLD: World = worldWith({ [PLAYER_A]: { hp: 10, maxHp: 10, mp: 100 } });

export function gameConfig(options: {
  readonly finalizer: Finalizer<GameCommand>;
  readonly initialWorld?: World;
  readonly hasher?: Hasher;
  readonly genesisTick?: number;
}): GameConfig {
  const config: GameConfig = {
    domain: createGameDomain(options.initialWorld ?? LETHAL_RACE_WORLD),
    order: gameCommandOrder,
    finalizer: options.finalizer,
    hasher: options.hasher ?? sha256Hasher,
    codec: {
      state: worldCodec,
      command: jsonCodec<GameCommand>(),
      event: jsonCodec<GameEvent>(),
      reason: jsonCodec<GameRejection>(),
    },
  };
  return options.genesisTick === undefined ? config : { ...config, genesisTick: options.genesisTick };
}

export function gameProtocol(options: Parameters<typeof gameConfig>[0]): GameProtocol {
  return createProtocol(gameConfig(options));
}

export const FIREBALL: GameCommand = { type: "UseSkill", actor: PLAYER_A, skill: "fireball", mpCost: 30 };
export const LETHAL_HIT: GameCommand = { type: "Damage", source: "monster", target: PLAYER_A, amount: 20 };
