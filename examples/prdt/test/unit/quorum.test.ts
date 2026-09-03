import { describe, expect, it } from "vitest";
import { sha256Hasher } from "../../src/core/hash.ts";
import type { GameCommand } from "../../src/examples/mmo/commands.ts";
import { gameCommandOrder } from "../../src/examples/mmo/order.ts";
import { FIREBALL, LETHAL_HIT, PLAYER_A, gameProtocol } from "../../src/examples/mmo/scenario.ts";
import { sharedSecretAuthenticator } from "../../src/finalizer/finalizer.ts";
import { assembleQuorumCertificate, createQuorumFinalizer, createVoter, type QuorumRoster } from "../../src/finalizer/quorum.ts";
import { addVote, emptyVotes, tallyVotes, voteLattice } from "../../src/finalizer/vote-state.ts";
import { ReplicatedDomain } from "../../src/prdt/replicated-domain.ts";
import { envelope, hpOf, proposalDelta } from "../helpers.ts";

function rosterOf(ids: readonly string[], threshold: number) {
  const auths = new Map(ids.map((id) => [id, sharedSecretAuthenticator(`key-${id}`)]));
  const roster: QuorumRoster = { verifiers: new Map([...auths].map(([id, a]) => [id, a])), threshold };
  const voters = new Map(
    ids.map((id) => [id, createVoter<GameCommand>({ voter: id, signer: auths.get(id)!, order: gameCommandOrder, hasher: sha256Hasher })]),
  );
  return { roster, voters };
}

describe("quorum roster", () => {
  it("requires a majority threshold for closure uniqueness", () => {
    expect(() => createQuorumFinalizer({ verifiers: rosterOf(["a", "b", "c"], 1).roster.verifiers, threshold: 1 })).toThrow(/majority/);
    expect(() => createQuorumFinalizer(rosterOf(["a", "b", "c"], 2).roster)).not.toThrow();
    expect(() => createQuorumFinalizer(rosterOf(["a", "b", "c", "d"], 2).roster)).toThrow(/majority/);
    expect(() => createQuorumFinalizer(rosterOf(["a"], 2).roster)).toThrow(/exceeds/);
  });
});

describe("quorum closure", () => {
  const skill = envelope("X", 0, 0, FIREBALL);
  const damage = envelope("Y", 0, 0, LETHAL_HIT);

  it("closes a tick once two of three voters agree, and drives the domain like the single authority", () => {
    const { roster, voters } = rosterOf(["a", "b", "c"], 2);
    const protocol = gameProtocol({ finalizer: createQuorumFinalizer<GameCommand>(roster) });
    const object = new ReplicatedDomain(protocol, "R");
    object.merge(proposalDelta(skill, damage));

    let votes = emptyVotes();
    votes = addVote(votes, voters.get("a")!.vote(0, protocol.genesisHash, [skill, damage]));
    expect(assembleQuorumCertificate(votes, 0, roster)).toBeUndefined();
    votes = addVote(votes, voters.get("b")!.vote(0, protocol.genesisHash, [damage, skill]));
    const certificate = assembleQuorumCertificate(votes, 0, roster);
    expect(certificate).toBeDefined();
    object.closeTick(certificate!);
    expect(object.decision().commands.get("X:0")).toEqual({ status: "Rejected", tick: 0, reason: { type: "ActorDead" } });
    expect(hpOf(object.domainState(), PLAYER_A)).toBe(0);
  });

  it("rejects a certificate with too few valid signatures or unknown voters", () => {
    const { roster, voters } = rosterOf(["a", "b", "c"], 2);
    const outsider = rosterOf(["z"], 1).voters.get("z")!;
    const protocol = gameProtocol({ finalizer: createQuorumFinalizer<GameCommand>(roster) });
    const object = new ReplicatedDomain(protocol, "R");
    object.merge(proposalDelta(damage));

    const single = addVote(emptyVotes(), voters.get("a")!.vote(0, protocol.genesisHash, [damage]));
    const loose = { verifiers: roster.verifiers, threshold: 1 };
    // Assemble with a permissive roster to fabricate an under-signed certificate, then verify with the real one.
    const weak = assembleQuorumCertificate(single, 0, { ...loose, verifiers: new Map([["a", roster.verifiers.get("a")!]]) })!;
    expect(() => object.closeTick(weak)).toThrow(/InvalidCertificate/);

    let withOutsider = addVote(single, outsider.vote(0, protocol.genesisHash, [damage]));
    withOutsider = addVote(withOutsider, voters.get("a")!.vote(0, protocol.genesisHash, [damage]));
    const forged = assembleQuorumCertificate(withOutsider, 0, {
      verifiers: new Map([["a", roster.verifiers.get("a")!], ["z", rosterOf(["z"], 1).roster.verifiers.get("z")!]]),
      threshold: 2,
    })!;
    expect(() => object.closeTick(forged)).toThrow(/InvalidCertificate/);
  });

  it("excludes an equivocating voter so competing payloads cannot both close a tick", () => {
    const { roster, voters } = rosterOf(["a", "b", "c"], 2);
    const protocol = gameProtocol({ finalizer: createQuorumFinalizer<GameCommand>(roster) });
    const lattice = voteLattice();

    // b honestly votes for {damage}; a votes for {damage} in one message and {damage, skill} in another.
    const honest = addVote(emptyVotes(), voters.get("b")!.vote(0, protocol.genesisHash, [damage]));
    const a1 = addVote(emptyVotes(), voters.get("a")!.vote(0, protocol.genesisHash, [damage]));
    const a2 = addVote(emptyVotes(), voters.get("a")!.vote(0, protocol.genesisHash, [damage, skill]));

    // Before the equivocation is known, {b, a1} would close.
    expect(assembleQuorumCertificate(lattice.merge(honest, a1), 0, roster)).toBeDefined();
    // Once both of a's votes are known, a is excluded and nothing closes.
    const all = lattice.merge(lattice.merge(honest, a1), a2);
    expect(tallyVotes(all, 0, new Set(roster.verifiers.keys())).equivocators).toEqual(["a"]);
    expect(assembleQuorumCertificate(all, 0, roster)).toBeUndefined();
    // Merge order does not matter.
    expect(lattice.equals(all, lattice.merge(a2, lattice.merge(a1, honest)))).toBe(true);
  });

  it("competing candidates never both reach a majority", () => {
    const { roster, voters } = rosterOf(["a", "b", "c"], 2);
    const protocol = gameProtocol({ finalizer: createQuorumFinalizer<GameCommand>(roster) });
    let votes = emptyVotes();
    votes = addVote(votes, voters.get("a")!.vote(0, protocol.genesisHash, [damage]));
    votes = addVote(votes, voters.get("b")!.vote(0, protocol.genesisHash, [damage, skill]));
    votes = addVote(votes, voters.get("c")!.vote(0, protocol.genesisHash, [damage]));
    const certificate = assembleQuorumCertificate(votes, 0, roster);
    expect(certificate?.orderedCommandIds).toEqual(["Y:0"]);
  });
});
