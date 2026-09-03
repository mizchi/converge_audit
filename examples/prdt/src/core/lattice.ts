/**
 * Join-semilattices.
 *
 * Every replicated state in the framework is a join-semilattice: `merge` is
 * idempotent, commutative, and associative. Some merges reject inputs that
 * can never be joined (for example two different payloads for one command
 * id); those throw a `ProtocolError` and leave both inputs untouched.
 */

export interface JoinSemilattice<S> {
  merge(left: S, right: S): S;
  equals(left: S, right: S): boolean;
}

/** `a <= b` in the lattice order iff `merge(a, b) == b`. */
export function lessOrEqual<S>(lattice: JoinSemilattice<S>, a: S, b: S): boolean {
  return lattice.equals(lattice.merge(a, b), b);
}

/** Point-wise join of maps; keys are unioned and values joined. */
export function mapLattice<K, V>(value: JoinSemilattice<V>): JoinSemilattice<ReadonlyMap<K, V>> {
  return {
    merge(left, right) {
      const out = new Map<K, V>(left);
      for (const [key, rightValue] of right) {
        const leftValue = out.get(key);
        out.set(key, leftValue === undefined ? rightValue : value.merge(leftValue, rightValue));
      }
      return out;
    },
    equals(left, right) {
      if (left.size !== right.size) return false;
      for (const [key, leftValue] of left) {
        const rightValue = right.get(key);
        if (rightValue === undefined || !value.equals(leftValue, rightValue)) return false;
      }
      return true;
    },
  };
}

/** Grow-only set. */
export function setLattice<T>(): JoinSemilattice<ReadonlySet<T>> {
  return {
    merge(left, right) {
      const out = new Set<T>(left);
      for (const item of right) out.add(item);
      return out;
    },
    equals(left, right) {
      if (left.size !== right.size) return false;
      for (const item of left) if (!right.has(item)) return false;
      return true;
    },
  };
}
