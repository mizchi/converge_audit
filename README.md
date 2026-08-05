# mizchi/bft

Byzantine-aware event authentication and verifiable checkpoint auditing for
the [`mizchi/converge`](https://github.com/mizchi/converge) local-first CRDT.

[日本語版 / Japanese](README-ja.md)

## Goal

The long-term goal is to make MMO-like online games practical for an individual
developer or a small team.

Running every player through a large authoritative server at frame rate is often
not financially or operationally realistic. Pure P2P is not sufficient either:
modified clients can hide logs, equivocate, double-issue assets, or collude.

This project splits the responsibilities instead:

```text
real-time input and presentation
  client prediction; never wait for central settlement
                │
                ▼
player-local DB
  persist signed events and audit state
                │
                ▼
peers in the same encounter / match / interest group
  adversarially cross-check events, roots, and signatures
                │
                ▼
checkpoint + witness certificate
  send compact commitments on the normal path
                │
                ▼
small central authority
  accept checkpoints and settle rewards, rank, and assets
                │
       only on sample / challenge / fork / high value
                ▼
deterministic replay
  fetch the required transcript or proof and verify again
```

The goal is not to eliminate central servers. Identity/key provisioning,
deployment policy, final checkpoints, high-value outcomes, and marketplaces
remain central trust boundaries. The target is to avoid continuously processing,
storing, and replaying every frame of every player on that server.

## What this library does

`mizchi/bft` provides mechanisms for constructing verifiable histories; it does
not define the game rules themselves.

- Bind converge events to a session, roster, public key, digest, and signature.
- Detect equivocation when one player counter identifies different events.
- Buffer causal dependencies and expose only authenticated events when ready.
- Commit event sets with Merkle trees and authenticated maps.
- Build arrival-order-independent event → micro → macro checkpoints.
- Collect distinct, authenticated witness votes with convergent duplicate and
  equivocation handling.
- Fail closed when classifying exact parents, duplicates, gaps, and forks.
- Specify atomic seal, durable outbox, ACK, lease, retry, and crash recovery
  contracts.

The normal central-server payload is intended to approach a small set of roots,
metadata, and witness signatures that does not grow with the event count, rather
than the full event log. Merkle proofs localize disagreement in `O(log n)`. Full
replay is reserved for sampling, challenges, forks, high-value rewards, and
marketplaces. Actual cost still depends on witness count, interest-group size,
checkpoint cadence, retention, and the game kernel.

A checkpoint alone cannot be replayed. Selected peers must retain the transcript
until finality or the dispute deadline. The protocol therefore makes retention
responsibility and fail-closed handling of unavailable transcripts explicit in
exchange for reducing continuous central storage.

This is neither a blockchain nor a protocol that globally orders the entire
world. Independent operations may reorder and converge as CRDT data. The
application-specific deterministic kernel handles only order that changes game
results.

## Packages

| Package | Responsibility |
| --- | --- |
| `mizchi/bft` | Signed converge events, roster binding, equivocation detection, causal delivery |
| `mizchi/bft/audit` | Checkpoint cadence, retention, finality estimates, and head classification |
| `mizchi/bft/audit/merkle` | Immutable Merkle trees and inclusion proofs |
| `mizchi/bft/audit/authmap` | Deterministic authenticated maps and membership/non-membership proofs |
| `mizchi/bft/audit/layered` | Watermark-driven event → micro → macro checkpoints |
| `mizchi/bft/audit/quorum` | Domain-separated authenticated vote collection |
| `mizchi/bft/audit/delivery_auth` | Producer signatures and distinct-witness delivery authentication |
| `mizchi/bft/audit/runtime` | Atomic seal/outbox/ACK, local store, and peer retry contracts |
| `mizchi/bft/x/game_audit/*` | Experimental PvE, PvP, open-world, inventory, and marketplace policies and kernels |

`src/audit` treats application payloads as opaque digests. Witness selection,
quorum thresholds, and the legality of attacks, dodges, and loot belong to
`src/x/game_audit` or to the actual game.

## What the examples are trying to prove

### `examples/node-audit-runtime`

This is a reference player-local database and peer transport. It maps events,
equivocations, checkpoints, heads, closures, outbox entries, ACKs, peer routes,
leases, retries, and fork evidence into one Node.js 24 `node:sqlite` transaction
domain.

It asks whether one player client can retain its own audit state, use bounded
fanout to multiple peers, and preserve the checkpoint protocol across crashes
and restarts. A production mobile database, device keystore, and
WebTransport/WebSocket transport are not connected yet.

### `examples/cf-game-audit`

This is a reference central settlement service for low-frequency checkpoints.
It uses Cloudflare Workers, SQLite-backed Durable Objects, and Queues. Normal
checkpoints go directly to an authority. Queue-backed transcript replay is
reserved for samples, challenges, forks, high-value outcomes, and marketplaces.

| Pattern | Peer auditing target | Central settlement target |
| --- | --- | --- |
| 1:N PvE / dungeon | Authority events, participant samples, telegraphs, input receipts | Whether clears and loot follow from a valid event sequence |
| N:N PvP | Cross-team witnesses, public state, per-slot equivocation | Referee checkpoint, score, and rank results |
| Irregular open world | Nearby observers, delayed sampling, eligible-set seals | Sampled/high-value encounters and asset creation |
| Marketplace | Origin receipt, current-owner head, authenticated-map proof | Only legitimately created and transferred assets may be listed |

It is not a finished MMO server. It is an infrastructure prototype for testing
whether a small authority can accept compact checkpoints without receiving every
frame, then durably and idempotently escalate suspicious results to replay.

## Formal verification strategy

Each claim uses the smallest appropriate verifier.

| Subject | Method | Current checked scope |
| --- | --- | --- |
| Cadence, retention, heads, seals, vote merge | MoonBit proof → Why3/Z3 | Pure predicates and mathematical integers; 200 goals |
| Crash, drop, retry, bounded outbox, witness quorum | TLA+ / TLC | Finite actor/epoch safety and liveness; four healthy configurations without counterexamples |
| Whether guards are load-bearing | Deliberately broken TLA+ configurations | All seven produce the expected counterexample |
| SQLite/DO/Queue/HTTP mapping | Integration tests and fault injection | Atomic rollback, restart, duplicate, fork, and ACK-loss behavior |
| Communication cost and latency | Local and remote benchmarks | Environment-specific engineering baselines, not general SLAs |

Formal tools decide only properties written into their models. Cryptographic
verification is abstracted to a Boolean in TLA+, and MoonBit proofs do not prove
hash collision resistance, signature unforgeability, or concrete disk/network
implementations.

## Non-goals and unproved assumptions

- Proving that an input came from a human.
- Eliminating aimbots, wallhacks, or external perception assistance.
- Providing Sybil resistance or tolerating arbitrary witness collusion.
- Proving completeness of an application-specific replay kernel.
- Claiming production security for the unaudited `experimental_crypto` backend.
- Guaranteeing target cost or latency for every region and load profile.

These require device security, identity/roster policy, audited cryptography,
game design, playtesting, and operational monitoring. Missing certificates and
timeouts should normally hold a result or escalate it to central replay rather
than immediately label a player as cheating.

## Development

```sh
just check-all
just test
just prove
just tla-check
just tla-counterexamples
just test-node-audit-runtime
just test-cf-game-audit
```

Start with [docs/README.md](docs/README.md). See the
[game-audit overview](docs/game-audit-overview-ja.md),
[telegraph and real-time game design](docs/telegraph-game-design-ja.md), and
[selective open-world auditing](docs/open-world-audit-ja.md) for the detailed
design.

## License

Apache-2.0
