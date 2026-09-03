import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { decisionLessOrEqual, logsArePrefixCompatible } from "../../src/prdt/laws.ts";
import { arbitraryReachable, arbitraryScenario } from "./arbitraries.ts";

const RUNS = { numRuns: 80 };

describe("decision safety", () => {
  it("decision monotonicity: decision(state) <= decision(applyDelta(state, delta))", () => {
    fc.assert(
      fc.property(
        arbitraryScenario.chain((s) => fc.tuple(fc.constant(s), arbitraryReachable(s), fc.constantFrom(...s.deltas))),
        ([scenario, reachable, delta]) => {
          const before = scenario.protocol.decision(reachable.state);
          const after = scenario.protocol.decision(scenario.protocol.applyDelta(reachable.state, delta));
          expect(decisionLessOrEqual(before, after)).toBe(true);
        },
      ),
      RUNS,
    );
  });

  it("decision monotonicity under whole-state join", () => {
    fc.assert(
      fc.property(
        arbitraryScenario.chain((s) => fc.tuple(fc.constant(s), arbitraryReachable(s), arbitraryReachable(s))),
        ([scenario, a, b]) => {
          const joined = scenario.protocol.lattice.merge(a.state, b.state);
          expect(decisionLessOrEqual(scenario.protocol.decision(a.state), scenario.protocol.decision(joined))).toBe(true);
          expect(decisionLessOrEqual(scenario.protocol.decision(b.state), scenario.protocol.decision(joined))).toBe(true);
        },
      ),
      RUNS,
    );
  });

  it("closure uniqueness: every reachable state agrees with the scenario's certificate per tick", () => {
    fc.assert(
      fc.property(arbitraryScenario.chain((s) => fc.tuple(fc.constant(s), arbitraryReachable(s))), ([scenario, reachable]) => {
        for (const [tick, decision] of reachable.state.closures) {
          if (decision.status !== "Closed") continue;
          const expected = scenario.certificates.find((c) => c.tick === tick);
          expect(decision.certificate.orderedCommandsHash).toBe(expected?.orderedCommandsHash);
        }
      }),
      RUNS,
    );
  });

  it("prefix safety: any two reachable committed logs are prefix compatible", () => {
    fc.assert(
      fc.property(
        arbitraryScenario.chain((s) => fc.tuple(fc.constant(s), arbitraryReachable(s), arbitraryReachable(s))),
        ([, a, b]) => {
          expect(logsArePrefixCompatible(a.state.committed, b.state.committed)).toBe(true);
        },
      ),
      RUNS,
    );
  });

  it("a late command is final: once RejectedLate it never becomes anything else", () => {
    fc.assert(
      fc.property(
        arbitraryScenario.chain((s) => fc.tuple(fc.constant(s), arbitraryReachable(s))),
        ([scenario, reachable]) => {
          const before = scenario.protocol.decision(reachable.state);
          const after = scenario.protocol.decision(scenario.full);
          for (const [id, decision] of before.commands) {
            if (decision.status === "RejectedLate") expect(after.commands.get(id)).toEqual(decision);
          }
        },
      ),
      RUNS,
    );
  });
});
