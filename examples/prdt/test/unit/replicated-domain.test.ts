import { describe, expect, it } from "vitest";
import { FIREBALL, LETHAL_HIT, PLAYER_A } from "../../src/examples/mmo/scenario.ts";
import { closureMessage } from "../../src/finalizer/finalizer.ts";
import { isProtocolError } from "../../src/prdt/errors.ts";
import { ReplicatedDomain } from "../../src/prdt/replicated-domain.ts";
import { closeNext, closureDelta, envelope, hpOf, proposalDelta, singleAuthoritySetup } from "../helpers.ts";

describe("Replicated MMO object: lethal damage races a skill", () => {
  it("converges on Damage=Accepted, Skill=Rejected(ActorDead) in either arrival order", () => {
    const { protocol, authority } = singleAuthoritySetup();
    const x = new ReplicatedDomain(protocol, "X");
    const y = new ReplicatedDomain(protocol, "Y");
    const skill = x.propose({ tick: 0, command: FIREBALL });
    const damage = y.propose({ tick: 0, command: LETHAL_HIT });

    // Authority hears both and closes tick 0.
    const auth = new ReplicatedDomain(protocol, "A");
    auth.merge(damage.delta);
    auth.merge(skill.delta);
    const certificate = closeNext(auth, authority);
    expect(certificate.orderedCommandIds).toEqual(["Y:0", "X:0"]);

    // X: skill first, then closure, then damage. Y: damage, closure, skill.
    x.merge(closureDelta(certificate));
    expect(x.decision().commands.get("X:0")).toEqual({ status: "Pending" }); // closed, waiting for Y:0
    x.merge(damage.delta);
    y.merge(skill.delta);
    y.merge(closureDelta(certificate));

    for (const replica of [x, y, auth]) {
      const decision = replica.decision();
      expect(decision.commands.get("Y:0")).toEqual({ status: "Accepted", tick: 0, event: { type: "DamageApplied", source: "monster", target: PLAYER_A, amount: 20 } });
      expect(decision.commands.get("X:0")).toEqual({ status: "Rejected", tick: 0, reason: { type: "ActorDead" } });
      expect(hpOf(replica.domainState(), PLAYER_A)).toBe(0);
      expect(replica.stateHash()).toBe(auth.stateHash());
    }
  });

  it("does not add a late command to a closed tick and keeps the committed result", () => {
    const { protocol, authority } = singleAuthoritySetup();
    const auth = new ReplicatedDomain(protocol, "A");
    auth.merge(proposalDelta(envelope("Y", 0, 0, LETHAL_HIT)));
    closeNext(auth, authority);
    const before = auth.decision();

    auth.merge(proposalDelta(envelope("X", 0, 0, FIREBALL))); // late
    const after = auth.decision();
    expect(after.commands.get("X:0")).toEqual({ status: "RejectedLate", closedTick: 0 });
    expect(after.headDecisionHash).toBe(before.headDecisionHash);
    expect(after.committedTicks).toEqual([0]);
    expect(auth.state.committed.batches[0]?.result.results.map((r) => r.envelope.id)).toEqual(["Y:0"]);
  });

  it("chains ticks: the skill in tick 1 is rejected because tick 0 killed the actor", () => {
    const { protocol, authority } = singleAuthoritySetup();
    const auth = new ReplicatedDomain(protocol, "A");
    auth.merge(proposalDelta(envelope("Y", 0, 0, LETHAL_HIT)));
    closeNext(auth, authority);
    auth.merge(proposalDelta(envelope("X", 0, 1, FIREBALL)));
    closeNext(auth, authority);
    expect(auth.decision().commands.get("X:0")).toEqual({ status: "Rejected", tick: 1, reason: { type: "ActorDead" } });
    expect(auth.decision().committedTicks).toEqual([0, 1]);
  });

  it("rejects a certificate from an unknown authority and leaves the state unchanged", () => {
    const { protocol, authority: forged } = singleAuthoritySetup({ secret: "attacker" });
    const { protocol: real } = singleAuthoritySetup({ secret: "real" });
    const auth = new ReplicatedDomain(real, "A");
    auth.merge(proposalDelta(envelope("Y", 0, 0, LETHAL_HIT)));
    const certificate = forged.close(0, protocol.genesisHash, [envelope("Y", 0, 0, LETHAL_HIT)]);
    const before = auth.stateHash();
    let caught: unknown;
    try {
      auth.closeTick(certificate);
    } catch (error) {
      caught = error;
    }
    expect(isProtocolError(caught, "InvalidCertificate")).toBe(true);
    expect(auth.stateHash()).toBe(before);
    expect(auth.decision().commands.get("Y:0")).toEqual({ status: "Pending" });
  });

  it("rejects a certificate whose hash does not match its ids", () => {
    const { protocol, authority } = singleAuthoritySetup();
    const auth = new ReplicatedDomain(protocol, "A");
    const certificate = authority.close(0, protocol.genesisHash, []);
    let caught: unknown;
    try {
      auth.closeTick({ ...certificate, orderedCommandIds: ["Y:0"] });
    } catch (error) {
      caught = error;
    }
    expect(isProtocolError(caught, "MalformedCertificate")).toBe(true);
  });

  it("rejects a certificate that chains from a different parent", () => {
    const { protocol, authority } = singleAuthoritySetup();
    const auth = new ReplicatedDomain(protocol, "A");
    const certificate = authority.close(0, "not-the-genesis-hash", []);
    let caught: unknown;
    try {
      auth.closeTick(certificate);
    } catch (error) {
      caught = error;
    }
    expect(isProtocolError(caught, "ChainMismatch")).toBe(true);
    expect(auth.decision().committedTicks).toEqual([]);
  });

  it("rejects a certificate whose id order is not canonical", () => {
    const { protocol, authority, authenticator } = singleAuthoritySetup();
    const auth = new ReplicatedDomain(protocol, "A");
    auth.merge(proposalDelta(envelope("X", 0, 0, FIREBALL), envelope("Y", 0, 0, LETHAL_HIT)));
    const canonical = authority.close(0, protocol.genesisHash, [envelope("X", 0, 0, FIREBALL), envelope("Y", 0, 0, LETHAL_HIT)]);
    const swappedIds = [...canonical.orderedCommandIds].reverse();
    const payload = { tick: 0, parentDecisionHash: protocol.genesisHash, orderedCommandsHash: protocol.hashing.hashCommandIds(swappedIds) };
    const swapped = { ...payload, orderedCommandIds: swappedIds, certificate: authenticator.sign(closureMessage(payload)) };
    let caught: unknown;
    try {
      auth.closeTick(swapped);
    } catch (error) {
      caught = error;
    }
    expect(isProtocolError(caught, "OrderMismatch")).toBe(true);
    expect(auth.decision().committedTicks).toEqual([]);
  });

  it("never reuses a local sequence number after a snapshot restore", () => {
    const { protocol } = singleAuthoritySetup();
    const x = new ReplicatedDomain(protocol, "X");
    x.propose({ tick: 0, command: FIREBALL });
    const restored = ReplicatedDomain.restore(protocol, JSON.parse(JSON.stringify(x.snapshot())));
    expect(restored.nextLocalSequence).toBe(1);
    expect(restored.propose({ tick: 0, command: LETHAL_HIT }).envelope.id).toBe("X:1");
    expect(restored.stateHash()).not.toBe(x.stateHash());
  });

  it("restores a snapshot to an equal state including the committed prefix", () => {
    const { protocol, authority } = singleAuthoritySetup();
    const auth = new ReplicatedDomain(protocol, "A");
    auth.merge(proposalDelta(envelope("Y", 0, 0, LETHAL_HIT), envelope("X", 0, 0, FIREBALL)));
    closeNext(auth, authority);
    auth.merge(proposalDelta(envelope("X", 1, 1, FIREBALL)));
    const restored = ReplicatedDomain.restore(protocol, JSON.parse(JSON.stringify(auth.snapshot())));
    expect(restored.stateHash()).toBe(auth.stateHash());
    expect(protocol.lattice.equals(restored.state, auth.state)).toBe(true);
    expect(restored.decision()).toEqual(auth.decision());
  });
});
