/**
 * Canonical command ordering.
 *
 * The order inside a tick is a domain design decision, not a physical truth.
 * Every order used by the framework must be total; `commandId` is always the
 * final tie breaker so that two distinct envelopes never compare equal.
 */
import { compareNumbers, compareStrings } from "./canonical.ts";
import type { Envelope } from "./ids.ts";

export interface CommandOrder<C> {
  compare(a: Envelope<C>, b: Envelope<C>): number;
}

export function composeOrder<C>(...parts: readonly CommandOrder<C>[]): CommandOrder<C> {
  return {
    compare(a, b) {
      for (const part of parts) {
        const result = part.compare(a, b);
        if (result !== 0) return result;
      }
      return 0;
    },
  };
}

export const byTick: CommandOrder<unknown> = {
  compare: (a, b) => compareNumbers(a.tick, b.tick),
};

export const bySubmitter: CommandOrder<unknown> = {
  compare: (a, b) => compareStrings(a.submittedBy, b.submittedBy),
};

export const byLocalSequence: CommandOrder<unknown> = {
  compare: (a, b) => compareNumbers(a.localSequence, b.localSequence),
};

export const byCommandId: CommandOrder<unknown> = {
  compare: (a, b) => compareStrings(a.id, b.id),
};

export function byPhase<C>(phase: (command: C) => number): CommandOrder<C> {
  return { compare: (a, b) => compareNumbers(phase(a.command), phase(b.command)) };
}

/**
 * MVP canonical order: (tick, phase, submittedBy, localSequence, commandId).
 */
export function canonicalOrder<C>(phase: (command: C) => number): CommandOrder<C> {
  return composeOrder<C>(byTick, byPhase(phase), bySubmitter, byLocalSequence, byCommandId);
}

/** Returns a sorted copy. The input array is never mutated. */
export function sortCommands<C>(
  commands: readonly Envelope<C>[],
  order: CommandOrder<C>,
): Envelope<C>[] {
  const copy = [...commands];
  copy.sort((a, b) => order.compare(a, b));
  return copy;
}
