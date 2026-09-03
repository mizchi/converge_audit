import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { applyGameEvent } from "../../src/examples/mmo/domain.ts";
import type { World } from "../../src/examples/mmo/model.ts";
import { arbitraryScenario } from "./arbitraries.ts";

const RUNS = { numRuns: 100 };

/**
 * PRDT agreement alone would be satisfied by every replica consistently
 * accepting a dead player's skill. These properties check the domain rules
 * against the state immediately before each accepted command.
 */
describe("domain validity of committed results", () => {
  it("Accepted(SkillActivated) implies hp > 0 and mp >= cost immediately before; HP never negative", () => {
    fc.assert(
      fc.property(arbitraryScenario, (scenario) => {
        let world: World = scenario.world;
        for (const batch of scenario.full.committed.batches) {
          expect(batch.result.previousStateHash).toBe(scenario.protocol.hashing.hashState(world));
          for (const { envelope, verdict } of batch.result.results) {
            if (verdict.status === "Accepted" && verdict.event.type === "SkillActivated") {
              const actor = world.players.get(verdict.event.actor)!;
              expect(actor.hp).toBeGreaterThan(0);
              expect(actor.mp).toBeGreaterThanOrEqual(verdict.event.mpCost);
              expect(envelope.command).toMatchObject({ type: "UseSkill", actor: verdict.event.actor });
            }
            if (verdict.status === "Rejected" && verdict.reason.type === "ActorDead") {
              expect(envelope.command.type).toBe("UseSkill");
              expect(world.players.get((envelope.command as { actor: string }).actor)?.hp).toBe(0);
            }
            if (verdict.status === "Accepted") world = applyGameEvent(world, verdict.event);
            for (const player of world.players.values()) expect(player.hp).toBeGreaterThanOrEqual(0);
          }
          expect(scenario.protocol.hashing.hashState(world)).toBe(batch.result.resultingStateHash);
        }
      }),
      RUNS,
    );
  });
});
