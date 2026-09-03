/**
 * Randomized distributed simulation.
 *
 * N replicas (replica 0 is the single authority) exchange deltas over an
 * adversarial in-memory network with delays, reordering, duplication,
 * partitions, and crash/restart from checkpoint. At the end the partition is
 * healed, every message is delivered, and anti-entropy runs until quiescence;
 * the report then states whether every replica converged.
 */
import type { Hash, ReplicaId, Tick } from "../core/ids.ts";
import type { ClosureAuthority } from "../finalizer/single-authority.ts";
import { ProtocolError } from "../prdt/errors.ts";
import type { ReplicatedDomainProtocol } from "../prdt/replicated-domain.ts";
import { InMemoryCheckpointStore } from "./checkpoint.ts";
import { createRng, type Rng } from "./random.ts";
import { AuthorityReplica, Replica } from "./replica.ts";
import { InMemoryNetwork } from "./transport.ts";

export interface SimulationOptions<S, C, E, R> {
  readonly protocol: ReplicatedDomainProtocol<S, C, E, R>;
  readonly authority: ClosureAuthority<C>;
  readonly generateCommand: (rng: Rng, tick: Tick) => C;
  readonly seed: number;
  readonly steps: number;
  readonly replicaCount?: number;
  /** How far ahead of the authority's next tick a replica may propose. */
  readonly tickHorizon?: number;
}

export interface SimulationCounters {
  proposals: number;
  deliveries: number;
  duplicates: number;
  partitions: number;
  heals: number;
  closures: number;
  restarts: number;
  checkpoints: number;
  antiEntropy: number;
  lateCommands: number;
}

export interface SimulationReport {
  readonly seed: number;
  readonly counters: SimulationCounters;
  readonly replicaIds: readonly ReplicaId[];
  readonly stateHashes: readonly Hash[];
  readonly committedTicks: readonly (readonly Tick[])[];
  readonly headDecisionHashes: readonly Hash[];
  readonly converged: boolean;
  readonly protocolErrors: readonly string[];
}

type Action = "propose" | "deliver" | "duplicate" | "partition" | "heal" | "close" | "restart" | "checkpoint" | "antiEntropy";

const WEIGHTS: readonly (readonly [Action, number])[] = [
  ["propose", 30],
  ["deliver", 40],
  ["duplicate", 6],
  ["partition", 3],
  ["heal", 4],
  ["close", 8],
  ["restart", 2],
  ["checkpoint", 4],
  ["antiEntropy", 5],
];

function pickAction(rng: Rng): Action {
  const total = WEIGHTS.reduce((sum, [, weight]) => sum + weight, 0);
  let roll = rng.int(total);
  for (const [action, weight] of WEIGHTS) {
    if (roll < weight) return action;
    roll -= weight;
  }
  return "deliver";
}

export function runSimulation<S, C, E, R>(options: SimulationOptions<S, C, E, R>): SimulationReport {
  const rng = createRng(options.seed);
  const replicaCount = options.replicaCount ?? 3;
  const horizon = options.tickHorizon ?? 2;
  const network = new InMemoryNetwork<C>();
  const ids: ReplicaId[] = Array.from({ length: replicaCount }, (_, i) => `r${i}`);
  const authority = new AuthorityReplica(options.protocol, ids[0]!, new InMemoryCheckpointStore(), options.authority);
  const replicas: Replica<S, C, E, R>[] = [
    authority,
    ...ids.slice(1).map((id) => new Replica(options.protocol, id, new InMemoryCheckpointStore())),
  ];
  const byId = new Map(replicas.map((r) => [r.id, r]));
  const counters: SimulationCounters = {
    proposals: 0, deliveries: 0, duplicates: 0, partitions: 0, heals: 0, closures: 0, restarts: 0, checkpoints: 0, antiEntropy: 0, lateCommands: 0,
  };
  const protocolErrors: string[] = [];

  const broadcast = (from: Replica<S, C, E, R>): void => {
    for (const delta of from.drainOutbox()) {
      for (const to of ids) if (to !== from.id) network.send(from.id, to, delta);
    }
  };

  const deliver = (): void => {
    const message = network.deliverOne(rng);
    if (message === undefined) return;
    counters.deliveries += 1;
    try {
      byId.get(message.to)!.receive(message.delta);
    } catch (error) {
      if (error instanceof ProtocolError) protocolErrors.push(`${message.to} <- ${message.from}: ${error.message}`);
      else throw error;
    }
  };

  for (let step = 0; step < options.steps; step += 1) {
    const action = pickAction(rng);
    switch (action) {
      case "propose": {
        const replica = rng.pick(replicas);
        const tick = authority.nextTick() + rng.int(horizon + 1);
        replica.propose(tick, options.generateCommand(rng, tick));
        counters.proposals += 1;
        broadcast(replica);
        break;
      }
      case "deliver":
        deliver();
        break;
      case "duplicate":
        if (network.duplicateOne(rng)) counters.duplicates += 1;
        break;
      case "partition": {
        if (network.partitioned || replicaCount < 2) break;
        const shuffled = rng.shuffle(ids);
        const cut = 1 + rng.int(replicaCount - 1);
        network.partition([shuffled.slice(0, cut), shuffled.slice(cut)]);
        counters.partitions += 1;
        break;
      }
      case "heal":
        if (network.partitioned) {
          network.heal();
          counters.heals += 1;
        }
        break;
      case "close":
        authority.closeNextTick();
        counters.closures += 1;
        broadcast(authority);
        break;
      case "restart": {
        const replica = rng.pick(replicas);
        replica.restart();
        counters.restarts += 1;
        break;
      }
      case "checkpoint": {
        rng.pick(replicas).checkpoint();
        counters.checkpoints += 1;
        break;
      }
      case "antiEntropy": {
        const from = rng.pick(replicas);
        const to = rng.pick(ids.filter((id) => id !== from.id));
        network.send(from.id, to, from.fullDelta());
        counters.antiEntropy += 1;
        break;
      }
    }
  }

  // Quiescence: heal, drain, then full anti-entropy rounds until nothing changes.
  network.heal();
  while (network.pending > 0) deliver();
  for (let round = 0; round < replicaCount + 1; round += 1) {
    for (const from of replicas) {
      broadcast(from);
      for (const to of ids) if (to !== from.id) network.send(from.id, to, from.fullDelta());
    }
    while (network.pending > 0) deliver();
  }

  for (const replica of replicas) {
    for (const decision of replica.decision().commands.values()) {
      if (decision.status === "RejectedLate") counters.lateCommands += 1;
    }
  }
  counters.lateCommands = Math.round(counters.lateCommands / replicaCount);

  const stateHashes = replicas.map((r) => r.stateHash());
  const committedTicks = replicas.map((r) => r.decision().committedTicks);
  const headDecisionHashes = replicas.map((r) => r.decision().headDecisionHash);
  const converged =
    protocolErrors.length === 0 &&
    stateHashes.every((h) => h === stateHashes[0]) &&
    headDecisionHashes.every((h) => h === headDecisionHashes[0]);

  return { seed: options.seed, counters, replicaIds: ids, stateHashes, committedTicks, headDecisionHashes, converged, protocolErrors };
}
