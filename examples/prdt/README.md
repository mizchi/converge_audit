# converge-prdt

Replicated domain objects built from a **pure domain state machine** and a
**replicated finalization protocol**, following the PRDT approach
([PRDTs: Composable Design and Verification of Consensus Protocols using
Replicated Data Types](https://arxiv.org/html/2504.05173v3)).

```text
Pure Domain State Machine
        +
Replicated Finalization Protocol
        =
Replicated Domain Object
```

This package is independent of the MoonBit audit library in the rest of the
repository. It is the TypeScript reference implementation of the design in
[docs/prdt-replicated-domain-ja.md](../../docs/prdt-replicated-domain-ja.md).
The core is environment independent (no clock, randomness, network, or
platform crypto); a Cloudflare Workers Durable Object adapter is provided as
one runtime.

## What it guarantees, and what it does not

| Property | Layer | Verified by |
| --- | --- | --- |
| `hp <= 0` means dead; a dead actor's skill is `Rejected(ActorDead)` | Domain | unit + property tests |
| Batch result is independent of input order | Finalization | property test (permutation invariance) |
| A command is decided exactly once: `Pending -> Accepted \| Rejected(reason)` | Finalization + PRDT | decision monotonicity property |
| Lattice laws (idempotent, commutative, associative) for every replicated state | PRDT | property tests |
| One closure certificate per tick; a second one is refused | PRDT | unit + property tests |
| Committed logs of any two replicas are prefix compatible | PRDT | property test |
| A late command never changes a committed batch; it becomes `RejectedLate` | PRDT | unit + property tests |
| Convergence under reorder, duplication, partition, and restart | Runtime | 3-replica randomized simulation |
| Accepted `SkillActivated` implies `hp > 0` and `mp >= cost` immediately before | Domain validity | property test over committed logs |

PRDT agreement alone does **not** imply domain validity: every replica could
consistently accept a dead player's skill. Domain validity is checked
separately (`test/properties/domain-validity.test.ts`).

Two designs are rejected explicitly in `test/negative/`:

- **Unstable alive guard**: `hp > 0` as a proposal-time precondition is not
  stable under merge, so replicas reach opposite local verdicts.
- **Premature acceptance**: accepting before the tick is closed forces an
  `Accepted -> Rejected` transition when late damage arrives.

## Layers

```text
Runtime  ->  PRDT Protocol  ->  Finalization  ->  Domain
src/runtime  src/prdt          src/domain/       src/domain/domain.ts
             src/finalizer     resolve-batch.ts  src/examples/mmo
```

Dependencies only point right. The domain layer never imports from PRDT or
runtime code.

### Domain (`src/domain`)

```ts
interface Domain<S, C, E, R> {
  initialState(): S;
  validate(state: S, command: C): Validation<E, R>; // pure
  apply(state: S, event: E): S;                     // pure, non-mutating
}
```

`resolveBatch(tick, previousState, commands, domain, order, hashing)` copies
the commands, sorts them by the canonical `CommandOrder`, validates each one
against the state immediately before it, applies accepted events, and returns
verdicts plus state hashes.

### PRDT (`src/prdt`)

| Type | Lattice | Notes |
| --- | --- | --- |
| `ProposalState<C>` | map of tick → map of `CommandId` → `Envelope` | union; same id with a different payload is `ProtocolError("ConflictingProposal")` |
| `ClosureDecision` | `Pending <= Closed(c)`, `Closed(a) <= Closed(b)` iff `a == b` | `ConflictingClosure` otherwise |
| `CommittedLog<R>` | prefix order | `PrefixConflict` on divergence |
| `ReplicatedDomainState` | product of the three, then `advance` | committed prefix is derived, never transported |

`createProtocol(config)` returns pure functions (`applyDelta`, `lattice`,
`decision`, `snapshot`, `restore`, ...). `createReplicatedDomain` wraps them in
a small mutable object:

```ts
const game = createReplicatedDomain({
  replicaId: "X",
  domain: createGameDomain(world),
  order: gameCommandOrder,
  finalizer: createSingleAuthorityFinalizer(verifier),
  hasher: sha256Hasher,
  codec: { state: worldCodec, command: jsonCodec(), event: jsonCodec(), reason: jsonCodec() },
});

const { delta } = game.propose({ tick: 10, command: { type: "UseSkill", actor: "player-a", skill: "fireball", mpCost: 30 } });
game.merge(remoteDelta);
game.closeTick(certificate);
game.decision().commands.get("X:0"); // Pending | Accepted | Rejected | RejectedLate
```

`applyDelta` verifies every certificate with the configured `Finalizer`,
checks `orderedCommandsHash`, joins, and then materializes as many
consecutive ticks as are both closed and fully known. A certificate whose
`parentDecisionHash` or id order disagrees with the local recomputation is a
`ChainMismatch` / `OrderMismatch` protocol error and the delta is refused.

### Finalizers (`src/finalizer`)

```ts
interface Finalizer<C> {
  verify(certificate: ClosureCertificate, knownCommands: ReadonlyMap<CommandId, Envelope<C>>): boolean;
}
```

- `createSingleAuthorityFinalizer(verifier)` / `createSingleAuthority({ signer, order, hasher })`
- `createQuorumFinalizer({ verifiers, threshold })` with a voting PRDT
  (`vote-state.ts`); `2 * threshold > roster.size` is enforced so that at most
  one payload per tick can reach a quorum, and an equivocating voter is
  excluded from every tally. Leader election and retry (liveness) are not
  implemented.

`sharedSecretAuthenticator(secret)` is a keyed-hash MAC for tests and local
development, not a signature. Plug a real signer/verifier for deployments.

### Runtime (`src/runtime`)

- `Replica` / `AuthorityReplica`: replicated object + outbox + checkpoint
  store. Own proposals and certificates are checkpointed before they leave,
  because a restart that reuses a command id with a different payload, or
  re-closes a tick, is (correctly) refused by the protocol.
- `InMemoryNetwork`: delay, reorder, duplicate, partition, heal.
- `runSimulation`: seeded 3-replica simulation with restart from checkpoint.
- `cloudflare/authority-host.ts`: async-storage host, environment independent.
- `cloudflare/worker.ts`: one Durable Object per room, HTTP routes
  `/rooms/:room/{propose,delta,close,decision,world}`.

## MMO sample (`src/examples/mmo`)

Canonical order inside a tick is `(tick, phase, submittedBy, localSequence, commandId)`
with phase `Damage = 0 < UseSkill = 1`. This is a game-semantic choice, not a
physical order.

Reference scenario: player A has HP 10 / MP 100. Replica X proposes
`UseSkill(A, fireball)` and replica Y proposes `Damage(A, 20)` for the same
tick. After merge and closure every replica commits
`Damage -> Accepted`, `UseSkill -> Rejected(ActorDead)`, `HP(A) = 0`,
whichever order the messages arrived in.

## Commands

```sh
pnpm install
pnpm typecheck
pnpm test            # core (node) + worker (workerd) projects
pnpm test:core
pnpm test:worker
pnpm simulate 3 600  # seed, steps
pnpm dev             # wrangler dev
pnpm deploy:dry
```

## Not implemented

- Byzantine fault tolerance beyond excluding equivocating quorum voters.
- Quorum liveness: leader election, view change, vote retry.
- `MoveToNextTick` late-command policy (only `RejectAsLate`).
- Delta-since-cursor dissemination; the Worker serves full anti-entropy deltas.
- Compaction / GC of proposals and the committed prefix.
- Entity/zone sharding and cross-scope transactions.
- Real signatures (the shipped authenticator is a shared-secret MAC).
