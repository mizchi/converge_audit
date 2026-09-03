/**
 * Finalization layer: resolves one tick's command set into verdicts.
 *
 * `resolveBatch` is deterministic in the *set* of commands: the input array
 * is copied and sorted by the canonical order before validation, so any
 * permutation of the same commands produces the same result.
 */
import type { CommandId, Envelope, Hash, Tick } from "../core/ids.ts";
import { sortCommands, type CommandOrder } from "../core/order.ts";
import type { ResolvedCommand, Verdict } from "../core/verdict.ts";
import type { Domain } from "./domain.ts";

export interface ResolvedBatch<S, C, E, R> {
  readonly tick: Tick;
  readonly previousStateHash: Hash;
  readonly orderedCommandHash: Hash;
  readonly results: readonly ResolvedCommand<C, E, R>[];
  readonly resultingState: S;
  readonly resultingStateHash: Hash;
}

export interface BatchHashing<S> {
  hashState(state: S): Hash;
  hashCommandIds(ids: readonly CommandId[]): Hash;
}

export class BatchTickMismatchError extends Error {
  constructor(
    readonly expectedTick: Tick,
    readonly envelopeTick: Tick,
    readonly commandId: CommandId,
  ) {
    super(`command ${commandId} is for tick ${envelopeTick}, batch is tick ${expectedTick}`);
    this.name = "BatchTickMismatchError";
  }
}

export function resolveBatch<S, C, E, R>(
  tick: Tick,
  previousState: S,
  commands: readonly Envelope<C>[],
  domain: Domain<S, C, E, R>,
  order: CommandOrder<C>,
  hashing: BatchHashing<S>,
): ResolvedBatch<S, C, E, R> {
  for (const envelope of commands) {
    if (envelope.tick !== tick) throw new BatchTickMismatchError(tick, envelope.tick, envelope.id);
  }
  const ordered = sortCommands(commands, order);
  const seen = new Set<CommandId>();
  for (const envelope of ordered) {
    if (seen.has(envelope.id)) throw new Error(`duplicate command id in batch: ${envelope.id}`);
    seen.add(envelope.id);
  }

  let state = previousState;
  const results: ResolvedCommand<C, E, R>[] = [];
  for (const envelope of ordered) {
    const validation = domain.validate(state, envelope.command);
    let verdict: Verdict<E, R>;
    if (validation.accepted) {
      state = domain.apply(state, validation.event);
      verdict = { status: "Accepted", event: validation.event };
    } else {
      verdict = { status: "Rejected", reason: validation.reason };
    }
    results.push({ envelope, verdict });
  }

  return {
    tick,
    previousStateHash: hashing.hashState(previousState),
    orderedCommandHash: hashing.hashCommandIds(ordered.map((e) => e.id)),
    results,
    resultingState: state,
    resultingStateHash: hashing.hashState(state),
  };
}
