/**
 * fast-check generators shared by the property tests. A "scenario" is a
 * fully specified run of the MMO protocol: proposals from several replicas
 * over several ticks and a certificate per tick closing a subset of the
 * proposals known at that point. The scenario is expressed as a list of
 * deltas so tests can apply them in any order, duplicated, or partially.
 */
import fc from "fast-check";
import type { Envelope } from "../../src/core/ids.ts";
import type { GameCommand } from "../../src/examples/mmo/commands.ts";
import { worldWith, type World } from "../../src/examples/mmo/model.ts";
import type { GameProtocol, GameState } from "../../src/examples/mmo/scenario.ts";
import type { ClosureAuthority } from "../../src/finalizer/single-authority.ts";
import type { ClosureCertificate } from "../../src/prdt/closure.ts";
import { ReplicatedDomain, type Delta } from "../../src/prdt/replicated-domain.ts";
import { singleAuthoritySetup } from "../helpers.ts";

export const PLAYERS = ["p1", "p2", "p3"] as const;

export const arbitraryWorld: fc.Arbitrary<World> = fc
  .tuple(
    ...PLAYERS.map(() => fc.record({ hp: fc.integer({ min: 0, max: 40 }), maxHp: fc.constant(40), mp: fc.integer({ min: 0, max: 100 }) })),
  )
  .map((players) => worldWith(Object.fromEntries(PLAYERS.map((id, i) => [id, players[i]!]))));

export const arbitraryCommand: fc.Arbitrary<GameCommand> = fc.oneof(
  fc.record({
    type: fc.constant("Damage" as const),
    source: fc.constantFrom(...PLAYERS, "monster"),
    target: fc.constantFrom(...PLAYERS, "ghost"),
    amount: fc.integer({ min: -1, max: 45 }),
  }),
  fc.record({
    type: fc.constant("UseSkill" as const),
    actor: fc.constantFrom(...PLAYERS, "ghost"),
    skill: fc.constantFrom("fireball", "heal", "dash"),
    mpCost: fc.integer({ min: -1, max: 60 }),
  }),
);

export interface Scenario {
  readonly protocol: GameProtocol;
  readonly authority: ClosureAuthority<GameCommand>;
  readonly world: World;
  readonly envelopes: readonly Envelope<GameCommand>[];
  readonly certificates: readonly ClosureCertificate[];
  /** One delta per proposal plus one per certificate, in a valid causal order. */
  readonly deltas: readonly Delta<GameCommand>[];
  /** The state after every delta has been applied. */
  readonly full: GameState;
}

interface ScenarioSpec {
  readonly world: World;
  readonly ticks: readonly {
    readonly commands: readonly { readonly replica: number; readonly command: GameCommand; readonly late: boolean }[];
  }[];
  readonly replicaCount: number;
}

const arbitrarySpec: fc.Arbitrary<ScenarioSpec> = fc
  .tuple(
    arbitraryWorld,
    fc.integer({ min: 1, max: 3 }),
    fc.array(
      fc.record({
        commands: fc.array(
          fc.record({ replica: fc.integer({ min: 0, max: 2 }), command: arbitraryCommand, late: fc.boolean() }),
          { minLength: 0, maxLength: 4 },
        ),
      }),
      { minLength: 1, maxLength: 4 },
    ),
  )
  .map(([world, replicaCount, ticks]) => ({
    world,
    replicaCount,
    ticks: ticks.map((t) => ({ commands: t.commands.map((c) => ({ ...c, replica: c.replica % replicaCount })) })),
  }));

export function buildScenario(spec: ScenarioSpec): Scenario {
  const { protocol, authority } = singleAuthoritySetup({ initialWorld: spec.world });
  const replicas = Array.from({ length: spec.replicaCount }, (_, i) => new ReplicatedDomain(protocol, `r${i}`));
  const envelopes: Envelope<GameCommand>[] = [];
  const certificates: ClosureCertificate[] = [];
  const deltas: Delta<GameCommand>[] = [];
  const auth = new ReplicatedDomain(protocol, "authority");
  spec.ticks.forEach((tickSpec, tick) => {
    const included: Envelope<GameCommand>[] = [];
    for (const c of tickSpec.commands) {
      const { envelope, delta } = replicas[c.replica]!.propose({ tick, command: c.command });
      envelopes.push(envelope);
      deltas.push(delta);
      if (!c.late) {
        included.push(envelope);
        auth.merge(delta);
      }
    }
    const certificate = authority.close(tick, auth.decision().headDecisionHash, included);
    auth.closeTick(certificate);
    certificates.push(certificate);
    deltas.push({ proposals: [], closures: [certificate] });
    // Late ones reach the authority after closure.
    for (const c of tickSpec.commands) if (c.late) auth.merge({ proposals: [envelopes.find((e) => e.submittedBy === `r${c.replica}` && e.tick === tick && e.command === c.command)!], closures: [] });
  });
  let full = protocol.initial();
  for (const delta of deltas) full = protocol.applyDelta(full, delta);
  return { protocol, authority, world: spec.world, envelopes, certificates, deltas, full };
}

export const arbitraryScenario: fc.Arbitrary<Scenario> = arbitrarySpec.map(buildScenario);

/** A state reached by applying some subset of a scenario's deltas, in some order. */
export function arbitraryReachable(scenario: Scenario): fc.Arbitrary<{ state: GameState; applied: readonly Delta<GameCommand>[] }> {
  return fc.subarray(scenario.deltas as Delta<GameCommand>[]).chain((subset) =>
    fc.shuffledSubarray(subset, { minLength: subset.length, maxLength: subset.length }).map((ordered) => {
      let state = scenario.protocol.initial();
      for (const delta of ordered) state = scenario.protocol.applyDelta(state, delta);
      return { state, applied: ordered };
    }),
  );
}
