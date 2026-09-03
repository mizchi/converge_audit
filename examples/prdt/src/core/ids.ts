/**
 * Shared identifiers for the replicated domain framework.
 *
 * The core is environment independent: no wall clock, randomness, or I/O is
 * referenced from this layer.
 */

export type ReplicaId = string;
export type CommandId = string;
export type Tick = number;
export type Hash = string;

/** A command as submitted by one replica. */
export interface Envelope<C> {
  readonly id: CommandId;
  readonly tick: Tick;
  readonly submittedBy: ReplicaId;
  readonly localSequence: number;
  readonly command: C;
}

/**
 * MVP command identifier: globally unique as long as each replica id is
 * unique and each replica increments `localSequence` monotonically.
 */
export function commandId(replicaId: ReplicaId, localSequence: number): CommandId {
  if (!Number.isInteger(localSequence) || localSequence < 0) {
    throw new RangeError(`localSequence must be a non-negative integer: ${localSequence}`);
  }
  return `${replicaId}:${localSequence}`;
}

export function isTick(value: unknown): value is Tick {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}
