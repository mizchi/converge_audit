import type { Envelope } from "./ids.ts";

export type Verdict<E, R> =
  | { readonly status: "Accepted"; readonly event: E }
  | { readonly status: "Rejected"; readonly reason: R };

/** Immutable once produced by batch resolution. */
export interface ResolvedCommand<C, E, R> {
  readonly envelope: Envelope<C>;
  readonly verdict: Verdict<E, R>;
}
