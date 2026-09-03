import { describe, expect, it } from "vitest";
import {
  closed,
  closureCertificateCodec,
  closureDecisionLattice,
  closureMapLattice,
  PENDING,
  type ClosureCertificate,
} from "../../src/prdt/closure.ts";
import { committedLogLattice, isPrefixOf, type CommittedLog } from "../../src/prdt/committed-log.ts";
import { isProtocolError } from "../../src/prdt/errors.ts";

const certA: ClosureCertificate = { tick: 0, parentDecisionHash: "g", orderedCommandIds: ["x:0"], orderedCommandsHash: "h1", certificate: new Uint8Array([1]) };
const certB: ClosureCertificate = { ...certA, orderedCommandIds: ["y:0"], orderedCommandsHash: "h2" };

describe("ClosureDecision lattice", () => {
  it("Pending <= Closed and Closed(a) == Closed(a)", () => {
    expect(closureDecisionLattice.merge(PENDING, closed(certA))).toEqual(closed(certA));
    expect(closureDecisionLattice.merge(closed(certA), PENDING)).toEqual(closed(certA));
    expect(closureDecisionLattice.merge(closed(certA), closed({ ...certA }))).toEqual(closed(certA));
  });

  it("refuses two different certificates for one tick", () => {
    let caught: unknown;
    try {
      closureMapLattice().merge(new Map([[0, closed(certA)]]), new Map([[0, closed(certB)]]));
    } catch (error) {
      caught = error;
    }
    expect(isProtocolError(caught, "ConflictingClosure")).toBe(true);
  });

  it("round-trips through the codec", () => {
    const json = JSON.parse(JSON.stringify(closureCertificateCodec.encode(certA)));
    expect(closureCertificateCodec.decode(json)).toEqual(certA);
  });
});

describe("CommittedLog prefix lattice", () => {
  const batch = (tick: number, resultHash: string) => ({ tick, parentDecisionHash: "p", orderedCommandsHash: "o", resultHash, result: null });
  const l0: CommittedLog<null> = { batches: [] };
  const l1: CommittedLog<null> = { batches: [batch(0, "a")] };
  const l2: CommittedLog<null> = { batches: [batch(0, "a"), batch(1, "b")] };
  const l2x: CommittedLog<null> = { batches: [batch(0, "a"), batch(1, "c")] };
  const lattice = committedLogLattice<null>();

  it("joins to the longer log when one is a prefix of the other", () => {
    expect(isPrefixOf(l0, l2)).toBe(true);
    expect(isPrefixOf(l1, l2)).toBe(true);
    expect(isPrefixOf(l2, l1)).toBe(false);
    expect(lattice.merge(l1, l2)).toBe(l2);
    expect(lattice.merge(l2, l1)).toBe(l2);
  });

  it("refuses logs that diverge", () => {
    let caught: unknown;
    try {
      lattice.merge(l2, l2x);
    } catch (error) {
      caught = error;
    }
    expect(isProtocolError(caught, "PrefixConflict")).toBe(true);
  });
});
