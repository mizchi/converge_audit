import { describe, expect, it } from "vitest";
import { FIREBALL, LETHAL_HIT } from "../../src/examples/mmo/scenario.ts";
import { isProtocolError } from "../../src/prdt/errors.ts";
import { addProposal, emptyProposals, listProposals, proposalLattice, proposalsForTick } from "../../src/prdt/proposal-state.ts";
import { envelope } from "../helpers.ts";

describe("ProposalState", () => {
  const lattice = proposalLattice();

  it("is a set union keyed by command id", () => {
    const a = addProposal(emptyProposals(), envelope("x", 0, 0, FIREBALL));
    const b = addProposal(emptyProposals(), envelope("y", 0, 0, LETHAL_HIT));
    const merged = lattice.merge(a, b);
    expect([...proposalsForTick(merged, 0).keys()].sort()).toEqual(["x:0", "y:0"]);
    expect(lattice.equals(lattice.merge(merged, a), merged)).toBe(true);
  });

  it("refuses two payloads for one command id without adopting either", () => {
    const a = addProposal(emptyProposals(), envelope("x", 0, 0, FIREBALL));
    const b = addProposal(emptyProposals(), envelope("x", 0, 0, LETHAL_HIT));
    let caught: unknown;
    try {
      lattice.merge(a, b);
    } catch (error) {
      caught = error;
    }
    expect(isProtocolError(caught, "ConflictingProposal")).toBe(true);
    expect(proposalsForTick(a, 0).get("x:0")?.command).toEqual(FIREBALL);
    expect(proposalsForTick(b, 0).get("x:0")?.command).toEqual(LETHAL_HIT);
  });

  it("lists proposals in (tick, id) order regardless of insertion order", () => {
    const s1 = addProposal(addProposal(emptyProposals(), envelope("y", 0, 1, LETHAL_HIT)), envelope("x", 0, 0, FIREBALL));
    const s2 = addProposal(addProposal(emptyProposals(), envelope("x", 0, 0, FIREBALL)), envelope("y", 0, 1, LETHAL_HIT));
    expect(listProposals(s1)).toEqual(listProposals(s2));
    expect(listProposals(s1).map((e) => e.id)).toEqual(["x:0", "y:0"]);
  });
});
