# mizchi/bft

Byzantine-aware event authentication and verifiable checkpoint audit contracts
for [`mizchi/converge`](https://github.com/mizchi/converge).

[日本語版 / Japanese](README-ja.md)

This module is an optional companion to converge. It does not change CRDT merge
semantics. It authenticates converge events before delivery and provides
application-neutral checkpoint, Merkle/authenticated-map, quorum, durable
outbox, ACK, and retry contracts.

```text
application policy / deterministic replay
                  │
                  ▼
mizchi/bft/audit ───── checkpoint, evidence, quorum, delivery, runtime
                  │
                  ▼
mizchi/bft ─────────── authenticated converge Event adapter
                  │
                  ▼
mizchi/converge ────── CRDT and local-first synchronization
```

## Packages

| Package | Responsibility |
| --- | --- |
| `mizchi/bft` | Signed converge events, roster binding, equivocation detection, causal delivery |
| `mizchi/bft/audit` | Checkpoint cadence, retention, finality estimates, and head classification |
| `mizchi/bft/audit/merkle` | Immutable Merkle trees and inclusion proofs |
| `mizchi/bft/audit/authmap` | Deterministic authenticated map and membership/non-membership proofs |
| `mizchi/bft/audit/layered` | Watermark-driven event → micro → macro checkpoints |
| `mizchi/bft/audit/quorum` | Domain-separated authenticated vote collection |
| `mizchi/bft/audit/runtime` | Atomic seal/outbox/ACK and peer retry contracts |
| `mizchi/bft/x/game_audit/*` | Experimental PvE, PvP, open-world, inventory, and marketplace policies |

The reusable packages verify authenticated history and evidence. They do not
prove that an input came from a human, prevent aimbots or wallhacks, establish
Sybil resistance, or decide whether a game action is legal. Those properties
belong to the application replay kernel and deployment policy.

## Development

```sh
just check-all
just test
just prove
just tla-check
just tla-counterexamples
```

The TLA+ models cover checkpoint delivery and witness quorum interleavings.
MoonBit proof files cover pure policy, head, seal, and vote-merge invariants.
See [docs/README.md](docs/README.md) for the contract and research index.

## License

Apache-2.0
