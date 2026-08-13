# Cloudflare game-audit infrastructure

This package connects the versioned CBOR codecs, SHA-256/Ed25519 verification,
proved classifiers, and deterministic game kernels under `src/x/game_audit` to
SQLite-backed Cloudflare Durable Objects. It is a reference implementation and
evaluation environment, not a production-security certification.

## Browser reference game

`web/` contains **Audit Survivors**, a vertical slice that exercises the audit
stack as a game:

- Vampire Survivors-style immediate movement and automatic attacks;
- FF14/Splatoon-style circular telegraphs that expose their resolve tick;
- Diablo-style deterministic drops derived from a committed seed and kill
  history;
- provisional local items that are immediately usable but cannot be listed on
  the marketplace until authority verification succeeds.

```sh
# Serve the static game and Worker API together at http://127.0.0.1:8787
pnpm dev

# Hot-reload browser assets only; start the API separately
pnpm web:dev
```

The simulation kernel is a pure integer state transition at 30 ticks per
second. Rendering alone interpolates with `requestAnimationFrame`. The browser
builds a MoonBit Merkle micro-checkpoint every 30 leaves and stores the leaf
transcript plus game state at complete boundaries in IndexedDB. Reload verifies
the chain, roots, and state and returns to the last complete checkpoint rather
than a partial segment.

Only sealed segments containing drops are submitted to
`game-item-verifications`. The Worker replays the same kernel and returns an
authority receipt. Later epochs backfill one-second segments since the last
authority ACK. A run-specific Ed25519 public key is committed by genesis; item
settlement and listings require the corresponding owner signature.

Transfers require the old owner's handoff and new owner's acceptance over the
same previous head and advance the per-asset owner version by exactly one in a
SQLite transaction. Only the current owner may list. Active listings block
transfer. A signed cancellation restores transferability while preserving
listing history and preventing nonce replay; intentional relisting requires a
fresh nonce.

External-arbiter certificates can revoke or restore an origin receipt or an
accepted transfer under a revision CAS. An unresolved revocation blocks every
descendant listing and transfer and atomically quarantines an active listing.
Appeal never revives a quarantined nonce. See the
[reference-game design](../../docs/reference-hack-and-slash-game-ja.md) for the
gameplay and UX rationale.

UI requests, observations, and locator constraints for
[VLMKit](https://mizchi.github.io/vlmkit/) live in `specs/`. With an LLM provider
configured:

```sh
pnpm ui:plan
pnpm ui:generate
pnpm ui:lineage-plan
pnpm ui:lineage-generate
pnpm test:e2e
```

## Deployment patterns

| Mode | Coordination unit | Peer validation | Central escalation |
| --- | --- | --- | --- |
| 1:N PvE / dungeon | `pve:<encounter>` | Authority events and participant samples | High-value outcome or challenge |
| N:N adversarial PvP | `pvp:<match>` | Cross-team witnesses and public state | Fork or dispute |
| Irregular open world | `open:<encounter>` | Interest-group registration observers | Sample, challenge, or marketplace settlement |

One Durable Object serializes one coordination unit. Independent matches and
encounters use separate objects and scale horizontally. Authority key, log
session, and initial epoch/parent are fixed once through the control plane;
only exact configuration retry is accepted. This prevents a correctly signed
old head from initializing a fresh object as a rollback.

Anchor submission follows this boundary:

```text
bounded JSON/hex
  -> MoonBit canonical CBOR preflight
  -> SHA-256 + Ed25519 + exact membership capability
  -> proved MoonBit head classification
  -> SQLite transactionSync(history + head or fork evidence)
  -> hibernatable WebSocket notification
```

The Worker is not a frame-rate combat authority. It persists and settles
compact authenticated heads, stores fork/gap evidence, and invokes expensive
transcript replay only for the configured escalation paths.

## Durable observer reserve-before-sign

Open-world registration observers use
`src/open-world-observer-signing-store.ts`. The store binds one observer ID and
signer public key to a SQLite ledger containing:

- metadata and monotonic reservation sequence;
- authoritative `(audit plan, registration slot) -> encounter digest`
  reservations;
- an authenticated-map root/size snapshot;
- bounded diagnostic conflict attempts.

A new slot and its sequence commit in one `transactionSync` before a separate
signer is callable. Exact retry is reusable. A different digest for an existing
slot is rejected before signing and leaves root/size unchanged. Reservations
have no per-row deletion path because deleting one would permit double signing.
Only old unprotected diagnostic conflict attempts may be pruned.

The store restores after Durable Object eviction, can require exact trusted
`(observer_id, signer_key, root, size)` equality, rejects empty/stale/foreign
anchors, and fails closed on incompatible schema or corrupted key binding.
Configuration, reservation, and snapshot routes are internal-only Durable
Object RPCs; the outer Worker strips `x-audit-internal` from public requests.
The RPC never accepts a private key. External signer custody remains a separate
boundary.

The matching Quint model checks durable reservation, signer failure, crash,
restart, exact retry, and conflict refusal. Its deliberately volatile Red model
produces reservation-loss and double-signing counterexamples.

Run the local workerd benchmark with:

```sh
pnpm run bench:observer-signing-store
```

Defaults are 1, 64, 256, and 1,024 reservations, three iterations each.
Override with `AUDIT_OBSERVER_SIGNING_BENCH_SIZES` and
`AUDIT_OBSERVER_SIGNING_BENCH_ITERATIONS`. The benchmark reports reservation
transaction latency, checkpoint-time Merkle snapshot rebuild latency, and
SQLite growth. The recorded 2026-08-13 artifact is in
[`benchmarks/observer-signing-store-local-2026-08-13.json`](./benchmarks/observer-signing-store-local-2026-08-13.json).

## Checkpoint runtime and delivery

The generic runtime fixes a boundary, initial head, required destinations, and
outbox capacity. MoonBit verifies `TrustedEpochClosure` and returns an opaque
`AtomicCheckpointSealPlan`. One SQLite transaction applies history, head CAS,
every destination's pending outbox, and closure consumption. Fault injection at
each write boundary rolls the whole transaction back; a successful commit is
restored as a complete state after object eviction.

Control-plane configuration pre-provisions every destination Durable Object
with authority, boundary, destination identity, initial epoch, and initial
digest. Seal fails closed until every destination is provisioned. Receivers
never derive configuration from the first untrusted job.

After seal, the source claims each pending outbox entry under a 30-second lease
and sends an internal RPC directly to the destination. Entries use a canonical
envelope and deterministic boundary/destination/epoch/digest idempotency key.
An ACK passes an opaque MoonBit gate for authority, boundary, epoch, digest, and
`Accepted`/`Duplicate` before becoming an acknowledged tombstone. If the process
stops before ACK, a Durable Object alarm retries the oldest entry after lease
expiry. Destination history lookup precedes head comparison, so a commit whose
ACK was lost recovers as a historical `Duplicate`.

The Queue checkpoint consumer remains for compatibility and deferred fault
tests. It rechecks the complete job against the source's durable outbox before
mutating a receiver. `REPLAY_QUEUE` is reserved for central transcript replay on
the normal path.

## Witness collection

An administrator creates a collection with a producer-signed exact statement
and provisioned witness roster. Peers publicly pull that statement and submit
Ed25519 approvals. The public POST authenticates roster keys rather than an
administrator token.

- Exact approval retry is idempotent.
- Unknown and invalid signatures make no state change.
- A conflicting approval becomes evidence only when the conflicting signature
  is itself valid.
- Only a distinct roster quorum before deadline becomes `ready`.
- Expiry means pending/expired evidence, not proof of cheating.

Public approval routes derive a source bucket from Cloudflare's
`CF-Connecting-IP` and a server-side HMAC key. Raw addresses are not stored.
Client-provided internal bucket headers are stripped. This isolates one source
with a fixed window but does not solve botnets, address churn, large NATs, or
global fairness.

## Evidence cases and source resolution

A signed active evidence hold may open an investigation case through a public
reference-game endpoint. Case creation stores investigation state only; it
does not change asset eligibility or listings. The hold's reference digest
domain-separates scope, unit, asset/ancestor, local boundary, source,
epoch/checkpoint, and active decision.

An exact duplicate returns the same `case_id`. Retargeting, wrong checkpoint or
epoch, an unconfigured source, bad signature, or resolved envelope is refused
without mutation. The public route consumes the same source-bucket rate limit
as other reference-game verification routes.

The arbiter may uphold through a version-2 lineage decision or dismiss through
an exact dismissal certificate. Dismissal commits case history and
`disposition: dismissed` in one transaction and never changes lineage or
listing state. `resolution_id` identifies the upheld decision or dismissal;
`decision_id` is present only for uphold.

Closing a case does not resolve the player-local hold. Resolution uses a
separate source relay:

1. The Worker stores a resolution notice containing the arbiter certificate.
2. The evidence source polls its next notice, re-verifies the exact case,
   reference, and certificate, and signs a resolve envelope at
   `source_cursor + 1`.
3. The Worker verifies source roster, exact case/reference/resolution, next
   sequence, and previous digest and atomically advances the inbox cursor.
4. The player-local poller accepts the signed hash-chain envelope before
   changing the hold to resolved.

The Worker never holds the source private key. Source outage, unsigned data, a
stale cursor, or a conflict leaves both notice and active hold in place. A
production source scheduler, credential-authenticated polling, and key custody
remain pending.

## Lineage decisions and marketplace state

Lineage decisions use an administrator-token control boundary plus an external
arbiter signature. Each ancestor has a revision CAS. Canonical exact retry is a
duplicate; stale revisions, unchanged status, unknown arbiters, invalid or
expired certificates, wrong appeal target, and late appeal are refused.

Reference-game status exposes:

- `provisional`: no verified origin yet;
- `finalized`: verified with no unresolved revocation;
- `quarantined`: at least one revocation still inside its appeal window;
- `expired`: the appeal window closed while the asset remains fail-closed.

The browser refreshes this status explicitly rather than polling continuously.
Responses are `no-store`. The UI is observational only: marketplace admission
always rechecks authority state, so a stale `finalized` display cannot bypass a
later revocation.

The generic open-world inventory uses the same revision and lineage-cleanliness
contract. Verified origin and current authenticated inventory head are directly
adjudicable. Intermediate transfer revocation requires a bounded authenticated
lineage slice from the retained anchor through the current cumulative lineage
root. Any unresolved decision blocks listing and the next head update.

## Local validation

```sh
pnpm install
pnpm run build:all
pnpm run typecheck
pnpm run test:worker
pnpm run test:assets
pnpm run test:e2e
pnpm run deploy:dry
```

The repository-level gates also run:

```sh
moon test
moon check
just formal-check
moon info && moon fmt
```

Run the larger local Worker benchmark against a development server in another
terminal:

```sh
pnpm exec wrangler dev --port 8787 \
  --var ADMIN_TOKEN:test-admin-token \
  --var WITNESS_SOURCE_BUCKET_KEY:test-source-bucket-key-000000000000

pnpm bench:local
pnpm bench:witness
```

`bench:witness` injects hostile source traffic before collecting three valid
peer approvals and sealing from the collection. Runs, dispatch mode, and ACK
timeout are configurable through the `AUDIT_WITNESS_*` environment variables.

## Deployment and remote measurement

Use `pnpm run deploy`; `pnpm deploy` is a reserved pnpm command.

```sh
pnpm run deploy
pnpm exec wrangler secret put ADMIN_TOKEN
pnpm exec wrangler secret put WITNESS_SOURCE_BUCKET_KEY
pnpm exec wrangler secret put LINEAGE_ARBITER_ROSTER
pnpm exec wrangler secret put EVIDENCE_HOLD_SOURCE_ROSTER

AUDIT_BASE_URL=https://<worker>.workers.dev \
AUDIT_ADMIN_TOKEN=<token> \
AUDIT_LOCATION_HINT=apac-ne \
pnpm bench

AUDIT_BASE_URL=https://<worker>.workers.dev \
AUDIT_ADMIN_TOKEN=<token> \
AUDIT_LOCATION_HINT=apac-ne \
AUDIT_WITNESS_BENCH_SOURCE_MODE=single-egress \
AUDIT_WITNESS_BENCH_APPROVAL_MODE=parallel \
pnpm bench:witness
```

Location hints apply only to first access and are best effort. Always use a new
unit ID when comparing locations because an existing Durable Object does not
move.

Historical benchmark JSON is retained under `benchmarks/`. These are
environment-specific engineering observations, not regional SLAs. The local
Queue replay baseline is dominated by its roughly one-second batch timeout;
Queue replay is not on the presentation path. Remote results were collected
from a single Tokyo client and do not represent all clients or regions.

## Formal reconciliation: delivery is not replay verification

Queue delivery and deterministic replay success are separate claims. A replay
job becomes `verified` only when all required artifacts are present and match:

```text
authority anchor
  + complete transcript
  + checkpoint link
  + complete mode-specific kernel replay
  + replay-derived result matching the claimed result
```

The Worker stores an anchor-only job as awaiting transcript. It cannot classify
that job as successful merely because Queue delivery or checkpoint signature
verification succeeded. PvP additionally requires the exact replay-bound
`n-f` witness certificate. Open-world v2 additionally requires the signed plan,
signed seal, delayed seed, observer registration quorum, eligible inclusion,
and independent transparency publication of the plan and seal link.

## Guarantee boundary

- SQLite transactions atomically update head/history or fork evidence.
- Checkpoint seal atomically updates history, local head, required outbox rows,
  and closure consumption.
- Required destinations are fixed by runtime configuration and cannot shrink on
  retry to fake a complete commit.
- Injected intermediate faults leave no partial state; successful commits
  survive actor abort and eviction.
- Initial heads must match the administrator-provisioned epoch and parent.
- Raw envelopes and successful wire decoding never advance state without the
  relevant MoonBit capability and concrete cryptographic verification.
- Producer and witness authentication is checked at source seal and receiver
  mutation boundaries.
- Remote witness pull/sign/submit and direct authority ACK have local and remote
  reference coverage. Outbound push, global/roster-aware fair queues, device
  retry, and botnet/NAT behavior remain deployment work.
- The observer signing store is crash-safe in the Cloudflare reference.
  Device/mobile persistence, external signer custody, and at-rest encryption
  remain deployment work.
- Browser run keys are non-extractable WebCrypto `CryptoKey` values persisted in
  IndexedDB. This does not prove resistance to XSS or device compromise.
- `experimental_crypto` remains unaudited. The `production` runtime profile
  fails closed unless a production-capable backend is actually connected.
- Current game kernels do not model complete commercial PvP projectile/
  visibility rules or every raid mechanic.
- Local workerd latency and remote single-client samples are not production
  cost, capacity, or availability guarantees.

Relevant Cloudflare documentation:

- [SQLite-backed Durable Object Storage](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/)
- [Durable Object WebSocket hibernation](https://developers.cloudflare.com/durable-objects/best-practices/websockets/)
- [Cloudflare Queues delivery guarantees](https://developers.cloudflare.com/queues/reference/delivery-guarantees/)
- [Cloudflare Queues batching and retries](https://developers.cloudflare.com/queues/configuration/batching-retries/)
- [Workers limits](https://developers.cloudflare.com/workers/platform/limits/)
