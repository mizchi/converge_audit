/**
 * Committed prefix log.
 *
 * Decision order is prefix order:
 *   [] <= [t0] <= [t0, t1]
 * Two logs that agree on a shared prefix but differ afterwards are not
 * comparable and can never be joined; merging them is a protocol error.
 */
import type { Hash, Tick } from "../core/ids.ts";
import type { JoinSemilattice } from "../core/lattice.ts";
import { ProtocolError } from "./errors.ts";

export interface CommittedBatch<R> {
  readonly tick: Tick;
  readonly parentDecisionHash: Hash;
  readonly orderedCommandsHash: Hash;
  readonly resultHash: Hash;
  readonly result: R;
}

export interface CommittedLog<R> {
  readonly batches: readonly CommittedBatch<R>[];
}

export function emptyLog<R>(): CommittedLog<R> {
  return { batches: [] };
}

export function isPrefixOf<R>(prefix: CommittedLog<R>, log: CommittedLog<R>): boolean {
  if (prefix.batches.length > log.batches.length) return false;
  for (let i = 0; i < prefix.batches.length; i += 1) {
    const a = prefix.batches[i]!;
    const b = log.batches[i]!;
    if (a.tick !== b.tick || a.resultHash !== b.resultHash) return false;
  }
  return true;
}

export function committedLogLattice<R>(): JoinSemilattice<CommittedLog<R>> {
  return {
    merge(left, right) {
      const [shorter, longer] = left.batches.length <= right.batches.length ? [left, right] : [right, left];
      if (!isPrefixOf(shorter, longer)) {
        const index = firstDivergence(shorter, longer);
        throw new ProtocolError("PrefixConflict", `committed logs diverge at index ${index}`, {
          index,
          left: shorter.batches[index]?.resultHash,
          right: longer.batches[index]?.resultHash,
        });
      }
      return longer;
    },
    equals(left, right) {
      return left.batches.length === right.batches.length && isPrefixOf(left, right);
    },
  };
}

function firstDivergence<R>(a: CommittedLog<R>, b: CommittedLog<R>): number {
  const n = Math.min(a.batches.length, b.batches.length);
  for (let i = 0; i < n; i += 1) {
    if (a.batches[i]!.resultHash !== b.batches[i]!.resultHash || a.batches[i]!.tick !== b.batches[i]!.tick) {
      return i;
    }
  }
  return n;
}

export function headDecisionHash<R>(log: CommittedLog<R>, genesisHash: Hash): Hash {
  const head = log.batches[log.batches.length - 1];
  return head === undefined ? genesisHash : head.resultHash;
}
