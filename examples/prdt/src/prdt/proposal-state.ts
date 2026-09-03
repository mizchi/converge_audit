/**
 * Proposal knowledge: everything a replica has heard about submitted
 * commands, grouped by tick. This is a grow-only map of grow-only maps.
 *
 * Merge rules:
 * - outer map: joined per tick
 * - inner map: set union keyed by command id
 * - the same command id with a different payload is a protocol error; neither
 *   payload is adopted implicitly
 * - nothing is ever overwritten or removed
 */
import { canonicalize, compareNumbers, compareStrings } from "../core/canonical.ts";
import type { CommandId, Envelope, Tick } from "../core/ids.ts";
import { mapLattice, type JoinSemilattice } from "../core/lattice.ts";
import { ProtocolError } from "./errors.ts";

export interface ProposalState<C> {
  readonly byTick: ReadonlyMap<Tick, ReadonlyMap<CommandId, Envelope<C>>>;
}

const EMPTY_TICK: ReadonlyMap<CommandId, never> = new Map<CommandId, never>();

export function emptyProposals<C>(): ProposalState<C> {
  return { byTick: new Map() };
}

export function envelopeEquals<C>(left: Envelope<C>, right: Envelope<C>): boolean {
  return left === right || canonicalize(left) === canonicalize(right);
}

function envelopeLattice<C>(): JoinSemilattice<Envelope<C>> {
  return {
    merge(left, right) {
      if (left.id !== right.id) {
        throw new ProtocolError("ConflictingProposal", "envelope ids differ", { left: left.id, right: right.id });
      }
      if (!envelopeEquals(left, right)) {
        throw new ProtocolError("ConflictingProposal", `two payloads for command ${left.id}`, {
          commandId: left.id,
          left: canonicalize(left),
          right: canonicalize(right),
        });
      }
      return left;
    },
    equals: envelopeEquals,
  };
}

export function proposalLattice<C>(): JoinSemilattice<ProposalState<C>> {
  const inner = mapLattice<Tick, ReadonlyMap<CommandId, Envelope<C>>>(
    mapLattice<CommandId, Envelope<C>>(envelopeLattice<C>()),
  );
  return {
    merge: (left, right) => ({ byTick: inner.merge(left.byTick, right.byTick) }),
    equals: (left, right) => inner.equals(left.byTick, right.byTick),
  };
}

export function singletonProposal<C>(envelope: Envelope<C>): ProposalState<C> {
  return { byTick: new Map([[envelope.tick, new Map([[envelope.id, envelope]])]]) };
}

export function addProposal<C>(state: ProposalState<C>, envelope: Envelope<C>): ProposalState<C> {
  return proposalLattice<C>().merge(state, singletonProposal(envelope));
}

export function proposalsForTick<C>(
  state: ProposalState<C>,
  tick: Tick,
): ReadonlyMap<CommandId, Envelope<C>> {
  return state.byTick.get(tick) ?? EMPTY_TICK;
}

/** Every known envelope in a deterministic order (tick, then command id). */
export function listProposals<C>(state: ProposalState<C>): Envelope<C>[] {
  const ticks = [...state.byTick.keys()].sort(compareNumbers);
  const out: Envelope<C>[] = [];
  for (const tick of ticks) {
    const ids = [...state.byTick.get(tick)!.keys()].sort(compareStrings);
    for (const id of ids) out.push(state.byTick.get(tick)!.get(id)!);
  }
  return out;
}

export function countProposals<C>(state: ProposalState<C>): number {
  let count = 0;
  for (const tick of state.byTick.values()) count += tick.size;
  return count;
}
