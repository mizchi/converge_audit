/**
 * Quorum finalization (safety half of Phase 5).
 *
 * A tick is closed when at least `threshold` distinct roster members sign the
 * same closure payload. Uniqueness follows from `2 * threshold > roster.size`:
 * any two quorums intersect in at least one voter, and a non-equivocating
 * voter signs at most one payload per tick. An equivocating voter is excluded
 * from every tally, so it can never lend its weight to two payloads.
 *
 * Leader election, retry, and view change (liveness) are out of scope here;
 * this module only decides what counts as a valid certificate and how to
 * assemble one from a `VoteState`.
 */
import { compareStrings, utf8Decode, utf8Encode, type JsonValue } from "../core/canonical.ts";
import { bytesCodec, expectArray, expectRecord, expectString } from "../core/codec.ts";
import { hashValue, type Hasher } from "../core/hash.ts";
import type { Envelope, Hash, ReplicaId, Tick } from "../core/ids.ts";
import { sortCommands, type CommandOrder } from "../core/order.ts";
import type { ClosureCertificate } from "../prdt/closure.ts";
import { closureMessage, type Finalizer, type Signer, type Verifier } from "./finalizer.ts";
import { tallyVotes, type ClosureVote, type VoteState } from "./vote-state.ts";

export interface QuorumRoster {
  readonly verifiers: ReadonlyMap<ReplicaId, Verifier>;
  readonly threshold: number;
}

export function assertQuorumRoster(roster: QuorumRoster): void {
  const size = roster.verifiers.size;
  if (!Number.isInteger(roster.threshold) || roster.threshold < 1) {
    throw new RangeError(`threshold must be a positive integer: ${roster.threshold}`);
  }
  if (roster.threshold > size) throw new RangeError(`threshold ${roster.threshold} exceeds roster size ${size}`);
  if (2 * roster.threshold <= size) {
    throw new RangeError(`threshold ${roster.threshold} is not a majority of ${size}; closure uniqueness would not hold`);
  }
}

interface EncodedVote {
  readonly voter: ReplicaId;
  readonly signature: string;
}

function encodeVotes(votes: readonly ClosureVote[]): Uint8Array {
  const encoded: EncodedVote[] = votes
    .map((vote) => ({ voter: vote.voter, signature: bytesCodec.encode(vote.signature) as string }))
    .sort((a, b) => compareStrings(a.voter, b.voter));
  return utf8Encode(JSON.stringify(encoded));
}

export function decodeQuorumVotes(certificate: Uint8Array): readonly { voter: ReplicaId; signature: Uint8Array }[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(utf8Decode(certificate));
  } catch {
    throw new TypeError("quorum certificate is not JSON");
  }
  const list = expectArray(parsed as JsonValue, "quorum votes");
  return list.map((item) => {
    const record = expectRecord(item, "quorum vote");
    return {
      voter: expectString(record.voter, "quorum vote.voter"),
      signature: bytesCodec.decode(record.signature ?? null),
    };
  });
}

export function createQuorumFinalizer<C>(roster: QuorumRoster): Finalizer<C> {
  assertQuorumRoster(roster);
  return {
    verify(certificate) {
      let votes: readonly { voter: ReplicaId; signature: Uint8Array }[];
      try {
        votes = decodeQuorumVotes(certificate.certificate);
      } catch {
        return false;
      }
      const message = closureMessage(certificate);
      const accepted = new Set<ReplicaId>();
      for (const vote of votes) {
        if (accepted.has(vote.voter)) continue;
        const verifier = roster.verifiers.get(vote.voter);
        if (verifier === undefined) continue;
        if (verifier.verify(message, vote.signature)) accepted.add(vote.voter);
      }
      return accepted.size >= roster.threshold;
    },
  };
}

export interface Voter<C> {
  vote(tick: Tick, parentDecisionHash: Hash, commands: readonly Envelope<C>[]): ClosureVote;
}

export function createVoter<C>(options: {
  readonly voter: ReplicaId;
  readonly signer: Signer;
  readonly order: CommandOrder<C>;
  readonly hasher: Hasher;
}): Voter<C> {
  return {
    vote(tick, parentDecisionHash, commands) {
      const orderedCommandIds = sortCommands(commands, options.order).map((e) => e.id);
      const orderedCommandsHash = hashValue(options.hasher, orderedCommandIds);
      return {
        voter: options.voter,
        tick,
        parentDecisionHash,
        orderedCommandIds,
        orderedCommandsHash,
        signature: options.signer.sign(closureMessage({ tick, parentDecisionHash, orderedCommandsHash })),
      };
    },
  };
}

/**
 * Assemble a certificate from vote knowledge, or `undefined` when no
 * candidate payload has reached the threshold yet. With a majority
 * threshold at most one candidate can ever qualify.
 */
export function assembleQuorumCertificate(
  votes: VoteState,
  tick: Tick,
  roster: QuorumRoster,
): ClosureCertificate | undefined {
  assertQuorumRoster(roster);
  const tally = tallyVotes(votes, tick, new Set(roster.verifiers.keys()));
  const qualifying = [...tally.candidates.entries()].filter(([, list]) => list.length >= roster.threshold);
  if (qualifying.length === 0) return undefined;
  if (qualifying.length > 1) {
    throw new Error("quorum invariant violated: two candidates reached a majority threshold");
  }
  const list = qualifying[0]![1];
  const sample = list[0]!;
  return {
    tick: sample.tick,
    parentDecisionHash: sample.parentDecisionHash,
    orderedCommandIds: sample.orderedCommandIds,
    orderedCommandsHash: sample.orderedCommandsHash,
    certificate: encodeVotes(list),
  };
}
