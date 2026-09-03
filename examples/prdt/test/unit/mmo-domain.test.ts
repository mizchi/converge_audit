import { describe, expect, it } from "vitest";
import { applyGameEvent, validateGameCommand } from "../../src/examples/mmo/domain.ts";
import { worldWith } from "../../src/examples/mmo/model.ts";

const alive = worldWith({ a: { hp: 10, maxHp: 10, mp: 50 } });
const dead = worldWith({ a: { hp: 0, maxHp: 10, mp: 50 } });

describe("MMO domain validation", () => {
  it("accepts a skill from a living actor with enough MP", () => {
    expect(validateGameCommand(alive, { type: "UseSkill", actor: "a", skill: "fireball", mpCost: 30 })).toEqual({
      accepted: true,
      event: { type: "SkillActivated", actor: "a", skill: "fireball", mpCost: 30 },
    });
  });

  it("rejects a skill from a dead actor", () => {
    expect(validateGameCommand(dead, { type: "UseSkill", actor: "a", skill: "fireball", mpCost: 30 })).toEqual({
      accepted: false,
      reason: { type: "ActorDead" },
    });
  });

  it("rejects insufficient MP", () => {
    expect(validateGameCommand(alive, { type: "UseSkill", actor: "a", skill: "meteor", mpCost: 51 })).toEqual({
      accepted: false,
      reason: { type: "InsufficientMP" },
    });
  });

  it("rejects unknown actors and targets", () => {
    expect(validateGameCommand(alive, { type: "UseSkill", actor: "zzz", skill: "x", mpCost: 0 })).toEqual({
      accepted: false,
      reason: { type: "ActorNotFound" },
    });
    expect(validateGameCommand(alive, { type: "Damage", source: "a", target: "zzz", amount: 1 })).toEqual({
      accepted: false,
      reason: { type: "TargetNotFound" },
    });
  });

  it("rejects invalid amounts", () => {
    expect(validateGameCommand(alive, { type: "Damage", source: "a", target: "a", amount: 0 })).toEqual({
      accepted: false,
      reason: { type: "InvalidAmount" },
    });
    expect(validateGameCommand(alive, { type: "Damage", source: "a", target: "a", amount: 1.5 })).toEqual({
      accepted: false,
      reason: { type: "InvalidAmount" },
    });
    expect(validateGameCommand(alive, { type: "UseSkill", actor: "a", skill: "x", mpCost: -1 })).toEqual({
      accepted: false,
      reason: { type: "InvalidAmount" },
    });
  });
});

describe("MMO domain apply", () => {
  it("clamps HP at zero and does not mutate the input world", () => {
    const next = applyGameEvent(alive, { type: "DamageApplied", source: "m", target: "a", amount: 25 });
    expect(next.players.get("a")?.hp).toBe(0);
    expect(alive.players.get("a")?.hp).toBe(10);
  });

  it("deducts MP on skill activation", () => {
    const next = applyGameEvent(alive, { type: "SkillActivated", actor: "a", skill: "fireball", mpCost: 30 });
    expect(next.players.get("a")?.mp).toBe(20);
  });
});
