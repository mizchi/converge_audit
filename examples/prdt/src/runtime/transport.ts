/**
 * Transport contracts and an adversarial in-memory network.
 *
 * The in-memory network can delay, reorder, duplicate, and partition. It
 * never corrupts a delta; authenticity is the finalizer's job, and payload
 * conflicts are the proposal lattice's job.
 */
import type { ReplicaId } from "../core/ids.ts";
import type { Delta } from "../prdt/replicated-domain.ts";
import type { Rng } from "./random.ts";

export interface Message<C> {
  readonly sequence: number;
  readonly from: ReplicaId;
  readonly to: ReplicaId;
  readonly delta: Delta<C>;
}

export interface Transport<C> {
  send(from: ReplicaId, to: ReplicaId, delta: Delta<C>): void;
}

export class InMemoryNetwork<C> implements Transport<C> {
  #queue: Message<C>[] = [];
  #sequence = 0;
  #groups: ReadonlyMap<ReplicaId, number> | undefined;

  send(from: ReplicaId, to: ReplicaId, delta: Delta<C>): void {
    this.#queue.push({ sequence: this.#sequence, from, to, delta });
    this.#sequence += 1;
  }

  get pending(): number {
    return this.#queue.length;
  }

  /** Messages that can currently cross the network (not cut by a partition). */
  #deliverable(): number[] {
    const out: number[] = [];
    for (let i = 0; i < this.#queue.length; i += 1) {
      const message = this.#queue[i]!;
      if (this.#groups === undefined || this.#groups.get(message.from) === this.#groups.get(message.to)) out.push(i);
    }
    return out;
  }

  get deliverable(): number {
    return this.#deliverable().length;
  }

  /** Remove and return one deliverable message: FIFO, or a random one when `rng` is given. */
  deliverOne(rng?: Rng): Message<C> | undefined {
    const candidates = this.#deliverable();
    if (candidates.length === 0) return undefined;
    const index = rng === undefined ? candidates[0]! : rng.pick(candidates);
    const [message] = this.#queue.splice(index, 1);
    return message;
  }

  /** Re-enqueue a copy of a random queued message (duplicate delivery). */
  duplicateOne(rng: Rng): boolean {
    if (this.#queue.length === 0) return false;
    const original = rng.pick(this.#queue);
    this.#queue.push({ ...original, sequence: this.#sequence });
    this.#sequence += 1;
    return true;
  }

  partition(groups: readonly (readonly ReplicaId[])[]): void {
    const map = new Map<ReplicaId, number>();
    groups.forEach((group, index) => group.forEach((id) => map.set(id, index)));
    this.#groups = map;
  }

  heal(): void {
    this.#groups = undefined;
  }

  get partitioned(): boolean {
    return this.#groups !== undefined;
  }
}
