/**
 * Tick closure.
 *
 * A PRDT cannot infer "no more commands will arrive for this tick" from the
 * event set alone; that negative information must be certified explicitly.
 * A `ClosureCertificate` fixes the exact ordered command set of one tick and
 * chains it to the decision hash of the previous tick.
 *
 * Decision order:
 *   Pending <= Closed(c)
 *   Closed(a) <= Closed(b)  iff  a == b
 * Two different certificates for the same tick can never be joined.
 */
import { canonicalize } from "../core/canonical.ts";
import {
  arrayCodec,
  bytesCodec,
  expectArray,
  expectNumber,
  expectRecord,
  expectString,
  jsonCodec,
  type Codec,
} from "../core/codec.ts";
import type { CommandId, Hash, Tick } from "../core/ids.ts";
import { mapLattice, type JoinSemilattice } from "../core/lattice.ts";
import { ProtocolError } from "./errors.ts";

export interface ClosureCertificate {
  readonly tick: Tick;
  readonly parentDecisionHash: Hash;
  readonly orderedCommandIds: readonly CommandId[];
  readonly orderedCommandsHash: Hash;
  /** Finalizer-specific proof bytes (signature, quorum votes, ...). */
  readonly certificate: Uint8Array;
}

export type ClosureDecision =
  | { readonly status: "Pending" }
  | { readonly status: "Closed"; readonly certificate: ClosureCertificate };

export const PENDING: ClosureDecision = { status: "Pending" };

export function closed(certificate: ClosureCertificate): ClosureDecision {
  return { status: "Closed", certificate };
}

export function certificateEquals(left: ClosureCertificate, right: ClosureCertificate): boolean {
  return left === right || canonicalize(left) === canonicalize(right);
}

export const closureDecisionLattice: JoinSemilattice<ClosureDecision> = {
  merge(left, right) {
    if (left.status === "Pending") return right;
    if (right.status === "Pending") return left;
    if (!certificateEquals(left.certificate, right.certificate)) {
      throw new ProtocolError("ConflictingClosure", `tick ${left.certificate.tick} closed twice`, {
        tick: left.certificate.tick,
        left: left.certificate.orderedCommandsHash,
        right: right.certificate.orderedCommandsHash,
      });
    }
    return left;
  },
  equals(left, right) {
    if (left.status !== right.status) return false;
    if (left.status === "Pending" || right.status === "Pending") return true;
    return certificateEquals(left.certificate, right.certificate);
  },
};

export type ClosureMap = ReadonlyMap<Tick, ClosureDecision>;

export function closureMapLattice(): JoinSemilattice<ClosureMap> {
  return mapLattice<Tick, ClosureDecision>(closureDecisionLattice);
}

export function closureFor(map: ClosureMap, tick: Tick): ClosureDecision {
  return map.get(tick) ?? PENDING;
}

export function closureMapFrom(certificates: readonly ClosureCertificate[]): ClosureMap {
  const lattice = closureMapLattice();
  let out: ClosureMap = new Map();
  for (const certificate of certificates) {
    out = lattice.merge(out, new Map([[certificate.tick, closed(certificate)]]));
  }
  return out;
}

export function listClosures(map: ClosureMap): ClosureCertificate[] {
  const ticks = [...map.keys()].sort((a, b) => a - b);
  const out: ClosureCertificate[] = [];
  for (const tick of ticks) {
    const decision = map.get(tick)!;
    if (decision.status === "Closed") out.push(decision.certificate);
  }
  return out;
}

const commandIdsCodec = arrayCodec(jsonCodec<string>());

export const closureCertificateCodec: Codec<ClosureCertificate> = {
  encode: (certificate) => ({
    tick: certificate.tick,
    parentDecisionHash: certificate.parentDecisionHash,
    orderedCommandIds: commandIdsCodec.encode(certificate.orderedCommandIds),
    orderedCommandsHash: certificate.orderedCommandsHash,
    certificate: bytesCodec.encode(certificate.certificate),
  }),
  decode: (json) => {
    const record = expectRecord(json, "closureCertificate");
    const ids = expectArray(record.orderedCommandIds, "closureCertificate.orderedCommandIds").map((id) =>
      expectString(id, "closureCertificate.orderedCommandIds[]"),
    );
    return {
      tick: expectNumber(record.tick, "closureCertificate.tick"),
      parentDecisionHash: expectString(record.parentDecisionHash, "closureCertificate.parentDecisionHash"),
      orderedCommandIds: ids,
      orderedCommandsHash: expectString(record.orderedCommandsHash, "closureCertificate.orderedCommandsHash"),
      certificate: bytesCodec.decode(record.certificate ?? null),
    };
  },
};
