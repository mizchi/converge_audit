/**
 * Replicated Domain Object
 *
 *   Pure Domain State Machine + Replicated Finalization Protocol
 *
 * The replicated state is the triple (proposals, closures, committed). The
 * first two are what replicas exchange; the committed prefix is derived
 * deterministically from them and is kept only as a materialization.
 *
 *   Knowledge state  ->  Speculative view  ->  Final decision
 *   append/merge         (client side)        never reverts
 *
 * All functions in `createProtocol` are pure. `createReplicatedDomain` wraps
 * them in a small mutable object for convenience.
 */
import { canonicalize, type JsonValue } from "../core/canonical.ts";
import {
  arrayCodec,
  expectArray,
  expectNumber,
  expectRecord,
  expectString,
  type Codec,
} from "../core/codec.ts";
import { hashValue, type Hasher } from "../core/hash.ts";
import { commandId, isTick, type CommandId, type Envelope, type Hash, type ReplicaId, type Tick } from "../core/ids.ts";
import type { JoinSemilattice } from "../core/lattice.ts";
import type { CommandOrder } from "../core/order.ts";
import type { ResolvedCommand, Verdict } from "../core/verdict.ts";
import type { Domain } from "../domain/domain.ts";
import { resolveBatch, type BatchHashing, type ResolvedBatch } from "../domain/resolve-batch.ts";
import type { Finalizer } from "../finalizer/finalizer.ts";
import {
  closureCertificateCodec,
  closureFor,
  closureMapFrom,
  closureMapLattice,
  listClosures,
  type ClosureCertificate,
  type ClosureMap,
} from "./closure.ts";
import {
  committedLogLattice,
  emptyLog,
  headDecisionHash,
  type CommittedBatch,
  type CommittedLog,
} from "./committed-log.ts";
import { ProtocolError } from "./errors.ts";
import {
  countProposals,
  emptyProposals,
  listProposals,
  proposalLattice,
  proposalsForTick,
  singletonProposal,
  type ProposalState,
} from "./proposal-state.ts";

export interface ReplicatedDomainCodec<S, C, E, R> {
  readonly state: Codec<S>;
  readonly command: Codec<C>;
  readonly event: Codec<E>;
  readonly reason: Codec<R>;
}

export interface ReplicatedDomainConfig<S, C, E, R> {
  readonly domain: Domain<S, C, E, R>;
  readonly order: CommandOrder<C>;
  readonly finalizer: Finalizer<C>;
  readonly hasher: Hasher;
  readonly codec: ReplicatedDomainCodec<S, C, E, R>;
  /** First tick of the log. Ticks are consecutive integers from here. */
  readonly genesisTick?: Tick;
}

export interface ReplicatedDomainState<S, C, E, R> {
  readonly proposals: ProposalState<C>;
  readonly closures: ClosureMap;
  readonly committed: CommittedLog<ResolvedBatch<S, C, E, R>>;
}

/** What replicas exchange. The committed prefix is never transported; it is recomputed. */
export interface Delta<C> {
  readonly proposals: readonly Envelope<C>[];
  readonly closures: readonly ClosureCertificate[];
}

export type CommandDecision<E, R> =
  | { readonly status: "Pending" }
  | { readonly status: "Accepted"; readonly tick: Tick; readonly event: E }
  | { readonly status: "Rejected"; readonly tick: Tick; readonly reason: R }
  /** Protocol-level rejection: the tick closed without this command. Final. */
  | { readonly status: "RejectedLate"; readonly closedTick: Tick };

export interface Decision<E, R> {
  readonly commands: ReadonlyMap<CommandId, CommandDecision<E, R>>;
  readonly committedTicks: readonly Tick[];
  readonly headDecisionHash: Hash;
}

export type LateCommandPolicy = "RejectAsLate";

export interface ReplicatedDomainProtocol<S, C, E, R> {
  readonly config: ReplicatedDomainConfig<S, C, E, R>;
  readonly genesisTick: Tick;
  readonly genesisHash: Hash;
  readonly hashing: BatchHashing<S>;
  readonly lateCommandPolicy: LateCommandPolicy;
  initial(): ReplicatedDomainState<S, C, E, R>;
  /** Whole-state join. Verifies nothing; use `applyDelta` for untrusted input. */
  readonly lattice: JoinSemilattice<ReplicatedDomainState<S, C, E, R>>;
  /** Verify certificates, join, and extend the committed prefix. Throws `ProtocolError` and leaves `state` untouched on failure. */
  applyDelta(state: ReplicatedDomainState<S, C, E, R>, delta: Delta<C>): ReplicatedDomainState<S, C, E, R>;
  /** Full knowledge as a delta, for anti-entropy. */
  deltaOf(state: ReplicatedDomainState<S, C, E, R>): Delta<C>;
  decision(state: ReplicatedDomainState<S, C, E, R>): Decision<E, R>;
  domainState(state: ReplicatedDomainState<S, C, E, R>): S;
  nextTick(state: ReplicatedDomainState<S, C, E, R>): Tick;
  /** Hash of the whole replicated state; equal hashes mean converged replicas. */
  stateHash(state: ReplicatedDomainState<S, C, E, R>): Hash;
  readonly envelopeCodec: Codec<Envelope<C>>;
  readonly deltaCodec: Codec<Delta<C>>;
  snapshot(state: ReplicatedDomainState<S, C, E, R>): JsonValue;
  restore(json: JsonValue): ReplicatedDomainState<S, C, E, R>;
}

export function createProtocol<S, C, E, R>(
  config: ReplicatedDomainConfig<S, C, E, R>,
): ReplicatedDomainProtocol<S, C, E, R> {
  const { domain, order, finalizer, hasher, codec } = config;
  const genesisTick = config.genesisTick ?? 0;
  if (!isTick(genesisTick)) throw new RangeError(`genesisTick must be a non-negative integer: ${genesisTick}`);

  const hashing: BatchHashing<S> = {
    hashState: (state) => hashValue(hasher, codec.state.encode(state)),
    hashCommandIds: (ids) => hashValue(hasher, ids),
  };
  const genesisHash = hashValue(hasher, {
    genesis: "prdt/genesis/v1",
    genesisTick,
    initialStateHash: hashing.hashState(domain.initialState()),
  });

  const proposals = proposalLattice<C>();
  const closures = closureMapLattice();
  const committed = committedLogLattice<ResolvedBatch<S, C, E, R>>();

  type State = ReplicatedDomainState<S, C, E, R>;

  const initial = (): State => ({
    proposals: emptyProposals<C>(),
    closures: new Map(),
    committed: emptyLog(),
  });

  const lastDomainState = (state: State): S => {
    const head = state.committed.batches[state.committed.batches.length - 1];
    return head === undefined ? domain.initialState() : head.result.resultingState;
  };

  const nextTick = (state: State): Tick => genesisTick + state.committed.batches.length;

  const validateCertificateShape = (certificate: ClosureCertificate): void => {
    if (!isTick(certificate.tick) || certificate.tick < genesisTick) {
      throw new ProtocolError("MalformedCertificate", `tick ${certificate.tick} is before genesis ${genesisTick}`);
    }
    const seen = new Set<CommandId>();
    for (const id of certificate.orderedCommandIds) {
      if (seen.has(id)) throw new ProtocolError("MalformedCertificate", `duplicate command id ${id} in certificate`);
      seen.add(id);
    }
    if (hashing.hashCommandIds(certificate.orderedCommandIds) !== certificate.orderedCommandsHash) {
      throw new ProtocolError("MalformedCertificate", `orderedCommandsHash does not match orderedCommandIds`, {
        tick: certificate.tick,
      });
    }
  };

  /** Extend the committed prefix as far as closures and known commands allow. */
  const advance = (state: State): State => {
    let log = state.committed;
    let domainState = lastDomainState(state);
    for (;;) {
      const tick = genesisTick + log.batches.length;
      const closure = closureFor(state.closures, tick);
      if (closure.status !== "Closed") break;
      const certificate = closure.certificate;
      const parent = headDecisionHash(log, genesisHash);
      if (certificate.parentDecisionHash !== parent) {
        throw new ProtocolError("ChainMismatch", `closure for tick ${tick} chains from an unknown parent`, {
          tick,
          expected: parent,
          actual: certificate.parentDecisionHash,
        });
      }
      const known = proposalsForTick(state.proposals, tick);
      const envelopes: Envelope<C>[] = [];
      let complete = true;
      for (const id of certificate.orderedCommandIds) {
        const envelope = known.get(id);
        if (envelope === undefined) {
          complete = false;
          break;
        }
        envelopes.push(envelope);
      }
      if (!complete) break;
      const batch = resolveBatch(tick, domainState, envelopes, domain, order, hashing);
      const resolvedIds = batch.results.map((r) => r.envelope.id);
      if (canonicalize(resolvedIds) !== canonicalize(certificate.orderedCommandIds)) {
        throw new ProtocolError("OrderMismatch", `certificate order for tick ${tick} is not the canonical order`, {
          tick,
          certificate: certificate.orderedCommandIds,
          canonical: resolvedIds,
        });
      }
      const resultHash = hashValue(hasher, {
        tick,
        parentDecisionHash: parent,
        orderedCommandsHash: certificate.orderedCommandsHash,
        resultingStateHash: batch.resultingStateHash,
        verdicts: batch.results.map((r) => ({ id: r.envelope.id, verdict: r.verdict })),
      });
      const entry: CommittedBatch<ResolvedBatch<S, C, E, R>> = {
        tick,
        parentDecisionHash: parent,
        orderedCommandsHash: certificate.orderedCommandsHash,
        resultHash,
        result: batch,
      };
      log = { batches: [...log.batches, entry] };
      domainState = batch.resultingState;
    }
    return log === state.committed ? state : { ...state, committed: log };
  };

  const lattice: JoinSemilattice<State> = {
    merge(left, right) {
      return advance({
        proposals: proposals.merge(left.proposals, right.proposals),
        closures: closures.merge(left.closures, right.closures),
        committed: committed.merge(left.committed, right.committed),
      });
    },
    equals(left, right) {
      return (
        proposals.equals(left.proposals, right.proposals) &&
        closures.equals(left.closures, right.closures) &&
        committed.equals(left.committed, right.committed)
      );
    },
  };

  const applyDelta = (state: State, delta: Delta<C>): State => {
    let mergedProposals = state.proposals;
    for (const envelope of delta.proposals) {
      if (!isTick(envelope.tick)) {
        throw new ProtocolError("TickMismatch", `envelope ${envelope.id} has an invalid tick ${envelope.tick}`);
      }
      mergedProposals = proposals.merge(mergedProposals, singletonProposal(envelope));
    }
    for (const certificate of delta.closures) {
      validateCertificateShape(certificate);
      if (!finalizer.verify(certificate, proposalsForTick(mergedProposals, certificate.tick))) {
        throw new ProtocolError("InvalidCertificate", `closure certificate for tick ${certificate.tick} failed verification`, {
          tick: certificate.tick,
        });
      }
    }
    const mergedClosures = closures.merge(state.closures, closureMapFrom(delta.closures));
    return advance({ proposals: mergedProposals, closures: mergedClosures, committed: state.committed });
  };

  const deltaOf = (state: State): Delta<C> => ({
    proposals: listProposals(state.proposals),
    closures: listClosures(state.closures),
  });

  const decision = (state: State): Decision<E, R> => {
    const commands = new Map<CommandId, CommandDecision<E, R>>();
    const verdictByTick = new Map<Tick, ReadonlyMap<CommandId, Verdict<E, R>>>();
    for (const batch of state.committed.batches) {
      verdictByTick.set(batch.tick, new Map(batch.result.results.map((r) => [r.envelope.id, r.verdict])));
    }
    const ticks = [...state.proposals.byTick.keys()].sort((a, b) => a - b);
    for (const tick of ticks) {
      const closure = closureFor(state.closures, tick);
      const verdicts = verdictByTick.get(tick);
      const included =
        closure.status === "Closed" ? new Set(closure.certificate.orderedCommandIds) : undefined;
      for (const id of [...state.proposals.byTick.get(tick)!.keys()].sort()) {
        const verdict = verdicts?.get(id);
        if (verdict !== undefined) {
          commands.set(
            id,
            verdict.status === "Accepted"
              ? { status: "Accepted", tick, event: verdict.event }
              : { status: "Rejected", tick, reason: verdict.reason },
          );
        } else if (included !== undefined && !included.has(id)) {
          commands.set(id, { status: "RejectedLate", closedTick: tick });
        } else {
          commands.set(id, { status: "Pending" });
        }
      }
    }
    return {
      commands,
      committedTicks: state.committed.batches.map((b) => b.tick),
      headDecisionHash: headDecisionHash(state.committed, genesisHash),
    };
  };

  const stateHash = (state: State): Hash =>
    hashValue(hasher, {
      proposals: listProposals(state.proposals),
      closures: listClosures(state.closures),
      committed: state.committed.batches.map((b) => b.resultHash),
      proposalCount: countProposals(state.proposals),
    });

  const envelopeCodec: Codec<Envelope<C>> = {
    encode: (envelope) => ({
      id: envelope.id,
      tick: envelope.tick,
      submittedBy: envelope.submittedBy,
      localSequence: envelope.localSequence,
      command: codec.command.encode(envelope.command),
    }),
    decode: (json) => {
      const record = expectRecord(json, "envelope");
      return {
        id: expectString(record.id, "envelope.id"),
        tick: expectNumber(record.tick, "envelope.tick"),
        submittedBy: expectString(record.submittedBy, "envelope.submittedBy"),
        localSequence: expectNumber(record.localSequence, "envelope.localSequence"),
        command: codec.command.decode(record.command ?? null),
      };
    },
  };

  const verdictCodec: Codec<Verdict<E, R>> = {
    encode: (verdict) =>
      verdict.status === "Accepted"
        ? { status: "Accepted", event: codec.event.encode(verdict.event) }
        : { status: "Rejected", reason: codec.reason.encode(verdict.reason) },
    decode: (json) => {
      const record = expectRecord(json, "verdict");
      const status = expectString(record.status, "verdict.status");
      if (status === "Accepted") return { status, event: codec.event.decode(record.event ?? null) };
      if (status === "Rejected") return { status, reason: codec.reason.decode(record.reason ?? null) };
      throw new TypeError(`verdict.status: unknown ${status}`);
    },
  };

  const resolvedCodec: Codec<ResolvedCommand<C, E, R>> = {
    encode: (resolved) => ({ envelope: envelopeCodec.encode(resolved.envelope), verdict: verdictCodec.encode(resolved.verdict) }),
    decode: (json) => {
      const record = expectRecord(json, "resolvedCommand");
      return { envelope: envelopeCodec.decode(record.envelope ?? null), verdict: verdictCodec.decode(record.verdict ?? null) };
    },
  };

  const batchCodec: Codec<CommittedBatch<ResolvedBatch<S, C, E, R>>> = {
    encode: (batch) => ({
      tick: batch.tick,
      parentDecisionHash: batch.parentDecisionHash,
      orderedCommandsHash: batch.orderedCommandsHash,
      resultHash: batch.resultHash,
      result: {
        tick: batch.result.tick,
        previousStateHash: batch.result.previousStateHash,
        orderedCommandHash: batch.result.orderedCommandHash,
        results: arrayCodec(resolvedCodec).encode(batch.result.results),
        resultingState: codec.state.encode(batch.result.resultingState),
        resultingStateHash: batch.result.resultingStateHash,
      },
    }),
    decode: (json) => {
      const record = expectRecord(json, "committedBatch");
      const result = expectRecord(record.result, "committedBatch.result");
      return {
        tick: expectNumber(record.tick, "committedBatch.tick"),
        parentDecisionHash: expectString(record.parentDecisionHash, "committedBatch.parentDecisionHash"),
        orderedCommandsHash: expectString(record.orderedCommandsHash, "committedBatch.orderedCommandsHash"),
        resultHash: expectString(record.resultHash, "committedBatch.resultHash"),
        result: {
          tick: expectNumber(result.tick, "result.tick"),
          previousStateHash: expectString(result.previousStateHash, "result.previousStateHash"),
          orderedCommandHash: expectString(result.orderedCommandHash, "result.orderedCommandHash"),
          results: arrayCodec(resolvedCodec).decode(result.results ?? null),
          resultingState: codec.state.decode(result.resultingState ?? null),
          resultingStateHash: expectString(result.resultingStateHash, "result.resultingStateHash"),
        },
      };
    },
  };

  const deltaCodec: Codec<Delta<C>> = {
    encode: (delta) => ({
      proposals: arrayCodec(envelopeCodec).encode(delta.proposals),
      closures: arrayCodec(closureCertificateCodec).encode(delta.closures),
    }),
    decode: (json) => {
      const record = expectRecord(json, "delta");
      return {
        proposals: arrayCodec(envelopeCodec).decode(expectArray(record.proposals, "delta.proposals")),
        closures: arrayCodec(closureCertificateCodec).decode(expectArray(record.closures, "delta.closures")),
      };
    },
  };

  const SNAPSHOT_VERSION = 1;

  const snapshot = (state: State): JsonValue => ({
    version: SNAPSHOT_VERSION,
    genesisTick,
    proposals: arrayCodec(envelopeCodec).encode(listProposals(state.proposals)),
    closures: arrayCodec(closureCertificateCodec).encode(listClosures(state.closures)),
    committed: arrayCodec(batchCodec).encode(state.committed.batches),
  });

  const restore = (json: JsonValue): State => {
    const record = expectRecord(json, "snapshot");
    if (expectNumber(record.version, "snapshot.version") !== SNAPSHOT_VERSION) {
      throw new TypeError(`snapshot.version: unsupported ${String(record.version)}`);
    }
    if (expectNumber(record.genesisTick, "snapshot.genesisTick") !== genesisTick) {
      throw new TypeError(`snapshot.genesisTick ${String(record.genesisTick)} does not match protocol genesis ${genesisTick}`);
    }
    let proposalState = emptyProposals<C>();
    for (const envelope of arrayCodec(envelopeCodec).decode(expectArray(record.proposals, "snapshot.proposals"))) {
      proposalState = proposals.merge(proposalState, singletonProposal(envelope));
    }
    const closureState = closureMapFrom(arrayCodec(closureCertificateCodec).decode(expectArray(record.closures, "snapshot.closures")));
    const batches = arrayCodec(batchCodec).decode(expectArray(record.committed, "snapshot.committed"));
    // A restored prefix is re-derived from knowledge rather than trusted blindly:
    // advancing from the empty log must reproduce exactly the persisted batches.
    const recomputed = advance({ proposals: proposalState, closures: closureState, committed: emptyLog() });
    const persisted: CommittedLog<ResolvedBatch<S, C, E, R>> = { batches };
    if (!committed.equals(recomputed.committed, committed.merge(recomputed.committed, persisted))) {
      throw new ProtocolError("PrefixConflict", "snapshot committed prefix does not match recomputation");
    }
    return recomputed;
  };

  return {
    config,
    genesisTick,
    genesisHash,
    hashing,
    lateCommandPolicy: "RejectAsLate",
    initial,
    lattice,
    applyDelta,
    deltaOf,
    decision,
    domainState: lastDomainState,
    nextTick,
    stateHash,
    envelopeCodec,
    deltaCodec,
    snapshot,
    restore,
  };
}

export interface ProposeInput<C> {
  readonly tick: Tick;
  readonly command: C;
}

export interface ReplicatedDomainOptions<S, C, E, R> extends ReplicatedDomainConfig<S, C, E, R> {
  readonly replicaId: ReplicaId;
}

/** Mutable convenience wrapper around the pure protocol. */
export class ReplicatedDomain<S, C, E, R> {
  readonly protocol: ReplicatedDomainProtocol<S, C, E, R>;
  readonly replicaId: ReplicaId;
  #state: ReplicatedDomainState<S, C, E, R>;
  #nextLocalSequence: number;

  constructor(
    protocol: ReplicatedDomainProtocol<S, C, E, R>,
    replicaId: ReplicaId,
    state: ReplicatedDomainState<S, C, E, R> = protocol.initial(),
    nextLocalSequence = 0,
  ) {
    this.protocol = protocol;
    this.replicaId = replicaId;
    this.#state = state;
    this.#nextLocalSequence = nextLocalSequence;
  }

  get state(): ReplicatedDomainState<S, C, E, R> {
    return this.#state;
  }

  get nextLocalSequence(): number {
    return this.#nextLocalSequence;
  }

  /** Record a local proposal and return the delta to disseminate. */
  propose(input: ProposeInput<C>): { envelope: Envelope<C>; delta: Delta<C> } {
    if (!isTick(input.tick)) throw new RangeError(`tick must be a non-negative integer: ${input.tick}`);
    const localSequence = this.#nextLocalSequence;
    const envelope: Envelope<C> = {
      id: commandId(this.replicaId, localSequence),
      tick: input.tick,
      submittedBy: this.replicaId,
      localSequence,
      command: input.command,
    };
    const delta: Delta<C> = { proposals: [envelope], closures: [] };
    this.#state = this.protocol.applyDelta(this.#state, delta);
    this.#nextLocalSequence = localSequence + 1;
    return { envelope, delta };
  }

  merge(delta: Delta<C>): void {
    this.#state = this.protocol.applyDelta(this.#state, delta);
  }

  closeTick(certificate: ClosureCertificate): void {
    this.merge({ proposals: [], closures: [certificate] });
  }

  decision(): Decision<E, R> {
    return this.protocol.decision(this.#state);
  }

  domainState(): S {
    return this.protocol.domainState(this.#state);
  }

  nextTick(): Tick {
    return this.protocol.nextTick(this.#state);
  }

  delta(): Delta<C> {
    return this.protocol.deltaOf(this.#state);
  }

  stateHash(): Hash {
    return this.protocol.stateHash(this.#state);
  }

  snapshot(): JsonValue {
    return { state: this.protocol.snapshot(this.#state), replicaId: this.replicaId, nextLocalSequence: this.#nextLocalSequence };
  }

  static restore<S, C, E, R>(protocol: ReplicatedDomainProtocol<S, C, E, R>, json: JsonValue): ReplicatedDomain<S, C, E, R> {
    const record = expectRecord(json, "replicatedDomainSnapshot");
    return new ReplicatedDomain(
      protocol,
      expectString(record.replicaId, "replicatedDomainSnapshot.replicaId"),
      protocol.restore(record.state ?? null),
      expectNumber(record.nextLocalSequence, "replicatedDomainSnapshot.nextLocalSequence"),
    );
  }
}

export function createReplicatedDomain<S, C, E, R>(
  options: ReplicatedDomainOptions<S, C, E, R>,
): ReplicatedDomain<S, C, E, R> {
  const { replicaId, ...config } = options;
  return new ReplicatedDomain(createProtocol(config), replicaId);
}

