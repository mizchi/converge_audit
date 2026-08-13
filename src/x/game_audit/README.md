# Experimental game-audit stack

This subtree contains the multiplayer anti-cheat and auditable-asset prototype.
It is intentionally outside `mizchi/converge_audit`'s reusable package namespace.

The root `mizchi/converge_audit` package remains the reusable Byzantine-aware adapter around converge events.
`src/audit/` provides the reusable checkpoint policy, commitment projection,
head classifier, authenticated delivery/quorum, runtime bridge, Merkle tree,
and authenticated map. The packages here are one
opinionated game application of those contracts:

```text
src/audit/{policy, commitment, head, merkle, authmap, layered,
           runtime, delivery_auth, quorum, runtime/bridge}
              │
              ▼
policy / audit / checkpoint / attestation / witness_manifest / wire / crypto / worker
                                              └──── browser_bridge
              │
              ├──── open_world / central_replay / pvp_session
              ▼
replay
              │
              ▼
inventory / market
```

`attestation` adapts the application-neutral `audit/quorum` collector to game
replay and checkpoint finality. Roster selection, referee identity, manifest
binding, and the meaning of an approval remain game policy.

The `replay` package includes the one-dimensional telegraphed dungeon,
multi-attack encounter, and two-team public-state PvP epoch kernels. The PvP
kernel resolves simultaneous movement, range attacks, HP, and team score
independently of transcript delivery order. A finalized encounter mints an opaque,
checkpoint-bound replay match consumed by `attestation`; callers cannot inject
a raw replay-success Boolean. Adversarial sessions can instead commit an
independent referee, witness roster, and `n > 3f` fault policy into the session
manifest; `n - f` domain-separated replay signatures mint a checkpoint-bound
certificate. `pvp_session` requires an exact PvP replay/checkpoint/referee match
before exposing the honest-witness signing path and collector. These APIs are
experimental and may change as projectile travel and visibility rules,
overlapping mechanics, persistence, and production cryptography are added.

The `open_world` package adds a selective-replay gate for irregular encounters.
An audit plan commits the game manifest, sample rate, hidden seed, and a
canonical registration-observer roster/fault policy. A plan-bound `n - f`
observer quorum can certify one exact `(plan, slot, encounter digest)` without
claiming that it replayed the game. The public signing path reserves one digest
before signing: exact retries sign the same statement and a second digest for
the same plan/slot is refused without changing its root. A later
authority checkpoint seals the eligible encounter digests under a Merkle root
before the seed is revealed. Leaves bind registration slots to encounter
digests, an authenticated map binds slot membership, and the close manifest
commits the exact count. Opaque evidence is issued for a signed slot beyond
that count, a different included digest at the same slot, or a valid
authenticated-map proof that the in-range slot is absent. Invalid, missing, or
ambiguous proofs cannot accuse the seal. The same conflict can be opened from
an observer certificate even if the authority withheld its encounter
checkpoint. Unsampled ordinary outcomes may finalize from a
matching replay-witness certificate; samples, challenges, sparse economic
results, and high-value outcomes require the checkpoint-bound central replay
capability. Open-world replay bundle v2 also requires an independently signed
transparency checkpoint to include the exact audit digest and its audit-to-seal
link under world/epoch-specific authenticated-map keys. See
`docs/open-world-audit-ja.md` for the threat model and gameplay
constraints.

`OpenWorldObserverSigningStore` is the persistence boundary. Its in-memory
adapter tests sequential compare-and-set behavior. The Cloudflare reference
uses a SQLite-backed Durable Object to atomically commit the reservation and
monotonic sequence before a separate signer is called. Exact retry is allowed;
a conflicting digest is rejected without changing the authenticated root.
Fault injection, signer failure, eviction/restart, concurrent conflicts,
schema mismatch, and row corruption are tested. Restoring a ledger can require
an exact trusted `(observer, key, root, size)` anchor, which rejects empty,
stale, or foreign snapshots. A domain-separated authority checkpoint
can publish a key-unique authenticated map of these anchors; exact membership
opens an opaque capability consumed by ledger restore. A concrete
head tracker advances only through the exact next parent and creates opaque
evidence when same-epoch or wrong-parent authority-signed forks meet. A concrete
ordered gap response is planned without mutation and committed only when every
head is valid. `wire` adds versioned canonical CBOR, allocation preflight, and
receiver budgets. `crypto` connects the unaudited `experimental_crypto`
SHA-256/Ed25519 implementation for known-vector integration and realistic cost
measurement; it is not a production-security claim. A device/mobile store,
external signer credential, production socket/gossip transport, audited crypto
backend, and durable head-history transaction remain integration work.
`worker` exposes the production JS/wasm-gc bridge used by
`examples/cf-game-audit`: canonical serialization, full envelope opening, the
proved classifiers, and real-crypto PvE/PvP/open-world bundle verification. It
does not link any seed-backed signing or benchmark-fixture export.
`worker_fixture` is a separate test/benchmark artifact that wraps those
seed-backed fixture constructors; production TypeScript and deployment bundles
must not import it. The reference browser uses MoonBit canonical Merkle framing
with an asynchronous standard WebCrypto backend for live game checkpoints;
this does not change the generic module's experimental-crypto assurance label.
`central_replay`
decodes a bounded versioned bundle, authenticates every signed event through
the audit adapter, reconstructs the complete transcript, and only reports success
after the game checkpoint's manifest/event/public-state roots match; PvP also
requires a replay-bound `n-f` witness certificate. Current-owner listing uses a
separate bounded bundle containing an authority checkpoint, committed game
manifest, witness roster/attestations, and one authenticated inventory proof.
The central verifier binds that proof back to its verified creation receipt.
For checkpoint-level settlement, a second canonical bundle shares one signed
checkpoint and replay-witness certificate across 1--64 asset proofs. Its opaque
verified capability binds every old owner/version/head/epoch and next record in
a write-set digest; storage adapters must recheck those preconditions and open
revocations inside the committing transaction.
The Cloudflare adapter stores replay bundles separately from Queue messages and
now tests a SQLite head/history transaction, restart recovery, all three Queue
replay modes, and monotonic per-asset inventory heads. A head update requires
the exact parent, an increasing epoch, and owner/version consistency. The
reference-game Worker also keeps revisioned origin/transfer revocation heads,
quarantines active descendant listings atomically, and requires a fresh nonce
after appeal. The generic open-world path now applies the same revisioned
decision contract to its verified origin, exact current inventory head, and
historical transfers registered through a bounded authenticated lineage slice.
Each slice starts at the server-retained anchor, carries authority-bound owner
keys and dual-signed parent/version transitions, and must terminate at the
current authenticated record's cumulative lineage root. Normal listing proofs
still omit transfer history. The Worker retains at most 256 challenged
transfers per asset and blocks listings and head advancement until all open
revocations are appealed. Both decision endpoints now require a
domain-separated external-arbiter certificate, persist provisional/finalized
decision metadata, and enforce an exact timed appeal target. Device-side
observer signing persistence and key custody, transparency-head remote witness quorum, Merkle
pruning beyond the hard retention cap, player-local persistence for the
multi-asset write set, production arbiter key rotation, and production
cryptography remain open.

`quint_asset_driver` is a verification-only adapter built on
[`mizchi/quint_connect`](https://github.com/mizchi/quint-connect-moonbit). It
generates randomized `AssetOwnershipModels.qnt` ITF traces, calls the real
MoonBit transfer/lineage predicates, and compares every observable ownership,
listing, revocation, verified-ancestor, and retention-anchor state. Fixed ITF
tests include a healthy lineage registration and a broken retention update that
must report `StateDiverged`; random traces retain the quarantine negative
control. This checks the pure policy projection, not the
Cloudflare/D1 persistence refinement.

`browser_bridge` is a smaller JavaScript boundary for the reference game's hot
path. It exposes only SHA-256 and the game-neutral `audit/merkle` root builder,
so the browser journal does not maintain a second Merkle framing algorithm.

Run the isolated checks with:

```sh
just test-game-pkg replay
just prove-game-audit
just prove-audit-core
just test-audit
moon test src/audit/merkle
moon test src/audit/authmap
just bench-game-pkg replay
just test-game-pkg open_world
just bench-game-pkg open_world
just test-game-pkg wire
just test-game-pkg crypto
just bench-game-pkg wire
just bench-game-pkg crypto
just test-game-pkg worker
just quint-connect-mbt
moon test src/x/game_audit/central_replay
just test-cf-game-audit
```
