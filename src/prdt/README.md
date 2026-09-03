# mizchi/converge_audit/prdt

Replicated domain objects built from a **pure domain state machine** and a
**replicated finalization protocol**, following
[PRDTs: Composable Design and Verification of Consensus Protocols using Replicated Data Types](https://arxiv.org/html/2504.05173v3).

```text
Pure Domain State Machine
        +
Replicated Finalization Protocol
        =
Replicated Domain Object
```

The package is independent of `audit/` and `x/game_audit/`; it reuses only
the root `Hasher`, `Signer`, and `Verifier` traits so real hashers and
signers can be plugged in. The core has no clock, randomness, network, or
platform crypto; `examples/prdt` hosts it in a Cloudflare Durable Object.

## Packages

| Package | Responsibility |
| --- | --- |
| `prdt` | Envelope, canonical JSON + SHA-256 hashing, canonical order, `Domain`, `resolve_batch`, proposal / closure / committed lattices, `Protocol`, `ReplicatedDomain`, finalizers, laws |
| `prdt/mmo` | MMO sample: world, commands, events, rejections, reducer, phase order, reference scenario |
| `prdt/runtime` | Seeded PRNG, adversarial in-memory network, checkpoint store, replica with outbox, quorum agent, randomized simulator (single-authority or quorum mode, compaction, digest anti-entropy with state transfer) |
| `prdt/mmo/simulation` | MMO wiring for the simulator, scenario generator, property-style and negative tests |
| `prdt/worker` | JSON-string bridge exported to JS / wasm-gc for hosts such as Durable Objects |

Dependencies point one way: `worker -> mmo -> prdt`, `runtime -> prdt`,
`mmo/simulation -> {mmo, runtime, prdt}`. The domain never imports the
protocol.

## Layers

```text
Runtime  ->  PRDT Protocol  ->  Finalization  ->  Domain
runtime/     replicated_domain  resolve_batch     domain.mbt, mmo/
             proposal_state
             closure, committed_log, finalizer, single_authority, quorum
```

### Domain

```moonbit
pub(all) struct Domain[S, C, E, R] {
  initial_state : () -> S
  validate : (S, C) -> Validation[E, R]   // pure
  apply : (S, E) -> S                      // pure, non-mutating
}
```

`resolve_batch(tick, previous_state, commands, domain, order, hasher)` copies
the commands, sorts them by the canonical `CommandOrder`, validates each one
against the state immediately before it, applies accepted events, and
returns verdicts plus state hashes. `alive` (`hp > 0`) is evaluated here and
never as a proposal-time precondition.

### PRDT

| Type | Lattice | Refusal |
| --- | --- | --- |
| `ProposalState[C]` | tick → command id → envelope, grow-only | `ConflictingProposal(id)` when one id carries two payloads |
| `ClosureDecision` / `ClosureMap` | `ClosurePending <= Closed(c)`; `Closed(a) <= Closed(b)` iff `a == b` | `ConflictingClosure(tick)` |
| `CommittedLog[R]` | prefix order | `PrefixConflict(index)` |
| `State` | product of the three, then `advance` | see `Protocol::apply_delta` |

`Protocol::apply_delta` verifies every certificate with the configured
`Finalizer`, checks `ordered_commands_hash`, joins, and then materializes as
many consecutive ticks as are both closed and fully known. A certificate whose
`parent_decision_hash` or id order disagrees with the local recomputation is a
`ChainMismatch` / `OrderMismatch` and the whole delta is refused. Commands that
arrive after their tick closed become `DecisionLate(tick)` and never touch a
committed batch. The committed prefix is derived from knowledge and is never
transported; `Protocol::restore` re-derives it and refuses a snapshot whose
persisted prefix disagrees.

### Compaction, digests, and state transfer

`State` carries a `Base[S]`: the decision hash and domain state at
`next_tick - 1` (genesis by default). `Protocol::compact(state, retain_ticks~)`
folds the oldest materialized batches into the base and forgets proposals and
closures below it. Compaction is administrative, not a join: it never changes
a verdict, but `decision` stops reporting commands of compacted ticks, and
proposals for compacted ticks are dropped on ingest.

`Protocol::join` adopts the later base and refuses (`PrefixConflict`) a peer
whose committed prefix contradicts it. `Protocol::digest` summarizes what a
replica knows (`base_next_tick`, `next_tick`, retained ids, closed ticks) and
`delta_since` / `catchup_since` return only what a peer with that digest is
missing; a `Catchup` also carries the sender's base so a peer that fell behind
a compacted history can resume. **Trust note:** a base cannot be re-derived
once its history is forgotten, so `apply_catchup` adopts a base only when the
receiver's own prefix cannot contradict it. Authenticating bases (a checkpoint
certificate signed by the authority or a quorum, as in `audit/`) is future
work.

### Finalizers

```moonbit
pub(open) trait Finalizer {
  verify_closure(Self, ClosureCertificate) -> Bool
}
```

- `SingleAuthorityFinalizer` / `ClosureAuthority`: one key signs the closure
  payload digest with the root `Signer`; every replica verifies it.
- `QuorumFinalizer` / `Voter` / `VoteState`: a tick closes when at least
  `threshold` distinct roster members sign the same payload. `QuorumRoster::new`
  enforces `2 * threshold > roster.length()`, so at most one payload per tick
  can qualify; an equivocating voter is excluded from every tally. Certificate
  identity is the payload, so certificates assembled from different vote
  subsets are the same decision.
- `runtime/QuorumAgent`: any replica may propose to close its next tick; a
  voter signs the first proposal that targets its next tick, chains from its
  head, and lists only known commands in canonical order (one vote per tick).
  Whoever collects a majority assembles the certificate and gossips it. Safety
  comes from the vote lattice; liveness is best effort (no leader election or
  view change).

`SharedSecretAuthenticator` is an HMAC-SHA256 MAC for tests and development,
not a signature.

## Verified properties

| Property | Where |
| --- | --- |
| Domain rules, batch order independence, conflicts, closure uniqueness, prefix conflicts, late commands, forged / malformed / wrong-parent / non-canonical certificates, snapshot restore and tamper detection, quorum assembly and equivocation, compaction, digest deltas, catchup, join across bases | `*_test.mbt` in `prdt` and `prdt/mmo` |
| Lattice laws for proposal / closure / log / vote / whole state; delivery order, duplication, and merge-tree invariance; snapshot round trip; decision monotonicity under `apply_delta` and `join`; closure uniqueness; prefix safety; late-command finality; domain validity (`Accepted(SkillActivated) => hp > 0 && mp >= cost` immediately before, `hp >= 0`) | `prdt/mmo/simulation/property_test.mbt` (seeded generators) |
| Convergence under reorder, duplication, partition, restart from checkpoint, compaction with state transfer, single-authority and quorum closure (3 and 5 replicas, with an equivocating voter); reproducibility by seed | `prdt/mmo/simulation/simulation_test.mbt` |
| Unstable `alive` guard; premature acceptance breaks monotonicity | `prdt/mmo/simulation/negative_test.mbt` |
| JSON bridge round trip and error reporting | `prdt/worker/bridge_test.mbt` |

PRDT agreement alone does **not** imply domain validity: every replica could
consistently accept a dead player's skill. Domain validity is checked
separately against the state immediately before each accepted command.

## Commands

```sh
just test-prdt          # moon test on every prdt package
just check-prdt-boundary
just test-prdt-worker   # Cloudflare Durable Object host
```

## Not implemented

- Byzantine fault tolerance beyond excluding equivocating quorum voters.
- Quorum liveness: leader election, view change, vote retry.
- `MoveToNextTick` late-command policy (only `RejectAsLate`).
- Authenticated bases (checkpoint certificates) for state transfer; the JS
  bridge still serves full anti-entropy deltas.
- Entity/zone sharding and cross-scope transactions.
- Why3 proof obligations (`.mbtp`) for the lattice laws; today they are checked
  by seeded property tests only.
