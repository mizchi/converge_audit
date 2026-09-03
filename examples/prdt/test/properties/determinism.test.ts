import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { resolveBatch } from "../../src/domain/resolve-batch.ts";
import { createGameDomain } from "../../src/examples/mmo/domain.ts";
import { gameCommandOrder } from "../../src/examples/mmo/order.ts";
import type { Delta } from "../../src/prdt/replicated-domain.ts";
import type { GameCommand } from "../../src/examples/mmo/commands.ts";
import { arbitraryCommand, arbitraryScenario, arbitraryWorld, type Scenario } from "./arbitraries.ts";
import { singleAuthoritySetup } from "../helpers.ts";

const RUNS = { numRuns: 80 };

describe("determinism", () => {
  it("resolveBatch is invariant under permutation of its input", () => {
    const { protocol } = singleAuthoritySetup();
    fc.assert(
      fc.property(
        arbitraryWorld,
        fc.array(fc.tuple(fc.constantFrom("a", "b", "c"), fc.nat({ max: 5 }), arbitraryCommand), { maxLength: 8 }).map((items) => {
          const seen = new Set<string>();
          return items
            .map(([replica, seq, command]) => ({ id: `${replica}:${seq}`, tick: 0, submittedBy: replica, localSequence: seq, command }))
            .filter((e) => (seen.has(e.id) ? false : (seen.add(e.id), true)));
        }),
        (world, commands) => {
          const domain = createGameDomain(world);
          const base = resolveBatch(0, world, commands, domain, gameCommandOrder, protocol.hashing);
          return fc.assert(
            fc.property(fc.shuffledSubarray(commands, { minLength: commands.length, maxLength: commands.length }), (permuted) => {
              const other = resolveBatch(0, world, permuted, domain, gameCommandOrder, protocol.hashing);
              expect(other).toEqual(base);
            }),
            { numRuns: 5 },
          );
        },
      ),
      RUNS,
    );
  });

  it("delta delivery order, duplication, and merge-tree shape do not change the converged state", () => {
    fc.assert(
      fc.property(
        arbitraryScenario.chain((s) => fc.tuple(fc.constant(s), deliverySchedule(s), deliverySchedule(s))),
        ([scenario, a, b]) => {
          const stateA = fold(scenario, a);
          const stateB = fold(scenario, b);
          expect(scenario.protocol.stateHash(stateA)).toBe(scenario.protocol.stateHash(stateB));
          expect(scenario.protocol.stateHash(stateA)).toBe(scenario.protocol.stateHash(scenario.full));
          expect(scenario.protocol.decision(stateA)).toEqual(scenario.protocol.decision(scenario.full));
          // Merge-tree shape: join two partial states instead of folding sequentially.
          const half = Math.floor(a.length / 2);
          const left = fold(scenario, a.slice(0, half));
          const right = fold(scenario, a.slice(half));
          expect(scenario.protocol.stateHash(scenario.protocol.lattice.merge(left, right))).toBe(scenario.protocol.stateHash(stateA));
        },
      ),
      RUNS,
    );
  });

  it("snapshot round trip preserves the state hash and decision", () => {
    fc.assert(
      fc.property(arbitraryScenario, (scenario) => {
        const json = JSON.parse(JSON.stringify(scenario.protocol.snapshot(scenario.full)));
        const restored = scenario.protocol.restore(json);
        expect(scenario.protocol.stateHash(restored)).toBe(scenario.protocol.stateHash(scenario.full));
        expect(scenario.protocol.decision(restored)).toEqual(scenario.protocol.decision(scenario.full));
        expect(scenario.protocol.lattice.equals(restored, scenario.full)).toBe(true);
      }),
      RUNS,
    );
  });
});

/** All deltas, shuffled, with random duplicates spliced in. */
function deliverySchedule(scenario: Scenario): fc.Arbitrary<readonly Delta<GameCommand>[]> {
  const all = scenario.deltas as Delta<GameCommand>[];
  return fc
    .tuple(fc.shuffledSubarray(all, { minLength: all.length, maxLength: all.length }), fc.subarray(all))
    .chain(([order, dupes]) => fc.shuffledSubarray([...order, ...dupes], { minLength: order.length + dupes.length, maxLength: order.length + dupes.length }));
}

function fold(scenario: Scenario, deltas: readonly Delta<GameCommand>[]) {
  let state = scenario.protocol.initial();
  for (const delta of deltas) state = scenario.protocol.applyDelta(state, delta);
  return state;
}
