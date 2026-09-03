/**
 * Voting PRDT for quorum closure.
 *
 * Each (tick, voter) slot is a small lattice:
 *   Voted(v)  <=  Equivocated(S)   when v in S
 *   Voted(a) join Voted(b) = Voted(a)          if a == b
 *                          = Equivocated({a,b}) otherwise
 * An equivocating voter never counts toward a quorum. Because the slot
 * lattice is grow-only, vote knowledge converges regardless of delivery
 * order or duplication.
 */
import { canonicalize, compareStrings } from "../core/canonical.ts";
import type { CommandId, Hash, ReplicaId, Tick } from "../core/ids.ts";
import { mapLattice, type JoinSemilattice } from "../core/lattice.ts";

export interface ClosureVote {
  readonly voter: ReplicaId;
  readonly tick: Tick;
  readonly parentDecisionHash: Hash;
  readonly orderedCommandIds: readonly CommandId[];
  readonly orderedCommandsHash: Hash;
  readonly signature: Uint8Array;
}

export type VoterSlot =
  | { readonly status: "Voted"; readonly vote: ClosureVote }
  | { readonly status: "Equivocated"; readonly evidence: readonly ClosureVote[] };

export interface VoteState {
  readonly byTick: ReadonlyMap<Tick, ReadonlyMap<ReplicaId, VoterSlot>>;
}

export function emptyVotes(): VoteState {
  return { byTick: new Map() };
}

function voteEquals(a: ClosureVote, b: ClosureVote): boolean {
  return a === b || canonicalize(a) === canonicalize(b);
}

function evidenceUnion(votes: readonly ClosureVote[]): ClosureVote[] {
  const byCanonical = new Map<string, ClosureVote>();
  for (const vote of votes) byCanonical.set(canonicalize(vote), vote);
  return [...byCanonical.keys()].sort(compareStrings).map((key) => byCanonical.get(key)!);
}

export const voterSlotLattice: JoinSemilattice<VoterSlot> = {
  merge(left, right) {
    if (left.status === "Voted" && right.status === "Voted") {
      if (voteEquals(left.vote, right.vote)) return left;
      return { status: "Equivocated", evidence: evidenceUnion([left.vote, right.vote]) };
    }
    const leftVotes = left.status === "Voted" ? [left.vote] : left.evidence;
    const rightVotes = right.status === "Voted" ? [right.vote] : right.evidence;
    return { status: "Equivocated", evidence: evidenceUnion([...leftVotes, ...rightVotes]) };
  },
  equals(left, right) {
    if (left.status !== right.status) return false;
    if (left.status === "Voted" && right.status === "Voted") return voteEquals(left.vote, right.vote);
    if (left.status === "Equivocated" && right.status === "Equivocated") {
      return canonicalize(left.evidence) === canonicalize(right.evidence);
    }
    return false;
  },
};

export function voteLattice(): JoinSemilattice<VoteState> {
  const inner = mapLattice<Tick, ReadonlyMap<ReplicaId, VoterSlot>>(mapLattice<ReplicaId, VoterSlot>(voterSlotLattice));
  return {
    merge: (left, right) => ({ byTick: inner.merge(left.byTick, right.byTick) }),
    equals: (left, right) => inner.equals(left.byTick, right.byTick),
  };
}

export function addVote(state: VoteState, vote: ClosureVote): VoteState {
  return voteLattice().merge(state, {
    byTick: new Map([[vote.tick, new Map([[vote.voter, { status: "Voted", vote }]])]]),
  });
}

export interface VoteTally {
  /** Candidate closure payloads keyed by canonical payload, with the non-equivocating votes behind each. */
  readonly candidates: ReadonlyMap<string, readonly ClosureVote[]>;
  readonly equivocators: readonly ReplicaId[];
}

export function tallyVotes(state: VoteState, tick: Tick, roster: ReadonlySet<ReplicaId>): VoteTally {
  const slots = state.byTick.get(tick) ?? new Map<ReplicaId, VoterSlot>();
  const candidates = new Map<string, ClosureVote[]>();
  const equivocators: ReplicaId[] = [];
  for (const voter of [...slots.keys()].sort(compareStrings)) {
    if (!roster.has(voter)) continue;
    const slot = slots.get(voter)!;
    if (slot.status === "Equivocated") {
      equivocators.push(voter);
      continue;
    }
    const key = canonicalize({
      tick: slot.vote.tick,
      parentDecisionHash: slot.vote.parentDecisionHash,
      orderedCommandIds: slot.vote.orderedCommandIds,
      orderedCommandsHash: slot.vote.orderedCommandsHash,
    });
    const list = candidates.get(key) ?? [];
    list.push(slot.vote);
    candidates.set(key, list);
  }
  return { candidates, equivocators };
}
