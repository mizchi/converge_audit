import { describe, expect, it } from "vitest";
import { sha256Hasher } from "../../src/core/hash.ts";
import type { GameCommand } from "../../src/examples/mmo/commands.ts";
import { worldWith } from "../../src/examples/mmo/model.ts";
import { gameCommandOrder } from "../../src/examples/mmo/order.ts";
import { gameProtocol } from "../../src/examples/mmo/scenario.ts";
import { sharedSecretAuthenticator } from "../../src/finalizer/finalizer.ts";
import { createSingleAuthority, createSingleAuthorityFinalizer } from "../../src/finalizer/single-authority.ts";
import { runSimulation, type SimulationReport } from "../../src/runtime/simulator.ts";

const PLAYERS = ["player-a", "player-b", "player-c"];

function simulate(seed: number, steps = 400): SimulationReport {
  const authenticator = sharedSecretAuthenticator("sim");
  const protocol = gameProtocol({
    finalizer: createSingleAuthorityFinalizer<GameCommand>(authenticator),
    initialWorld: worldWith(Object.fromEntries(PLAYERS.map((id) => [id, { hp: 25, maxHp: 25, mp: 80 }]))),
  });
  const authority = createSingleAuthority<GameCommand>({ signer: authenticator, order: gameCommandOrder, hasher: sha256Hasher });
  return runSimulation({
    protocol,
    authority,
    seed,
    steps,
    generateCommand: (rng): GameCommand =>
      rng.chance(0.5)
        ? { type: "Damage", source: rng.pick(PLAYERS), target: rng.pick(PLAYERS), amount: 1 + rng.int(15) }
        : { type: "UseSkill", actor: rng.pick(PLAYERS), skill: rng.pick(["fireball", "heal"]), mpCost: rng.int(30) },
  });
}

describe("three-replica simulation", () => {
  const seeds = Array.from({ length: 40 }, (_, i) => i + 1);

  it("converges after reorder, duplication, partition, and restart for every seed", () => {
    const reports = seeds.map((seed) => simulate(seed));
    for (const report of reports) {
      expect(report.protocolErrors, `seed ${report.seed}`).toEqual([]);
      expect(report.converged, `seed ${report.seed}: ${JSON.stringify(report)}`).toBe(true);
      expect(new Set(report.stateHashes).size).toBe(1);
      expect(new Set(report.headDecisionHashes).size).toBe(1);
      for (const ticks of report.committedTicks) expect(ticks).toEqual(report.committedTicks[0]);
    }
    // The adversarial actions actually fired across the corpus.
    const totals = reports.reduce(
      (acc, r) => {
        for (const key of Object.keys(acc) as (keyof typeof acc)[]) acc[key] += r.counters[key];
        return acc;
      },
      { partitions: 0, duplicates: 0, restarts: 0, closures: 0, lateCommands: 0 },
    );
    expect(totals.partitions).toBeGreaterThan(0);
    expect(totals.duplicates).toBeGreaterThan(0);
    expect(totals.restarts).toBeGreaterThan(0);
    expect(totals.closures).toBeGreaterThan(0);
    expect(totals.lateCommands).toBeGreaterThan(0);
  });

  it("is reproducible by seed", () => {
    expect(simulate(7)).toEqual(simulate(7));
  });
});
