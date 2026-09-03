/**
 * Environment-independent host for a single-authority replica behind an
 * async snapshot store (Durable Object storage, SQLite, a file, ...).
 *
 * Every mutating call persists the snapshot before it resolves, so a caller
 * that awaits the result can rely on the proposal or certificate being
 * durable before it is disseminated further.
 */
import type { JsonValue } from "../../core/canonical.ts";
import type { CommandId, Envelope, ReplicaId, Tick } from "../../core/ids.ts";
import type { ClosureAuthority } from "../../finalizer/single-authority.ts";
import type { ClosureCertificate } from "../../prdt/closure.ts";
import type {
  CommandDecision,
  Decision,
  Delta,
  ReplicatedDomainProtocol,
} from "../../prdt/replicated-domain.ts";
import type { CheckpointStore } from "../checkpoint.ts";
import { AuthorityReplica } from "../replica.ts";

export interface SnapshotStorage {
  load(): Promise<JsonValue | undefined>;
  save(snapshot: JsonValue): Promise<void>;
}

class WriteThroughStore implements CheckpointStore {
  latest: JsonValue | undefined;
  dirty = false;

  constructor(initial: JsonValue | undefined) {
    this.latest = initial;
  }

  load(): JsonValue | undefined {
    return this.latest;
  }

  save(snapshot: JsonValue): void {
    this.latest = snapshot;
    this.dirty = true;
  }
}

export class AuthorityHost<S, C, E, R> {
  readonly replica: AuthorityReplica<S, C, E, R>;
  readonly #storage: SnapshotStorage;
  readonly #store: WriteThroughStore;

  private constructor(replica: AuthorityReplica<S, C, E, R>, storage: SnapshotStorage, store: WriteThroughStore) {
    this.replica = replica;
    this.#storage = storage;
    this.#store = store;
  }

  static async open<S, C, E, R>(options: {
    readonly protocol: ReplicatedDomainProtocol<S, C, E, R>;
    readonly authority: ClosureAuthority<C>;
    readonly storage: SnapshotStorage;
    readonly replicaId: ReplicaId;
  }): Promise<AuthorityHost<S, C, E, R>> {
    const store = new WriteThroughStore(await options.storage.load());
    const replica = new AuthorityReplica(options.protocol, options.replicaId, store, options.authority);
    return new AuthorityHost(replica, options.storage, store);
  }

  get protocol(): ReplicatedDomainProtocol<S, C, E, R> {
    return this.replica.protocol;
  }

  async #flush(): Promise<void> {
    if (!this.#store.dirty) return;
    await this.#storage.save(this.#store.latest!);
    this.#store.dirty = false;
  }

  async propose(input: { tick: Tick; command: C }): Promise<Envelope<C>> {
    const envelope = this.replica.propose(input.tick, input.command);
    await this.#flush();
    return envelope;
  }

  async merge(delta: Delta<C>): Promise<void> {
    this.replica.receive(delta);
    this.replica.checkpoint();
    await this.#flush();
  }

  async closeNextTick(): Promise<ClosureCertificate> {
    const certificate = this.replica.closeNextTick();
    await this.#flush();
    return certificate;
  }

  delta(): Delta<C> {
    this.replica.drainOutbox();
    return this.replica.fullDelta();
  }

  decision(): Decision<E, R> {
    return this.replica.decision();
  }

  commandDecision(id: CommandId): CommandDecision<E, R> {
    return this.replica.decision().commands.get(id) ?? { status: "Pending" };
  }

  domainState(): S {
    return this.replica.domainState();
  }

  nextTick(): Tick {
    return this.replica.nextTick();
  }
}

export function decisionToJson<S, C, E, R>(
  protocol: ReplicatedDomainProtocol<S, C, E, R>,
  decision: Decision<E, R>,
): JsonValue {
  const { event, reason } = protocol.config.codec;
  const commands: Record<string, JsonValue> = {};
  for (const [id, entry] of [...decision.commands.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    switch (entry.status) {
      case "Pending":
        commands[id] = { status: "Pending" };
        break;
      case "Accepted":
        commands[id] = { status: "Accepted", tick: entry.tick, event: event.encode(entry.event) };
        break;
      case "Rejected":
        commands[id] = { status: "Rejected", tick: entry.tick, reason: reason.encode(entry.reason) };
        break;
      case "RejectedLate":
        commands[id] = { status: "RejectedLate", closedTick: entry.closedTick };
        break;
    }
  }
  return { commands, committedTicks: decision.committedTicks, headDecisionHash: decision.headDecisionHash };
}
