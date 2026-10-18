# mizchi/converge_audit task runner

# Check types
check:
  moon check

# Check all targets
check-all:
  moon check --target all

# Run all tests
test:
  moon test

# Run tests with verbose output
test-v:
  moon test -v

# Update snapshot tests
test-update:
  moon test -u

# Run tests for a specific package
test-pkg pkg:
  moon test src/{{pkg}}

# Run tests for an experimental game-audit package
test-game-pkg pkg:
  moon test src/x/game_audit/{{pkg}}

# Run the generalized checkpoint-audit contract tests
test-audit:
  moon test src/audit

# Run the watermark-driven layered checkpoint tests
test-audit-layered:
  moon test src/audit/layered

# Run the persistence/transport runtime contract tests
test-audit-runtime:
  moon test src/audit/runtime

# Prevent the reusable audit layer from depending on the game application
check-audit-boundary:
  #!/usr/bin/env sh
  set -eu
  if rg -n '"mizchi/converge_audit/x/game_audit' src/audit --glob 'moon.pkg'; then
    echo 'src/audit must not depend on src/x/game_audit' >&2
    exit 1
  fi

# Format code
fmt:
  moon fmt

# Generate type info
info:
  moon info

# Prove every proof-enabled package explicitly. Whole-module `moon prove`
# currently asks WhyML to translate non-proof dependency types as well.
prove:
  nix develop path:. --command moon prove src/audit
  nix develop path:. --command moon prove src/audit/key_lifecycle
  nix develop path:. --command moon prove src/audit/quorum/vote
  nix develop path:. --command moon prove src/x/game_audit/audit

# Check the experimental Lean arbitration model and its positive/negative examples
prove-lean:
  cd formal/lean && lake build

# Prove the multiplayer audit policy only
prove-game-audit:
  nix develop path:. --command moon prove src/x/game_audit/audit

# Prove the generalized checkpoint-audit contracts only
prove-audit-core:
  nix develop path:. --command moon prove src/audit
  nix develop path:. --command moon prove src/audit/key_lifecycle
  nix develop path:. --command moon prove src/audit/quorum/vote

# Backward-compatible alias
prove-audit: prove-game-audit

# Type-check and exhaustively verify the protocol models with Quint/TLC
quint-check:
  nix develop path:. --command sh formal/quint/check.sh

# Reject model configurations outside the declared protocol contract
quint-config-contracts:
  nix develop path:. --command sh formal/quint/check-config-contracts.sh

# Run executable happy-path and guard scenarios from the Quint models
quint-scenarios:
  nix develop path:. --command sh formal/quint/check-scenarios.sh

# Replay a Quint ITF trace against the MoonBit policy and SQLite adapter
quint-mbt:
  nix develop path:. --command sh formal/quint/check-mbt.sh

# Replay a witness Quint trace against the real-crypto MoonBit authentication gate
quint-witness-mbt:
  nix develop path:. --command sh formal/quint/check-witness-mbt.sh

# Generate Quint traces and replay them in MoonBit through quint_connect
quint-connect-mbt:
  nix develop path:. --command sh formal/quint/check-quint-connect.sh

# Render reference documentation from Quint docstrings
quint-docs:
  nix develop path:. --command quint docs formal/quint/CheckpointDelivery.qnt
  nix develop path:. --command quint docs formal/quint/WitnessQuorum.qnt
  nix develop path:. --command quint docs formal/quint/AssetOwnership.qnt
  nix develop path:. --command quint docs formal/quint/LineageAppeal.qnt
  nix develop path:. --command quint docs formal/quint/EvidenceLineageCase.qnt
  nix develop path:. --command quint docs formal/quint/KeyLifecycle.qnt
  nix develop path:. --command quint docs formal/quint/KeyAuthenticationMigration.qnt
  nix develop path:. --command quint docs formal/quint/ObserverSigningStore.qnt
  nix develop path:. --command quint docs formal/quint/EvidenceResolutionRelay.qnt

# Confirm that all load-bearing Quint guards produce counterexamples
quint-counterexamples:
  nix develop path:. --command sh formal/quint/check-counterexamples.sh

# Run a bounded Apalache smoke check; this is not the exhaustive parity gate
quint-apalache-smoke:
  nix develop path:. --command sh formal/quint/check-apalache-smoke.sh

# Verify every authoritative protocol model and load-bearing guard
formal-check: quint-config-contracts quint-scenarios quint-mbt quint-witness-mbt quint-connect-mbt quint-check quint-counterexamples

# Build WASM-GC
build:
  moon build --target wasm-gc

# Run all benchmarks
bench:
  moon bench

# Run benchmarks for a specific package
bench-pkg pkg:
  moon bench -p mizchi/converge_audit/{{pkg}}

# Run benchmarks for an experimental game-audit package
bench-game-pkg pkg:
  moon bench -p mizchi/converge_audit/x/game_audit/{{pkg}}

# Benchmark event -> micro -> macro checkpoint sealing
bench-audit-layered:
  moon bench -p mizchi/converge_audit/audit/layered --release

# Run the Cloudflare workerd/Durable Object integration tests
test-cf-game-audit:
  pnpm --dir examples/cf-game-audit test

# Start the browser game and local Worker/DO API together
dev-cf-game:
  pnpm --dir examples/cf-game-audit dev

# Build only the browser game static assets
build-cf-game-web:
  pnpm --dir examples/cf-game-audit web:build

# Type-check the Cloudflare game-audit adapter
check-cf-game-audit:
  pnpm --dir examples/cf-game-audit typecheck

# Type-check the Node 24 player-local SQLite reference adapter
check-node-audit-runtime:
  pnpm --dir examples/node-audit-runtime typecheck

# Test player-local SQLite restart and transaction atomicity
test-node-audit-runtime:
  pnpm --dir examples/node-audit-runtime test

# Verify bounded raw-payload storage, restart, rollback, and real browser tabs
test-player-local-payload:
  moon build --target js --release
  pnpm --dir examples/cf-game-audit exec node --test test/bounded-payload-queue.node-test.ts test/payload-pool.node-test.ts test/payload-reservation.node-test.ts test/payload-closure.node-test.ts
  pnpm --dir examples/cf-game-audit test:payload-browser

# Global/per-queue budgets, bounded metadata, rollback and actual browser tabs
test-payload-pool:
  moon build --target js --release
  pnpm --dir examples/cf-game-audit exec node --test test/payload-pool.node-test.ts test/payload-reservation.node-test.ts test/payload-closure.node-test.ts test/encounter-lifecycle.node-test.ts test/encounter-api.node-test.ts
  pnpm --dir examples/cf-game-audit test:payload-browser

# Actual Chromium IndexedDB transactions; crypto and network excluded
bench-payload-pool:
  moon build --target js --release
  pnpm --dir examples/cf-game-audit exec playwright test --config playwright.payload-bench.config.ts

# One bounded encounter from local logs to market receipt and authorized pruning
test-encounter-lifecycle:
  moon build --target js --release
  pnpm --dir examples/cf-game-audit exec node --test test/encounter-lifecycle.node-test.ts test/encounter-api.node-test.ts test/payload-reservation.node-test.ts test/payload-closure.node-test.ts test/termination-policy.node-test.ts
  pnpm --dir examples/cf-game-audit exec vitest run test/encounter-ledger.test.ts test/encounter-api.test.ts
  pnpm --dir examples/cf-game-audit test:payload-browser

# Local service/crypto cost; excludes network, disk fsync and Worker scheduling
bench-encounter:
  pnpm --dir examples/cf-game-audit exec node scripts/bench-encounter.ts

# Bounded receipt aggregation and original-receipt lookup; no network or fsync
bench-encounter-inventory:
  pnpm --dir examples/cf-game-audit exec node scripts/bench-encounter-inventory.ts

# Bounded epoch rollover with real origins and released archive tombstones
bench-encounter-generation:
  pnpm --dir examples/cf-game-audit exec node scripts/bench-encounter-generation.ts

# Signed forfeiture recovery release and repeated generations with no origin growth
bench-encounter-recovery:
  pnpm --dir examples/cf-game-audit exec node scripts/bench-encounter-recovery.ts

# Batched empty-receipt retirement, merged ordinal ranges and verified v2 heads
bench-encounter-empty-inventory:
  pnpm --dir examples/cf-game-audit exec node scripts/bench-encounter-empty-inventory.ts

# Existing signed case service -> encounter market/retention, multi-case and CAS
test-encounter-cases:
  moon build --target js --release
  pnpm --dir examples/cf-game-audit exec node --test test/encounter-evidence.node-test.ts test/encounter-lifecycle.node-test.ts test/encounter-api.node-test.ts
  pnpm --dir examples/cf-game-audit exec vitest run test/encounter-evidence.test.ts test/encounter-ledger.test.ts test/encounter-api.test.ts

# Signed archive custody, local release, retained cases and real browser handoff
test-encounter-archive:
  moon build --target js --release
  pnpm --dir examples/cf-game-audit exec node --test test/encounter-archive.node-test.ts test/encounter-session.node-test.ts
  pnpm --dir examples/cf-game-audit exec vitest run test/encounter-evidence.test.ts
  pnpm --dir examples/cf-game-audit exec playwright test e2e/encounter-session.spec.ts --grep 'archive handoff'

# Sixteen-receipt compaction, durable recovery, paged inventory and old-item market
test-encounter-inventory:
  moon build --target js --release
  pnpm --dir examples/cf-game-audit exec node --test test/encounter-session.node-test.ts test/encounter-session-store.node-test.ts
  pnpm --dir examples/cf-game-audit exec vitest run test/encounter-evidence.test.ts
  pnpm --dir examples/cf-game-audit exec playwright test e2e/encounter-session.spec.ts --grep 'receipt compaction'

# Epoch rollover, stale requests, shared-transaction rollback and 1025 real games
test-encounter-generation:
  moon build --target js --release
  pnpm --dir examples/cf-game-audit exec node --test test/encounter-generation.node-test.ts test/encounter-session.node-test.ts test/encounter-archive.node-test.ts
  pnpm --dir examples/cf-game-audit exec vitest run test/encounter-generation.test.ts test/encounter-evidence.test.ts

# Owner release, lost responses, deletion without tombstones, and real DO eviction
test-encounter-recovery:
  moon build --target js --release
  pnpm --dir examples/cf-game-audit exec node --test test/encounter-generation.node-test.ts test/encounter-session.node-test.ts
  pnpm --dir examples/cf-game-audit exec vitest run test/encounter-generation.test.ts

# Sparse inventory, durable client intent, exact retry after deletion and DO eviction
test-encounter-empty-inventory:
  moon build --target js --release
  pnpm --dir examples/cf-game-audit exec node --test test/encounter-empty-inventory.node-test.ts test/encounter-session.node-test.ts
  pnpm --dir examples/cf-game-audit exec vitest run test/encounter-empty-inventory.test.ts

# Default game UI: bounded control state, public preview, recovery and real Worker
test-encounter-ui:
  moon build --target js --release
  pnpm --dir examples/cf-game-audit exec node --test test/encounter-session.node-test.ts test/encounter-session-store.node-test.ts test/encounter-preview.node-test.ts test/local-encounter-config.node-test.ts test/encounter-api.node-test.ts
  pnpm --dir examples/cf-game-audit test:e2e

# Validate the deploy bundle without mutating Cloudflare
build-cf-game-audit:
  pnpm --dir examples/cf-game-audit deploy:dry

# Validate the independently deployed evidence-source relay bundle
build-cf-evidence-source-relay:
  pnpm --dir examples/cf-game-audit deploy:source-relay:dry

# Validate the non-public verification-key signer bundle
build-cf-key-signer:
  pnpm --dir examples/cf-game-audit deploy:key-signer:dry

# Pre-release checks
pre-release: fmt info check check-audit-boundary test build prove formal-check check-node-audit-runtime test-node-audit-runtime check-cf-game-audit test-cf-game-audit build-cf-game-audit build-cf-evidence-source-relay build-cf-key-signer
