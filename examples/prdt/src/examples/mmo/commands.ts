import type { PlayerId } from "./model.ts";

export type GameCommand =
  | {
      readonly type: "Damage";
      readonly source: PlayerId;
      readonly target: PlayerId;
      readonly amount: number;
    }
  | {
      readonly type: "UseSkill";
      readonly actor: PlayerId;
      readonly skill: string;
      readonly mpCost: number;
    };

/**
 * Tick phase order. This is a game-semantic choice, not a physical order:
 * damage resolves before skills, so a lethal hit in the same tick makes a
 * concurrent skill `Rejected(ActorDead)`.
 */
export function phaseOf(command: GameCommand): number {
  switch (command.type) {
    case "Damage":
      return 0;
    case "UseSkill":
      return 1;
  }
}
