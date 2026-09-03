/**
 * Runtime replica: a replicated domain object plus an outbox and a durable
 * checkpoint store. `AuthorityReplica` additionally closes ticks.
 */
import type { JsonValue } from "../core/canonical.ts";
import type { Envelope, ReplicaId, Tick } from "../core/ids.ts";
import type { ClosureAuthority } from "../finalizer/single-authority.ts";
import type { ClosureCertificate } from "../prdt/closure.ts";
import { proposalsForTick } from "../prdt/proposal-state.ts";
import {
  ReplicatedDomain,
  type Decision,
  type Delta,
  type ReplicatedDomainProtocol,
} from "../prdt/replicated-domain.ts";
import type { CheckpointStore } from "./checkpoint.ts";

export class Replica<S, C, E, R> {
  readonly id: ReplicaId;
  readonly protocol: ReplicatedDomainProtocol<S, C, E, R>;
  readonly store: CheckpointStore;
  #object: ReplicatedDomain<S, C, E, R>;
  #outbox: Delta<C>[] = [];

  constructor(protocol: ReplicatedDomainProtocol<S, C, E, R>, id: ReplicaId, store: CheckpointStore) {
    this.protocol = protocol;
    this.id = id;
    this.store = store;
    this.#object = Replica.#load(protocol, id, store);
  }

  static #load<S, C, E, R>(
    protocol: ReplicatedDomainProtocol<S, C, E, R>,
    id: ReplicaId,
    store: CheckpointStore,
  ): ReplicatedDomain<S, C, E, R> {
    const persisted = store.load();
    return persisted === undefined ? new ReplicatedDomain(protocol, id) : ReplicatedDomain.restore(protocol, persisted);
  }

  get object(): ReplicatedDomain<S, C, E, R> {
    return this.#object;
  }

  propose(tick: Tick, command: C): Envelope<C> {
    const { envelope, delta } = this.#object.propose({ tick, command });
    this.checkpoint(); // write-ahead: own proposals are durable before they leave
    this.enqueue(delta);
    return envelope;
  }

  receive(delta: Delta<C>): void {
    this.#object.merge(delta);
  }

  /** Full knowledge for anti-entropy. */
  fullDelta(): Delta<C> {
    return this.#object.delta();
  }

  protected enqueue(delta: Delta<C>): void {
    this.#outbox.push(delta);
  }

  drainOutbox(): Delta<C>[] {
    const out = this.#outbox;
    this.#outbox = [];
    return out;
  }

  decision(): Decision<E, R> {
    return this.#object.decision();
  }

  domainState(): S {
    return this.#object.domainState();
  }

  nextTick(): Tick {
    return this.#object.nextTick();
  }

  stateHash(): string {
    return this.#object.stateHash();
  }

  checkpoint(): JsonValue {
    const snapshot = this.#object.snapshot();
    this.store.save(snapshot);
    return snapshot;
  }

  /** Simulate a crash: drop in-memory state and the outbox, reload the last checkpoint. */
  restart(): void {
    this.#object = Replica.#load(this.protocol, this.id, this.store);
    this.#outbox = [];
  }
}

export class AuthorityReplica<S, C, E, R> extends Replica<S, C, E, R> {
  readonly authority: ClosureAuthority<C>;

  constructor(
    protocol: ReplicatedDomainProtocol<S, C, E, R>,
    id: ReplicaId,
    store: CheckpointStore,
    authority: ClosureAuthority<C>,
  ) {
    super(protocol, id, store);
    this.authority = authority;
  }

  /** Close the next tick with every proposal currently known for it. */
  closeNextTick(): ClosureCertificate {
    const tick = this.nextTick();
    const known = [...proposalsForTick(this.object.state.proposals, tick).values()];
    const certificate = this.authority.close(tick, this.decision().headDecisionHash, known);
    this.object.closeTick(certificate);
    this.checkpoint(); // certificates are durable before they leave
    this.enqueue({ proposals: [], closures: [certificate] });
    return certificate;
  }
}
