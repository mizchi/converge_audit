/**
 * MMO sample domain: a pure reducer. `alive` is evaluated here, against the
 * state immediately before the command in the finalized order, and never as
 * a proposal-time precondition.
 */
import { accept, reject, type Domain, type Validation } from "../../domain/domain.ts";
import type { GameCommand } from "./commands.ts";
import type { GameEvent, GameRejection } from "./events.ts";
import type { World } from "./model.ts";

export type GameDomain = Domain<World, GameCommand, GameEvent, GameRejection>;

export function validateGameCommand(world: World, command: GameCommand): Validation<GameEvent, GameRejection> {
  switch (command.type) {
    case "Damage": {
      if (!Number.isInteger(command.amount) || command.amount <= 0) return reject({ type: "InvalidAmount" });
      if (!world.players.has(command.target)) return reject({ type: "TargetNotFound" });
      return accept({ type: "DamageApplied", source: command.source, target: command.target, amount: command.amount });
    }
    case "UseSkill": {
      if (!Number.isInteger(command.mpCost) || command.mpCost < 0) return reject({ type: "InvalidAmount" });
      const actor = world.players.get(command.actor);
      if (actor === undefined) return reject({ type: "ActorNotFound" });
      if (actor.hp <= 0) return reject({ type: "ActorDead" });
      if (actor.mp < command.mpCost) return reject({ type: "InsufficientMP" });
      return accept({ type: "SkillActivated", actor: command.actor, skill: command.skill, mpCost: command.mpCost });
    }
  }
}

export function applyGameEvent(world: World, event: GameEvent): World {
  switch (event.type) {
    case "DamageApplied": {
      const target = world.players.get(event.target);
      if (target === undefined) return world;
      const players = new Map(world.players);
      players.set(event.target, { ...target, hp: Math.max(0, target.hp - event.amount) });
      return { players };
    }
    case "SkillActivated": {
      const actor = world.players.get(event.actor);
      if (actor === undefined) return world;
      const players = new Map(world.players);
      players.set(event.actor, { ...actor, mp: actor.mp - event.mpCost });
      return { players };
    }
  }
}

export function createGameDomain(initialWorld: World): GameDomain {
  return {
    initialState: () => initialWorld,
    validate: validateGameCommand,
    apply: applyGameEvent,
  };
}
