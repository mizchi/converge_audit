# converge documentation

This directory separates the research basis, game-design constraints,
implementation contracts, and measurements for CRDT-based real-time game
auditing. Game-independent checkpoint contracts live under `src/audit/`.
Use-case-specific implementations remain in the experimental
`src/x/game_audit/` namespace.

Most detailed design documents currently have Japanese filenames and content.
This index is the English entry point; the root [README](../README.md) is the
shortest project overview.

## Reading order

- [Library boundary](./library-boundary-ja.md)
  - Separation of mechanism, policy, and game semantics; package promotion
    criteria; and explicit non-guarantees.
- [Shared MoonBit JS verification architecture](./moonbit-js-shared-verification-ja.md)
  - Client/server shared logic, bounded verification plans, WebCrypto/I/O
    adapters, and migration order.
- [Game-audit prototype overview](./game-audit-overview-ja.md)
  - Implemented modes, packages, guarantee boundary, and roadmap.
- [Game-audit requirements](./game-audit-requirements-ja.md)
  - MUST/SHOULD requirements, trust boundaries, mode-specific acceptance
    criteria, and current status.
- [Persistence and transport implementation contract](./game-audit-implementation-contract-ja.md)
  - Database relations, atomic seals, durable outboxes, ACKs, retries, gap
    recovery, and crash consistency.
- [Key lifecycle contract](./key-lifecycle-ja.md)
  - Key IDs and versions, validity windows, rotation, effective revocation,
    custody, and v1 migration.
- [Quint delivery and persistence models](../formal/quint/README.md)
  - Crash, loss, partitions, durable outboxes, exact parents, witness quorum,
    observer signing, and conditional liveness.
- [Generic checkpoint audit layer](../src/audit/README.md)
  - Cadence and retention, precision formulas, commitment adapters, heads,
    Merkle/AuthMap structures, and proof limits.
- [Research and architecture survey](./research-and-architecture-ja.md)
  - Prior work, the full architecture, 1:N and N:N differences, guarantees,
    non-guarantees, and roadmap.
- [Verifiable real-time game design](./telegraph-game-design-ja.md)
  - Telegraphs, dodge windows, client prediction, and mechanics that preserve
    responsiveness under audit constraints.
- [Cloudflare reference game: Audit Survivors](./reference-hack-and-slash-game-ja.md)
  - A deterministic 30 Hz kernel, telegraph dodging, seeded drops,
    provisional items, and the marketplace gate.
- [Public-state PvP epochs](./pvp-epoch-ja.md)
  - Simultaneous movement and attacks, score, equivocation, witness integration,
    complexity, and measurements.
- [Selective auditing for irregular encounters](./open-world-audit-ja.md)
  - Delayed sampling, Merkle anchor seals, peer finality, observer reservation,
    and the central replay budget.
- [Multiplayer checkpoint audit prototype](./game-audit-prototype.md)
  - Capability pipeline, formal verification, benchmarks, and the contract
    reconciliation ledger.
- [BFT-CRDT research summary](./bft-crdt-research.md)
  - Background limited to the CRDT/BFT layer and the current adapter boundary.
- [Experimental game-audit stack](../src/x/game_audit/README.md)
  - Responsibilities, package structure, and focused verification commands.
- [Game-audit wire protocols](./game-audit-wire-ja.md)
  - Versioned canonical CBOR, decode budgets, crypto adapters, and wire costs.
- [Cloudflare Workers evaluation](./cloudflare-game-audit-ja.md)
  - SQLite-backed Durable Object implementations and local/remote measurements.
- [Node player-local SQLite adapter](../examples/node-audit-runtime/README.md)
  - Event/equivocation storage, atomic seals, outbox/ACK state, peer leases,
    bounded HTTP fanout, and fork quarantine.
- [Player-local host contract](../examples/player-local-runtime/README.md)
  - Shared DTOs, validators, MoonBit write-set wrappers, and conformance tests
    for Node/mobile SQLite and IndexedDB.
- [PRDT replicated domain objects](./prdt-replicated-domain-ja.md)
  - MoonBit `src/prdt`: pure domain reducer + replicated finalization
    protocol, proposal/closure/committed-prefix lattices, single-authority and
    quorum finalizers, the 3-replica simulator, seeded property tests, and the
    Durable Object host in `examples/prdt`.

## Sources of truth

| Subject | Source of truth | Validation |
| --- | --- | --- |
| Public APIs and constructible capabilities | `src/**/pkg.generated.mbti` | `moon info` |
| Runtime admission and refusal behavior | `src/**/*.mbt` | `moon test`, `moon check --target all` |
| Logical predicates and invariants | `src/audit/*.mbtp`, `src/x/game_audit/audit/*.mbtp` | `just prove` |
| Finite delivery, persistence, settlement, key, and observer-signing transitions | `formal/quint/*.qnt` | `just formal-check` |
| Production runtime requirements | `docs/game-audit-implementation-contract-ja.md` | Contract tests and fault injection |
| Cryptography, durable persistence, and complete transcripts | Crypto adapters, mode-specific verifiers, Cloudflare DO/Queue | Integration and conformance tests; production audit still pending |
| Performance | The artifact produced by the relevant benchmark run | `just bench` or the package-specific benchmark |
| Fun and perceptual fairness | Playtests and telemetry | Design hypothesis only today |

If documentation and code disagree, do not silently weaken a proved contract.
Fix the implementation, or record the smallest counterexample and unresolved
decision in the reconciliation ledger.

## Validation commands

```sh
just check-all
just check-audit-boundary
just test
just build
just prove
just test-audit-runtime
just formal-check
just quint-apalache-smoke
just test-audit-layered
just bench-audit-layered
just bench-game-pkg replay
just bench-game-pkg open_world
just test-cf-game-audit
just check-cf-game-audit
just test-node-audit-runtime
just check-node-audit-runtime
just test-prdt
just check-prdt-boundary
just test-prdt-worker
```

Configured proof obligations cover the generic checkpoint policy, heads,
event-time closure, ACK and atomic-seal gates, delivery authentication, vote
semilattices, central replay artifacts, public-state PvP, open-world
transparency and central verification, marketplace creation persistence,
current-owner and multi-asset inventory gates, cooldown/objective mechanics,
and raid-clear preconditions. Test counts are intentionally not frozen here;
the current `moon test` output is authoritative.
