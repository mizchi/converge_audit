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
- [Low-frequency arbitration and Lean model](./local-first-arbitration-lean-ja.md)
  - Experimental optimistic arbitration, one-step fraud localization, watcher
    assumptions, sampling limits, and the standalone Lean research package.
- [Marketplace admission costs and log boundaries](./market-admission-cost-ja.md)
  - Validated checkpoints as replay boundaries, item provenance and ownership,
    bounded pending history, retention, and local verification measurements.
- [Gameplay chronology and limits on search](./gameplay-chronology-ja.md)
  - External commit receipts, delayed challenges, single-use attempts, limits of
    VDFs and software-only execution restrictions, and Lean chronology proofs.
- [Private views and bounded IndexedDB payloads](./private-views-and-bounded-storage-ja.md)
  - Limits of preventing public-information prediction, secret-state distribution,
    byte/item budgets, authenticated prefix deletion, and executable queue tests.
- [One encounter from recording to authorized pruning](./encounter-lifecycle-ja.md)
  - A bounded integrated path with delayed loot, deterministic replay, market
    admission, real signed prune grants, Lean obligations, and local measurements.
- [Shared replay-payload pool](./shared-payload-pool-ja.md)
  - Global and per-queue budgets, bounded scope metadata, atomic accounting,
    stale-generation refusal, and Chromium transaction measurements.
- [Pre-play reservation and authenticated encounter HTTP](./encounter-http-and-reservation-ja.md)
  - Whole-log capacity reservation, signed starts and tickets, bounded HTTP,
    durable authorization, Lean credit invariants, and deployment boundaries.
- [Terminating interrupted encounters](./encounter-termination-ja.md)
  - Owner-authorized abandonment, missed-start expiry, retained terminal evidence,
    atomic payload/credit release, and proofs against minting after termination.
- [Bounded encounters in the default game screen](./encounter-ui-ja.md)
  - Authorized starts, hidden-loot preview, bounded session receipts, interrupted
    recovery, real Worker browser tests, and Lean recovery capabilities.
- [Encounter case aggregation and retention fencing](./encounter-cases-ja.md)
  - Existing authenticated cases block market admission and deletion until every
    source resolution is durable; bounded bindings and atomic revision fences.
- [Transferring replay custody to an archive](./encounter-archive-ja.md)
  - Durable signed custody, separate local handoff and final archive release,
    bounded SQLite storage, lost acknowledgements, and availability histories.
- [Receipt compaction and paged inventory](./encounter-inventory-checkpoint-ja.md)
  - Incremental signed checkpoints, bounded client history and page cache,
    durable retry, original-receipt market admission, and measured costs.
- [Central ledger generations and archive reuse](./encounter-generations-ja.md)
  - Closed-epoch rollover, monotone authorization fences, retained original
    receipts, atomic archive reclamation, and real 1,025-encounter tests.
- [Releasing forfeited encounter recovery](./encounter-recovery-release-ja.md)
  - Owner acknowledgment, retry after deletion, generation fences without
    per-ticket tombstones, receipt preservation, and bounded collection work.
- [Empty receipts and compressed inventory ranges](./encounter-empty-inventory-ja.md)
  - Batched owner retirement, v2 checkpoints, stable ordinals, merged ranges,
    bounded sparse pages, and recovery after originals have been deleted.
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
- [PRDT replicated domain objects (mizchi/prdt)](https://github.com/mizchi/prdt)
  - Pure domain reducer + replicated finalization protocol, developed here
    and now maintained as its own MoonBit module. Its `Hasher` / `Signer` /
    `Verifier` traits mirror this repository's, so adapters are one-liners.

## Sources of truth

| Subject | Source of truth | Validation |
| --- | --- | --- |
| Public APIs and constructible capabilities | `src/**/pkg.generated.mbti` | `moon info` |
| Runtime admission and refusal behavior | `src/**/*.mbt` | `moon test`, `moon check --target all` |
| Logical predicates and invariants | `src/audit/*.mbtp`, `src/x/game_audit/audit/*.mbtp` | `just prove` |
| Experimental arbitration mathematics (not runtime refinement) | `formal/lean/ConvergeAudit/*.lean`, `formal/lean/Tests.lean` | `just prove-lean` |
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
just prove-lean
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
```

Configured proof obligations cover the generic checkpoint policy, heads,
event-time closure, ACK and atomic-seal gates, delivery authentication, vote
semilattices, central replay artifacts, public-state PvP, open-world
transparency and central verification, marketplace creation persistence,
current-owner and multi-asset inventory gates, cooldown/objective mechanics,
and raid-clear preconditions. Test counts are intentionally not frozen here;
the current `moon test` output is authoritative.
