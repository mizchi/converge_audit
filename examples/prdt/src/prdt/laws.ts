/**
 * Executable statements of the properties the framework claims. Tests drive
 * these with property-based generators; they are exported so downstream
 * domains can reuse them against their own replicated objects.
 */
import { canonicalize } from "../core/canonical.ts";
import { lessOrEqual, type JoinSemilattice } from "../core/lattice.ts";
import type { CommittedLog } from "./committed-log.ts";
import { isPrefixOf } from "./committed-log.ts";
import type { CommandDecision, Decision } from "./replicated-domain.ts";

export interface LatticeLawViolation {
  readonly law: "idempotent" | "commutative" | "associative";
}

export function latticeLawViolations<S>(
  lattice: JoinSemilattice<S>,
  a: S,
  b: S,
  c: S,
): LatticeLawViolation[] {
  const out: LatticeLawViolation[] = [];
  if (!lattice.equals(lattice.merge(a, a), a)) out.push({ law: "idempotent" });
  if (!lattice.equals(lattice.merge(a, b), lattice.merge(b, a))) out.push({ law: "commutative" });
  if (!lattice.equals(lattice.merge(lattice.merge(a, b), c), lattice.merge(a, lattice.merge(b, c)))) {
    out.push({ law: "associative" });
  }
  return out;
}

/** Decision order: Pending <= anything; a final decision is only <= itself. */
export function commandDecisionLessOrEqual<E, R>(a: CommandDecision<E, R>, b: CommandDecision<E, R>): boolean {
  if (a.status === "Pending") return true;
  return canonicalize(a) === canonicalize(b);
}

/**
 * `decision(state) <= decision(merge(state, delta))`: no command ever moves
 * away from a final verdict, and the committed prefix only grows.
 */
export function decisionLessOrEqual<E, R>(a: Decision<E, R>, b: Decision<E, R>): boolean {
  for (const [id, before] of a.commands) {
    const after = b.commands.get(id);
    if (after === undefined) return false;
    if (!commandDecisionLessOrEqual(before, after)) return false;
  }
  if (a.committedTicks.length > b.committedTicks.length) return false;
  for (let i = 0; i < a.committedTicks.length; i += 1) {
    if (a.committedTicks[i] !== b.committedTicks[i]) return false;
  }
  return true;
}

export function logsArePrefixCompatible<R>(a: CommittedLog<R>, b: CommittedLog<R>): boolean {
  return isPrefixOf(a, b) || isPrefixOf(b, a);
}

export { lessOrEqual };
