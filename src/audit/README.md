# Generic checkpoint audit layer

`src/audit/` provides game-independent audit contracts that can attach to a
CRDT or local-first database. It defines checkpoint structure, localization
precision derived from retention, head transitions, and compact Merkle and
authenticated-map proofs. Cooldowns, hits, loot, and victory conditions belong
to an application-specific deterministic kernel.

```text
authenticated canonical events ── layered watermark builder
          │                              │ micro roots
          │                              ▼
          │                         macro event root
          │                              │
application checkpoint ── CheckpointAdapter ── CheckpointCommitment
          │                                      │
          └── local DB / peers / authority ── head classifier
                                                  │
                                      application-owned replay policy
```

## Package boundary

| Package | Generic contract |
| --- | --- |
| `audit` | Cadence/retention capabilities, precision and finality estimates, storage-neutral head classification, and MoonBit proofs |
| `audit/commitment` | Trait that projects an application checkpoint into a common commitment |
| `audit/merkle` | Immutable Merkle trees and inclusion proofs |
| `audit/authmap` | Deterministic authenticated treaps and membership/non-membership proofs |
| `audit/layered` | Watermark-driven event → micro → macro construction and two-level proofs |
| `audit/runtime` | Trusted closure, atomic seal/outbox/ACK contracts, a logical player-local store, and peer fanout/retry selection |
| `audit/delivery_auth` | Producer signatures and distinct-witness quorum for destination-specific checkpoints, exposed as opaque capabilities |
| `audit/key_lifecycle` | Fail-closed historical key binding, validity, effective revocation, and proofs |
| `audit/quorum` | Domain-separated votes over opaque subjects, roster authentication, deduplication, and convergent equivocation handling |
| `audit/quorum/vote` | Vote join-semilattice with commutative, associative, idempotent, and equivocation-absorbing proofs |
| `audit/runtime/bridge` | Small primitive/JSON JS and Wasm bridge for Node, Workers, and other hosts |

`CheckpointCommitment` fixes only the scope, epoch, previous checkpoint,
manifest, event, state, effect, and optional sealed-state commitment. Concrete
digest representation, signatures, event decoding, replay, and persistence
transactions remain adapter responsibilities.

The normative atomic-seal, durable-outbox, ACK, ordered-retry, and crash-
recovery requirements are in the
[persistence and transport contract](../../docs/game-audit-implementation-contract-ja.md).
`LayeredCheckpointBuilder` is currently an in-memory builder.
`PlayerLocalAuditStore` is a logical reference adapter that commits event,
equivocation, checkpoint, head, closure, outbox, and ACK history under one
revision and restores from public durable row DTOs. It rejects an image that
contains acknowledged outbox rows without corresponding ACK history. Physical
SQLite/IndexedDB transactions, row encoding, fsync, and device hardening remain
host concerns.

Peer transport has pure contracts for persisted least-recently-attempted
bounded fanout, in-flight backpressure, capped exponential backoff, success
reset, fastest authenticated-response selection, and preference for an
authenticated conflicting digest as fork evidence. Socket/WebTransport/
WebSocket I/O and device credentials are not part of this generic layer.

Game presets, PvE/PvP kernels, witness-roster selection and finality policy,
open-world sampling, inventory, and marketplaces remain under
`src/x/game_audit/`. Using the generic layer alone never proves that an action
was legal under a game's rules. See the
[library boundary](../../docs/library-boundary-ja.md) for promotion criteria
and explicit non-guarantees.

## Precision and complexity

The verified policy enforces:

```text
0 < event interval <= micro interval <= macro interval
macro interval <= event retention <= micro retention <= macro retention
```

For evidence age `a` and intervals `δ`, `μ`, and `T`, temporal localization
degrades in steps. Retention boundaries are inclusive.

```text
a <= event retention : δ
a <= micro retention : μ
a <= macro retention : T
otherwise             : evidence expired
```

One macro checkpoint covers `ceil(T / δ)` event leaves. Binary localization to
one leaf needs `ceil(log2(ceil(T / δ)))` rounds. The API uses iterative integer
ceiling division.

Assuming events arrive uniformly within a macro interval, estimated finality is
`floor(T / 2) + mean validation latency` on average and
`T + supplied p99 validation latency` conservatively. These are engineering
estimates derived from measurements, not network/disk SLAs or cheat-detection
probabilities.

## Layered checkpoint builder

`LayeredCheckpointBuilder` retains authenticated canonical events with event
time and seals only when a monotonic watermark crosses a window boundary.
Event time must be audit time authenticated or assigned by the application,
not an untrusted client wall clock.

- `event_time < watermark` is rejected as late.
- `event_time == watermark` belongs to the next unsealed range.
- An exact canonical-payload retry is idempotent while pending.
- Payloads are sorted before Merkle construction, so arrival order is irrelevant.
- Canonical payloads must contain session-unique event IDs.
- If macro and micro boundaries do not align, the final micro window is forcibly
  closed at the macro boundary.
- A macro binds the previous macro digest plus every micro's metadata and event
  root under a Merkle root.
- Catch-up beyond `max_windows` refuses without mutation, and refusal scanning
  stops after `max_windows + 1` windows.

While full retention remains, the builder can produce event→micro and
micro→macro inclusion proofs. After compaction to metadata it can still verify
externally supplied proofs, but can no longer generate leaf proofs.

Expected pending-duplicate lookup is `O(1)`. Sealing one window is
`O(n log n)` because of canonical sorting; proof generation and verification
are `O(log n)`. The current FNV test backend seals 1,000 events into one micro
in roughly 1.0 ms and through a 15-micro macro in roughly 1.2 ms. Re-measure
with the production hash backend chosen by the application.

## Head transitions

`classify_checkpoint_head` consumes only authenticated input and storage-lookup
facts and returns one of `Advance`, `Duplicate`, `SameEpochFork`, `ParentFork`,
`Gap`, `Stale`, or `BoundaryMismatch`. Persistence is a transaction outside the
pure classifier. A boundary mismatch is not a fork accusation. Only a different
digest at the same epoch or a wrong parent at the exact next epoch is classified
as a fork.

## Atomic seal plan

`prepare_atomic_checkpoint_seal` checks a storage snapshot read inside the
transaction, a canonical checkpoint draft, `TrustedEpochClosure`, required
destinations, and capacity. It returns an opaque `AtomicCheckpointSealPlan` only
for an exact-next checkpoint with an exact parent, unconsumed closure, distinct
destinations, and sufficient outbox capacity. The plan represents checkpoint
history insertion, head update, every outbox insertion, and closure consumption
as one write set.

An exact known complete commit is `AlreadyCommitted`. A known different digest,
parent fork, or incomplete known commit is a conflict. Gap, stale input, and
capacity failure are refusals.

Plan construction is not a database commit. The adapter must compare-and-set
the expected snapshot and apply the entire plan in the same transaction. This
keeps the pure contract independent of SQLite, Cloudflare, or another physical
database.

## Proof scope and limitations

`policy.mbtp`, `head.mbtp`, `time.mbtp`, and the quorum vote proofs check policy
containment, retention precision, finality arithmetic, exact-next/fork
classification, vote-merge algebra, equivocation absorption, late-event
rejection, and the boundary/closure/parent/destination/capacity/order
postconditions of a successful atomic seal through Why3/Z3.

Runtime tests cover capability unconstructibility, all-or-nothing plans,
player-local restart, ACK persistence, peer retry/fork selection, layered
Merkle construction, boundary values, and compatibility with game classifiers.

This does not prove hash collision resistance, signature unforgeability,
machine-integer overflow safety, storage/transport liveness, completeness of a
game kernel, or unobservable cheating such as aimbots.

```sh
just test-audit
just test-audit-layered
just test-audit-runtime
moon test src/audit/delivery_auth
moon test src/audit/key_lifecycle
moon test src/audit/quorum
moon test src/audit/runtime/bridge
just prove-audit-core
moon test src/audit/merkle
moon test src/audit/authmap
moon test src/audit/commitment
just bench-audit-layered
```
