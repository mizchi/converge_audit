/**
 * Domain layer.
 *
 * A `Domain` is a pure, deterministic state machine. It must not read the
 * wall clock, randomness, the network, or global mutable state, and `apply`
 * must not mutate its input. Any randomness a rule needs must arrive inside
 * the command (a seed or the drawn value).
 *
 * The domain never sees replication. Validation runs against the state
 * immediately before the command in the finalized order, which is why
 * non-monotonic predicates such as `hp > 0` are safe here and unsafe as
 * proposal-time PRDT preconditions.
 */

export interface Accepted<E> {
  readonly accepted: true;
  readonly event: E;
}

export interface Rejected<R> {
  readonly accepted: false;
  readonly reason: R;
}

export type Validation<E, R> = Accepted<E> | Rejected<R>;

export interface Domain<S, C, E, R> {
  initialState(): S;
  validate(state: S, command: C): Validation<E, R>;
  apply(state: S, event: E): S;
}

export function accept<E>(event: E): Accepted<E> {
  return { accepted: true, event };
}

export function reject<R>(reason: R): Rejected<R> {
  return { accepted: false, reason };
}
