/**
 * Negative test: accepting before closure breaks decision monotonicity.
 *
 * An "eager" finalizer that marks a skill Accepted as soon as it is known
 * locally must later flip it to Rejected when a lethal Damage for the same
 * tick arrives. That is exactly the Accepted -> Rejected transition the
 * decision order forbids. The framework keeps every command Pending until
 * the tick's closure certificate fixes the complete input set.
 */
import { describe, expect, it } from "vitest";
import { resolveBatch } from "../../src/domain/resolve-batch.ts";
import type { GameCommand } from "../../src/examples/mmo/commands.ts";
import { createGameDomain } from "../../src/examples/mmo/domain.ts";
import { gameCommandOrder } from "../../src/examples/mmo/order.ts";
import { FIREBALL, LETHAL_HIT, LETHAL_RACE_WORLD } from "../../src/examples/mmo/scenario.ts";
import { commandDecisionLessOrEqual, decisionLessOrEqual } from "../../src/prdt/laws.ts";
import { proposalsForTick, type ProposalState } from "../../src/prdt/proposal-state.ts";
import { ReplicatedDomain, type CommandDecision } from "../../src/prdt/replicated-domain.ts";
import { closeNext, envelope, singleAuthoritySetup } from "../helpers.ts";

const domain = createGameDomain(LETHAL_RACE_WORLD);

/** Unsafe: decide every known command immediately from the current knowledge. */
function eagerDecision(state: ProposalState<GameCommand>, hashing: Parameters<typeof resolveBatch>[5]): Map<string, CommandDecision<unknown, unknown>> {
  const batch = resolveBatch(0, LETHAL_RACE_WORLD, [...proposalsForTick(state, 0).values()], domain, gameCommandOrder, hashing);
  return new Map(
    batch.results.map((r) => [
      r.envelope.id,
      r.verdict.status === "Accepted" ? { status: "Accepted", tick: 0, event: r.verdict.event } : { status: "Rejected", tick: 0, reason: r.verdict.reason },
    ]),
  );
}

describe("negative: premature acceptance", () => {
  const skill = envelope("X", 0, 0, FIREBALL);
  const damage = envelope("Y", 0, 0, LETHAL_HIT);

  it("an eager decision moves Accepted -> Rejected when late damage arrives, violating monotonicity", () => {
    const { protocol } = singleAuthoritySetup();
    const x = new ReplicatedDomain(protocol, "X");
    x.merge({ proposals: [skill], closures: [] });
    const before = eagerDecision(x.state.proposals, protocol.hashing);
    expect(before.get("X:0")?.status).toBe("Accepted");

    x.merge({ proposals: [damage], closures: [] });
    const after = eagerDecision(x.state.proposals, protocol.hashing);
    expect(after.get("X:0")?.status).toBe("Rejected");
    expect(commandDecisionLessOrEqual(before.get("X:0")!, after.get("X:0")!)).toBe(false);
  });

  it("the framework keeps the skill Pending until closure, so the decision only grows", () => {
    const { protocol, authority } = singleAuthoritySetup();
    const x = new ReplicatedDomain(protocol, "X");
    x.merge({ proposals: [skill], closures: [] });
    const d0 = x.decision();
    expect(d0.commands.get("X:0")).toEqual({ status: "Pending" });

    x.merge({ proposals: [damage], closures: [] });
    const d1 = x.decision();
    expect(decisionLessOrEqual(d0, d1)).toBe(true);

    closeNext(x, authority);
    const d2 = x.decision();
    expect(decisionLessOrEqual(d1, d2)).toBe(true);
    expect(d2.commands.get("X:0")).toEqual({ status: "Rejected", tick: 0, reason: { type: "ActorDead" } });
  });
});
