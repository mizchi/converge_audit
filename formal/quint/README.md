# Quint models for checkpoint delivery, witnesses, settlement, keys, and observer signing

This directory is the source of truth for temporal protocols that move a
local-first audit log from peers to an authority and for the settlement state
machines of verified assets. It does not model game-specific combat rules.

MoonBit/Why3 owns pure admission predicates. Quint/TLC owns state transitions
across delivery order, retries, crashes, packet loss, and partitions. Physical
adapters must satisfy the transaction and API requirements in the
[persistence and transport contract](../../docs/game-audit-implementation-contract-ja.md).

The [model-reading guide](./GUIDE-ja.md) documents reading order, nondeterministic
wrappers, fairness, and the procedure for adding properties.

Quint is a typed specification language with TLA semantics. This repository
uses `quint verify --backend=tlc` for exhaustive finite-state exploration and
fairness-aware liveness. The default Apalache backend is used selectively for
bounded/inductive safety, not as a replacement for the TLC liveness gate.

- [Quint repository](https://github.com/quint-co/quint)
- [Quint: Model Checkers](https://quint.sh/docs/model-checkers)
- [Quint: Checking Properties](https://quint.sh/docs/checking-properties)

## Source layout

- `CheckpointDelivery.qnt`, `WitnessQuorum.qnt`, `AssetOwnership.qnt`,
  `LineageAppeal.qnt`, `EvidenceLineageCase.qnt`, `KeyLifecycle.qnt`, and
  `ObserverSigningStore.qnt`: protocol state, actions, and properties.
- `*Models.qnt`: healthy configurations and deliberately broken Red models.
- `*Tests.qnt`: representative reachable and guarded scenarios.
- `CheckpointDeliveryMbt.qnt` and `WitnessQuorumMbt.qnt`: deterministic MBT
  traces replayed against implementations.
- `AssetOwnershipModels.qnt`: both model-checking input and a random trace source
  replayed directly into MoonBit through `quint_connect`.
- `ConfigContracts.qnt`: forbidden constant configurations.
- `check*.sh`: Quint CLI and CI integration.

## Model boundaries

### Checkpoint delivery

`CheckpointDelivery.qnt` uses two peers, two epochs, three events, and one
authority. Epoch 1 contains two events owned by different peers; epoch 2 adds
one event.

| Implementation concept | Quint abstraction |
| --- | --- |
| Replica-local event DB | Monotonic `accepted` set per peer |
| Trusted watermark | Seal guard stating that every expected event through the epoch arrived |
| Merkle checkpoint | Record containing epoch, parent digest, and authenticated event set |
| Durable local DB | `durableCheckpoints` |
| At-least-once queue/outbox | `durableOutbox`, network sets, retry actions, and capacity |
| Replica-local route lease | Undelivered durable outbox survives crash and retries after expiry |
| Authority head | Exact-parent authority `headLog` |
| Process/network failure | Crash/restart, drop, partition/heal actions |

Merkle construction, collision resistance, and signature unforgeability are
not modeled. The event set is an abstract canonical Merkle root; cryptography
and tree implementation remain MoonBit tests. Micro checkpoints are omitted;
the model handles only macro seals sent to the authority.

### Witness quorum

`WitnessQuorum.qnt` reduces destination-specific collection to four roster
witnesses, one intruder, and a quorum of three approvals. Cryptographic
verification is abstracted as `response.valid`. The model covers producer
authentication, distinct roster counting, deadline expiry, ready collection,
and the gate from collection to receiver update.

### Asset ownership

`AssetOwnership.qnt` uses one asset, three owners, and at most two transfers.
Signature verification is Boolean. It models exact-version transfer from the
version-0 origin head, dual sender/recipient authentication, transfer refusal
while listed, transfer after cancellation, and canceled listing-nonce replay
refusal.

Origin and transfer versions may be revoked and appealed. Revoking an ancestor
quarantines an active descendant listing. Appeal recomputes clean lineage but
does not reactivate an old listing; a fresh nonce may relist the same owner
head. An intermediate transfer becomes a `verifiedAncestor` only after
`registerLineageSlice` receives an authenticated slice from origin or the
previous `retainedAnchorVersion` through the current head. Unregistered
transfer revocation, wrong-parent slices, and wrong terminal heads are refused.
Crypto primitives, HTTP decoding, and SQLite migrations remain Worker/MoonBit
tests.

### Lineage appeal and evidence cases

`LineageAppeal.qnt` reduces the domain to two ancestors, four canonical
decision IDs, and three clock steps. External certificate authentication and
receipt time are Boolean facts. It verifies per-ancestor revisions, decision-ID
uniqueness, `Finalized -> AppealOpen -> Finalized | Expired`, exact appeal
targets, deadlines, and the rule that appealing one ancestor never clears
another. Signature bytes, Unix milliseconds, and arbiter-roster parsing remain
Worker/MoonBit responsibilities.

`EvidenceLineageCase.qnt` uses two cases and one asset. One action opens a case
from an active, authenticated, exact-bound hold; separate actions uphold or
dismiss using authenticated exact-bound arbiter certificates. Opening and
dismissal never change the asset. Only an upheld decision performs
`Eligible -> Revoked`. Closing a case does not resolve the player-local hold;
only a separate action in which the authenticated source publishes the exact
resolution at the next cursor may resolve it.

### Key lifecycle

`KeyLifecycle.qnt` uses two key versions, five checkpoint candidates, and four
clock steps. Routine rotation retains old verification records. Admission
applies key validity and effective revocation to signing time. Three broken
models independently remove exact key binding, issuance validity, and the
revocation gate. Signature bytes and persisted key history remain TypeScript/
Workers concerns; MoonBit/Why3 owns the matching pure admission predicate.

### Observer signing store

`ObserverSigningStore.qnt` uses two registration slots and two encounter
digests. It separates reservation-before-sign, exact retry, conflict refusal,
signer failure, and crash/restart, treating reservations as durable state.
SQLite schema/CAS, Merkle snapshots, and concrete signature bytes remain
Workers/MoonBit concerns. The Red configuration that loses reservations on
crash produces both a signature-without-reservation counterexample and a
post-restart double-signing counterexample.

## Claim ledger

| Claim | Source of truth | Verification artifact | Status |
| --- | --- | --- | --- |
| Owner version advances exactly once per transfer | `AssetOwnership.transfer` | `ownerVersionAdvancesExactlyOnce` + broken-version counterexample | Verified in finite model |
| Owner changes require sender and recipient authentication | `AssetOwnership.transfer` | `transferRequiresDualAuthentication` + broken-recipient counterexample | Verified in finite model |
| Ownership cannot change while a listing is active | `AssetOwnership.transfer/list` | `activeListingMatchesCurrentOwnerHead` + broken-listing counterexample | Verified in finite model |
| Cancellation permits transfer/fresh-nonce relisting but rejects old-nonce replay | `AssetOwnership.cancel/list` | Three executable scenarios | Scenario verified |
| Ancestor revocation cannot leave a descendant listing active | `AssetOwnership.revokeAncestor` | `activeListingRequiresCleanLineage` + broken-revocation counterexample | Verified in finite model |
| Unresolved revocation blocks new descendant transfers | `AssetOwnership.transfer` | `transferRequiresCleanLineage` + broken-transfer counterexample | Verified in finite model |
| Historical transfer revocation requires an exact authenticated slice | `registerLineageSlice/revokeAncestor` | Boundary invariant + broken-parent counterexample + scenarios | Verified in finite model |
| Appeal never reactivates a quarantined nonce | `restoreAncestor/list` | Two scenarios | Scenario verified |
| Ed25519, wire binding, and persistence refine the abstraction | Workers API/SQLite contract | Owner-auth unit and workerd integration tests | Regression tested, not refinement-proved |
| Lineage decisions require authentication, timeliness, and next revision | `LineageAppeal.revoke/appeal` | Three invariants + three Red models | Verified in finite model |
| Appeal finalizes only the exact target before deadline | `LineageAppeal.appeal/advanceTime` | Two invariants + Red models + scenarios | Verified in finite model |
| One appeal cannot clear another ancestor; expiry never auto-restores | Per-ancestor map + `lineageClean` | Independent-revocation/expiry scenarios | Scenario verified |
| A case opens only from an authenticated active exact-bound hold | `EvidenceLineageCase.openCase` | Hold invariant + Red models | Verified in finite model |
| Opening a case alone never stops the asset | `openCase/decideCase` | Non-mutation invariant + Red model | Verified in finite model |
| Only an authenticated exact-case certificate changes the asset | `decideCase` | Certificate invariant + Red models | Verified in finite model |
| Dismissal closes only an authenticated exact case and never changes the asset | `dismissCase` | Dismissal invariants + Red models | Verified in finite model |
| Case close never resolves a hold without source signature, exact binding, and next cursor | `publishSourceResolution` | Resolution invariants + Red models | Verified in finite model |
| Key-version substitution is refused | `KeyLifecycle.verify` | Exact-binding invariant + Red model | Verified in finite model |
| Validity and effective revocation apply to signing time | `KeyLifecycle.verify` | Two invariants + Red models | Verified in finite model |
| Historical checkpoints remain verifiable after routine rotation | `KeyLifecycle.rotate/verify` | Rotation/revocation scenarios + deletion negative control | Scenario verified |
| An observer signature exists only after its exact durable reservation | `ObserverSigningStore.reserve/sign/crash` | Exact-reservation invariant + volatile Red model | Verified in finite model |
| Crash/retry never signs two digests for one slot | `reserve/sign/crash/restart` | No-double-signing invariant + volatile Red model | Verified in finite model |

## Checked properties

Healthy modules exhaustively check that:

- a sealed checkpoint contains every expected event for its epoch;
- honest peers sealing the same epoch converge on the same digest;
- peer and authority heads form continuous exact-parent chains from genesis;
- events and sealed checkpoints survive crashes;
- the authority accepts only checkpoints peers actually created;
- a peer at unacknowledged outbox capacity cannot seal another checkpoint;
- witness readiness requires a valid producer and distinct roster quorum;
- the receiver advances only from ready collections, and expiry is neither
  invalidity nor receiver advancement;
- versioned-key admission has exact binding, a valid signing window, and signing
  time before effective revocation;
- asset version, dual authentication, listing, lineage, revocation, appeal,
  case, dismissal, and source-resolution invariants hold;
- every observer signature has its exact reservation, and one slot has at most
  one signed digest across crash/retry.

Checkpoint liveness is conditional:

```text
eventually always(unpartitioned and all nodes up)
  => eventually(authority head = latest epoch)
```

This is not unconditional delivery. Gossip, delivery, seal, restart, heal, and
oldest-unacknowledged retry are assumed not to starve forever when repeatedly
enabled. Witness liveness similarly assumes fair sending and delivery of
uncollected honest approvals.

## Red models

`quint-counterexamples` verifies that removing each load-bearing guard produces
the intended model counterexample rather than a syntax or configuration error.

| Removed guard | Counterexample |
| --- | --- |
| Seal only after watermark completeness | Epoch 1 can omit the other peer's event |
| Durable outbox | A crash immediately after seal loses an unsent checkpoint |
| Authority exact parent | The authority accepts a skipped epoch |
| Retry after packet loss | A dropped checkpoint never finalizes |
| Outbox capacity | More unacknowledged checkpoints than capacity are sealed |
| Producer authentication | Three approvals make an invalid producer ready |
| Witness roster | An intruder contributes to quorum |
| Recipient authentication | Ownership changes without recipient consent |
| Exact owner version | Transfer count and owner version diverge |
| Transfer refusal while listed | Owner changes under a stale active listing |
| Quarantine on ancestor revocation | Descendant listing stays active with invalid lineage |
| Transfer refusal on revoked lineage | A new head derives from an invalid ancestor |
| Lineage auth/time/revision | Unauthenticated, expired, or stale decisions mutate the head |
| Appeal target/deadline | Another revoke or expired case returns to eligible |
| Evidence hold auth/binding | An unauthenticated or retargeted hold opens a case |
| Case-open non-mutation | The asset revokes without an arbiter decision |
| Case certificate auth/binding | An unauthenticated or wrong-case certificate mutates the asset |
| Dismissal auth/binding/non-mutation | Invalid dismissal or dismissal-only revocation succeeds |
| Source resolution auth/binding/cursor/non-automatic | Closing alone, an invalid source, wrong resolution, or stale cursor clears a hold |
| Observer reservation durability | Crash loses the reservation and permits missing reservation or double signing |

## Recorded results

Checked with Quint 0.32.0 and TLC 2.19.

| Configuration | Generated states | Distinct states | Depth |
| --- | ---: | ---: | ---: |
| Checkpoint safety | 55,849 | 11,340 | 24 |
| Checkpoint liveness | 55,849 | 11,340 | 24 |
| Witness safety | 336,897 | 30,720 | 18 |
| Witness liveness | 212,993 | 19,456 | 18 |
| Observer signing durability | 191 | 50 | 6 |

Every configured healthy model completes without a counterexample, and every
Red model produces the expected counterexample. These are finite model-checking
results, not mathematical proofs for arbitrary peer, epoch, roster, or shard
counts, and not verification of physical production transports.

All configured reachability/guard scenarios pass. Invalid configurations with
capacity 0, quorum 0, or quorum above roster size are rejected. The lineage
appeal model has five matching Red configurations and six scenarios. The
evidence-lineage case model has twelve matching Red configurations and twelve
scenarios. The observer signing model has two durability counterexamples and
three scenarios.

## Model-based testing

`CheckpointDeliveryMbt.qnt` exports this representative ITF trace:

```text
event gossip/delivery -> epoch 1 seal -> crash/restart
  -> authority ACK -> epoch 2 seal -> authority ACK
```

Outbox capacity is 1, so epoch 2 cannot seal unless the epoch-1 ACK releases
delivery capacity. The Node replayer applies every state to the real MoonBit
checkpoint policy and player-local SQLite adapter and compares accepted events,
checkpoint chain, unacknowledged durable outbox, and authority head. This fixes
the meaning that acknowledged tombstones remain evidence but consume no
capacity. It is a deterministic conformance test across crash, retry, ACK, and
capacity reuse, not an arbitrary-trace refinement proof.

`WitnessQuorumMbt.qnt` traverses an authenticated intruder response, an invalid
roster signature, three honest distinct approvals, and receiver advancement in
12 states. The replayer concretizes abstract `valid` values as real Ed25519
signatures and compares MoonBit results: `unknown_witness`,
`invalid_witness_signature`, `under_quorum`, then three-approval success. It
projects the authentication gate only; network soup, collection SQLite,
deadlines, and rate limits remain Workers integration tests.

Asset ownership uses
[`mizchi/quint_connect`](https://github.com/mizchi/quint-connect-moonbit).
The native MoonBit runner executes `quint run --mbt`, decodes namespaced state,
`#bigint`, `#set`, and nondeterministic picks, and connects actions to the real
lineage and transfer predicates. Fixed tests compare a healthy driver with a
driver missing quarantine and require `StateDiverged`. CLI integration checks
32 traces / 288 states with seed `0xa55e7` and confirms the broken driver fails
on the same trace set. Cloudflare transactions and HTTP decoding remain separate
workerd integration tests.

## Apalache smoke

The default Apalache backend finds no witness-safety counterexample through five
steps and finds the expected missing-producer-auth counterexample through eight.
An 18-step run did not complete in roughly two minutes and ended with Z3
`UNKNOWN`. Apalache is therefore a short bounded smoke check here, not the
authoritative finite exploration or liveness gate.

## Run

```sh
just formal-check

# Individual stages
just quint-config-contracts
just quint-scenarios
just quint-mbt
just quint-witness-mbt
just quint-connect-mbt
just quint-check
just quint-counterexamples
just quint-apalache-smoke
just quint-docs
```

`quint-check` typechecks and verifies every healthy configuration with TLC and
named invariants. `quint-scenarios` runs executable traces.
`quint-config-contracts` rejects invalid constants. The two deterministic MBT
commands replay checkpoint and witness traces into real MoonBit/SQLite or
MoonBit/Ed25519 gates. `quint-connect-mbt` replays randomized asset ownership
traces into MoonBit with both healthy and broken drivers.
`quint-counterexamples` checks every Red model. `quint-apalache-smoke` is
bounded and intentionally excluded from authoritative `formal-check`.

## Migration note

The handwritten TLA+ sources were ported to Quint on 2026-08-05. Generated,
distinct, and depth counts matched for all four healthy configurations, and the
seven original Red configurations preserved their counterexample classes. To
avoid dual maintenance, handwritten `.tla`/`.cfg` files and TLA+-specific
recipes were removed. TLA+ generated temporarily by Quint/TLC is build output,
not managed source.
