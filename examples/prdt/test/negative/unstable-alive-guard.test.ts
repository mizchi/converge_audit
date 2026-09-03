/**
 * Negative test: `alive` as a proposal-time PRDT precondition is unstable.
 *
 * A precondition is stable when `pre(s)` implies `pre(merge(s, d))` for every
 * delta `d`. Here a concurrent Damage delta flips `hp > 0` from true to
 * false, so a replica that accepted the skill "because the actor was alive"
 * and a replica that rejected it "because the actor was dead" are both
 * locally justified and can never agree. The framework avoids this by never
 * evaluating `alive` at proposal time.
 */
import { describe, expect, it } from "vitest";
import type { Envelope } from "../../src/core/ids.ts";
import { sortCommands } from "../../src/core/order.ts";
import type { GameCommand } from "../../src/examples/mmo/commands.ts";
import { applyGameEvent, validateGameCommand } from "../../src/examples/mmo/domain.ts";
import { isAlive, type World } from "../../src/examples/mmo/model.ts";
import { gameCommandOrder } from "../../src/examples/mmo/order.ts";
import { FIREBALL, LETHAL_HIT, LETHAL_RACE_WORLD, PLAYER_A } from "../../src/examples/mmo/scenario.ts";
import { addProposal, emptyProposals, proposalLattice, proposalsForTick, type ProposalState } from "../../src/prdt/proposal-state.ts";
import { ReplicatedDomain } from "../../src/prdt/replicated-domain.ts";
import { closeNext, envelope, singleAuthoritySetup } from "../helpers.ts";

/** Speculative world: apply everything known for the tick in canonical order. */
function speculativeWorld(state: ProposalState<GameCommand>, tick: number): World {
  let world = LETHAL_RACE_WORLD;
  for (const e of sortCommands([...proposalsForTick(state, tick).values()], gameCommandOrder)) {
    const v = validateGameCommand(world, e.command);
    if (v.accepted) world = applyGameEvent(world, v.event);
  }
  return world;
}

/** The unsafe design: guard the proposal with `alive` evaluated on local knowledge. */
function aliveGuard(state: ProposalState<GameCommand>, envelope: Envelope<GameCommand>): boolean {
  return envelope.command.type === "UseSkill" && isAlive(speculativeWorld(state, envelope.tick), envelope.command.actor);
}

describe("negative: alive as a proposal precondition", () => {
  const skill = envelope("X", 0, 0, FIREBALL);
  const damage = envelope("Y", 0, 0, LETHAL_HIT);

  it("is not stable under merge: pre(s) holds but pre(merge(s, damage)) fails", () => {
    const s = emptyProposals<GameCommand>();
    const withDamage = addProposal(s, damage);
    expect(aliveGuard(s, skill)).toBe(true);
    expect(aliveGuard(withDamage, skill)).toBe(false);
    expect(proposalLattice<GameCommand>().equals(withDamage, proposalLattice<GameCommand>().merge(s, withDamage))).toBe(true);
  });

  it("lets two replicas reach opposite local verdicts for the same command", () => {
    const x = addProposal(emptyProposals<GameCommand>(), skill); // X knows only its own skill
    const y = addProposal(addProposal(emptyProposals<GameCommand>(), damage), skill); // Y saw the damage first
    const verdictX = aliveGuard(x, skill) ? "Accepted" : "Rejected";
    const verdictY = aliveGuard(y, skill) ? "Accepted" : "Rejected";
    expect(verdictX).toBe("Accepted");
    expect(verdictY).toBe("Rejected");
    expect(verdictX).not.toBe(verdictY);
  });

  it("the framework evaluates alive only inside the finalized batch, so every replica agrees", () => {
    const { protocol, authority } = singleAuthoritySetup();
    const a = new ReplicatedDomain(protocol, "A");
    a.merge({ proposals: [skill], closures: [] });
    expect(a.decision().commands.get("X:0")).toEqual({ status: "Pending" }); // not Accepted "because alive"
    a.merge({ proposals: [damage], closures: [] });
    const certificate = closeNext(a, authority);
    const b = new ReplicatedDomain(protocol, "B");
    b.merge({ proposals: [skill, damage], closures: [certificate] });
    expect(a.decision().commands.get("X:0")).toEqual({ status: "Rejected", tick: 0, reason: { type: "ActorDead" } });
    expect(b.decision().commands.get("X:0")).toEqual(a.decision().commands.get("X:0"));
    expect(b.domainState().players.get(PLAYER_A)?.hp).toBe(0);
  });
});
