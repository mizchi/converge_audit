import { describe, expect, it } from "vitest";
import { BatchTickMismatchError, resolveBatch } from "../../src/domain/resolve-batch.ts";
import { createGameDomain } from "../../src/examples/mmo/domain.ts";
import { gameCommandOrder } from "../../src/examples/mmo/order.ts";
import { FIREBALL, LETHAL_HIT, LETHAL_RACE_WORLD, PLAYER_A } from "../../src/examples/mmo/scenario.ts";
import { envelope, singleAuthoritySetup } from "../helpers.ts";

const domain = createGameDomain(LETHAL_RACE_WORLD);
const { protocol } = singleAuthoritySetup();

describe("resolveBatch", () => {
  const skill = envelope("x", 0, 0, FIREBALL);
  const damage = envelope("y", 0, 0, LETHAL_HIT);

  it("applies damage before skills and rejects the dead actor's skill", () => {
    const batch = resolveBatch(0, LETHAL_RACE_WORLD, [skill, damage], domain, gameCommandOrder, protocol.hashing);
    expect(batch.results.map((r) => r.envelope.id)).toEqual(["y:0", "x:0"]);
    expect(batch.results[0]?.verdict).toEqual({ status: "Accepted", event: { type: "DamageApplied", source: "monster", target: PLAYER_A, amount: 20 } });
    expect(batch.results[1]?.verdict).toEqual({ status: "Rejected", reason: { type: "ActorDead" } });
    expect(batch.resultingState.players.get(PLAYER_A)?.hp).toBe(0);
    expect(batch.resultingState.players.get(PLAYER_A)?.mp).toBe(100);
  });

  it("does not depend on the input array order", () => {
    const a = resolveBatch(0, LETHAL_RACE_WORLD, [skill, damage], domain, gameCommandOrder, protocol.hashing);
    const b = resolveBatch(0, LETHAL_RACE_WORLD, [damage, skill], domain, gameCommandOrder, protocol.hashing);
    expect(a).toEqual(b);
    expect(a.orderedCommandHash).toBe(b.orderedCommandHash);
    expect(a.resultingStateHash).toBe(b.resultingStateHash);
  });

  it("leaves the input array untouched", () => {
    const input = [skill, damage];
    resolveBatch(0, LETHAL_RACE_WORLD, input, domain, gameCommandOrder, protocol.hashing);
    expect(input).toEqual([skill, damage]);
  });

  it("rejects envelopes for another tick", () => {
    expect(() => resolveBatch(1, LETHAL_RACE_WORLD, [skill], domain, gameCommandOrder, protocol.hashing)).toThrow(BatchTickMismatchError);
  });

  it("rejects duplicate command ids", () => {
    expect(() => resolveBatch(0, LETHAL_RACE_WORLD, [skill, skill], domain, gameCommandOrder, protocol.hashing)).toThrow(/duplicate/);
  });
});
