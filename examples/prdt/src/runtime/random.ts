/** Deterministic PRNG (mulberry32) so simulations are reproducible by seed. */
export interface Rng {
  next(): number;
  int(maxExclusive: number): number;
  pick<T>(items: readonly T[]): T;
  chance(probability: number): boolean;
  shuffle<T>(items: readonly T[]): T[];
}

export function createRng(seed: number): Rng {
  let a = seed >>> 0;
  const next = (): number => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const int = (maxExclusive: number): number => {
    if (maxExclusive <= 0) throw new RangeError("maxExclusive must be positive");
    return Math.floor(next() * maxExclusive);
  };
  return {
    next,
    int,
    pick: (items) => {
      if (items.length === 0) throw new RangeError("cannot pick from empty list");
      return items[int(items.length)]!;
    },
    chance: (probability) => next() < probability,
    shuffle: (items) => {
      const out = [...items];
      for (let i = out.length - 1; i > 0; i -= 1) {
        const j = int(i + 1);
        [out[i], out[j]] = [out[j]!, out[i]!];
      }
      return out;
    },
  };
}
