import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { sha256Hasher } from "../../src/core/hash.ts";
import { gameCommandOrder } from "../../src/examples/mmo/order.ts";
import { sharedSecretAuthenticator } from "../../src/finalizer/finalizer.ts";
import { createVoter } from "../../src/finalizer/quorum.ts";
import { addVote, emptyVotes, voteLattice, type VoteState } from "../../src/finalizer/vote-state.ts";
import { closureMapFrom, closureMapLattice } from "../../src/prdt/closure.ts";
import { committedLogLattice, type CommittedLog } from "../../src/prdt/committed-log.ts";
import { latticeLawViolations } from "../../src/prdt/laws.ts";
import { emptyProposals, proposalLattice, singletonProposal, type ProposalState } from "../../src/prdt/proposal-state.ts";
import type { GameCommand } from "../../src/examples/mmo/commands.ts";
import { arbitraryReachable, arbitraryScenario, type Scenario } from "./arbitraries.ts";

const RUNS = { numRuns: 60 };

function proposalSubset(scenario: Scenario): fc.Arbitrary<ProposalState<GameCommand>> {
  return fc.subarray([...scenario.envelopes]).map((subset) => {
    let state = emptyProposals<GameCommand>();
    for (const envelope of subset) state = proposalLattice<GameCommand>().merge(state, singletonProposal(envelope));
    return state;
  });
}

describe("lattice laws", () => {
  it("ProposalState", () => {
    fc.assert(
      fc.property(arbitraryScenario.chain((s) => fc.tuple(proposalSubset(s), proposalSubset(s), proposalSubset(s))), ([a, b, c]) => {
        expect(latticeLawViolations(proposalLattice<GameCommand>(), a, b, c)).toEqual([]);
      }),
      RUNS,
    );
  });

  it("ClosureMap", () => {
    fc.assert(
      fc.property(
        arbitraryScenario.chain((s) => {
          const subset = () => fc.subarray([...s.certificates]).map(closureMapFrom);
          return fc.tuple(subset(), subset(), subset());
        }),
        ([a, b, c]) => {
          expect(latticeLawViolations(closureMapLattice(), a, b, c)).toEqual([]);
        },
      ),
      RUNS,
    );
  });

  it("CommittedLog (prefixes of one log)", () => {
    fc.assert(
      fc.property(
        arbitraryScenario.chain((s) => {
          const log = s.full.committed;
          const prefix = () => fc.integer({ min: 0, max: log.batches.length }).map((n): CommittedLog<unknown> => ({ batches: log.batches.slice(0, n) }));
          return fc.tuple(prefix(), prefix(), prefix());
        }),
        ([a, b, c]) => {
          expect(latticeLawViolations(committedLogLattice<unknown>(), a, b, c)).toEqual([]);
        },
      ),
      RUNS,
    );
  });

  it("VoteState (including equivocation slots)", () => {
    const voters = ["a", "b", "c"].map((id) =>
      createVoter<GameCommand>({ voter: id, signer: sharedSecretAuthenticator(id), order: gameCommandOrder, hasher: sha256Hasher }),
    );
    const arbitraryVote = fc
      .tuple(fc.integer({ min: 0, max: 2 }), fc.integer({ min: 0, max: 1 }), fc.constantFrom("p0", "p1"), fc.subarray(["x:0", "y:0", "z:0"]))
      .map(([voter, tick, parent, ids]) =>
        voters[voter]!.vote(tick, parent, ids.map((id) => ({ id, tick, submittedBy: id.split(":")[0]!, localSequence: 0, command: { type: "Damage", source: "s", target: "t", amount: 1 } as GameCommand }))),
      );
    const arbitraryVotes = fc.array(arbitraryVote, { maxLength: 6 }).map((votes) => votes.reduce<VoteState>((s, v) => addVote(s, v), emptyVotes()));
    fc.assert(
      fc.property(arbitraryVotes, arbitraryVotes, arbitraryVotes, (a, b, c) => {
        expect(latticeLawViolations(voteLattice(), a, b, c)).toEqual([]);
      }),
      RUNS,
    );
  });

  it("whole ReplicatedDomainState (merge + advance)", () => {
    fc.assert(
      fc.property(
        arbitraryScenario.chain((s) => fc.tuple(fc.constant(s), arbitraryReachable(s), arbitraryReachable(s), arbitraryReachable(s))),
        ([scenario, a, b, c]) => {
          expect(latticeLawViolations(scenario.protocol.lattice, a.state, b.state, c.state)).toEqual([]);
        },
      ),
      RUNS,
    );
  });
});
