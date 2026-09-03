import type { PlayerId } from "./model.ts";

export type GameEvent =
  | {
      readonly type: "DamageApplied";
      readonly source: PlayerId;
      readonly target: PlayerId;
      readonly amount: number;
    }
  | {
      readonly type: "SkillActivated";
      readonly actor: PlayerId;
      readonly skill: string;
      readonly mpCost: number;
    };

export type GameRejection =
  | { readonly type: "ActorNotFound" }
  | { readonly type: "ActorDead" }
  | { readonly type: "InsufficientMP" }
  | { readonly type: "TargetNotFound" }
  | { readonly type: "InvalidAmount" };
