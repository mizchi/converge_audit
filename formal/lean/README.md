# Lean arbitration research model

This package checks the mathematical core of the proposed local-first game
arbitration algorithm. It does not implement a network dispute protocol or
change the existing MoonBit/Quint contracts.

Read the [Japanese design and assumptions](../../docs/local-first-arbitration-lean-ja.md).

```sh
# From the repository root; elan installs the pinned toolchain if needed.
just prove-lean
```

Lean is pinned in `lean-toolchain`; there are no Mathlib or third-party
dependencies. `lake build` checks both `ConvergeAudit` and `Tests`, treating
warnings (including `sorry`) as errors. Existing `just prove` continues to run
the MoonBit/Why3 contracts; run both commands when modifying both proof layers.
Implicit undeclared variables are also disabled, so misspelled contract names
cannot silently introduce new parameters.
The current GitHub workflow does not yet run this experimental Lean target.

| File | Responsibility |
| --- | --- |
| `ConvergeAudit/Trace.lean` | Deterministic replay, invalid-edge existence, checked-opening assumptions |
| `ConvergeAudit/Dispute.lean` | Executable binary localization and its soundness |
| `ConvergeAudit/RangeDispute.lean` | Arbitrary-width localization, empty-interval refusal and a checked ceil-logarithmic query bound |
| `ConvergeAudit/Knowledge.lean` | Grow-only authenticated evidence semilattice; silence counterexample |
| `ConvergeAudit/Settlement.lean` | Conditional optimistic finality, executable gate and semantic evidence bindings |
| `ConvergeAudit/Composition.lean` | Checkpoint composition, input concatenation and application invariant preservation |
| `ConvergeAudit/Quorum.lean` | Distinct-member counting, honest quorum intersection and conditional certificate agreement |
| `ConvergeAudit/Sampling.lean` | All-miss sequence counts for independent sampling with replacement |
| `ConvergeAudit/Merkle.lean` | Typed paths, scoped/count-bound openings, completeness and collision witnesses from concrete hash transcripts |
| `ConvergeAudit/Fraud.lean` | Canonical log commitments, authenticated one-step fraud verification, completeness and opening-input budget |
| `ConvergeAudit/Chronology.lean` | One authority-owned ticket/slot: deadline-bound commitment, fixed challenge release, irreversible choice and single consumption |
| `ConvergeAudit/Visibility.lean` | Public computations, ideal indistinguishable views, limits on perfect prediction and enumerable commitments |
| `ConvergeAudit/Retention.lean` | Byte/item admission bounds, authenticated-evidence assumptions and protected contiguous-prefix retention |
| `ConvergeAudit/Encounter.lean` | Pinned-root/scheduled-seed replay, single mint, irreversible retention closure and spent-start preservation |
| `ConvergeAudit/PayloadPool.lean` | Joint global/local admission, bounded scope counts, empty/authenticated release, and monotone incarnation/revision checks |
| `ConvergeAudit/Reservation.lean` | Pre-play credit, used-plus-promised capacity, final-item slack release, idempotent reopen, and history-wide single consumption despite pruning |
| `ConvergeAudit/Termination.lean` | Abandonment/expiry, durable retry, terminal histories, preserved start/root/hold, closed retention, and safe clock-order normalization |
| `ConvergeAudit/Recovery.lean` | No recovered play capability, complete-log retry, missed-window interruption and raw-log-free terminal recovery |
| `ConvergeAudit/Cases.lean` | Finite lifetime case slots, all-case retention, exact source acknowledgement and transactional revision fencing |
| `ConvergeAudit/Archive.lean` | Durable exact-bundle custody, local handoff without case closure, release authorization and history-wide copy availability |
| `ConvergeAudit/InventoryCompaction.lean` | Incremental provenance-preserving compaction, duplicate and stale-head refusal, idempotent retry, unchanged market holds and bounded client pages |
| `ConvergeAudit/Generations.lean` | Monotone epochs, irreversible old-start and archive fences, conserved origins and market eligibility, bounded hot slots and secret erasure |
| `Tests.lean` | Positive examples and concrete attack witnesses |
| `Tests/Merkle.lean`, `Tests/Fraud.lean` | Tampered openings, false accusations, deliberately colliding hashers and canonical padding |
| `Tests/Chronology.lean` | Deadlines, retry semantics, post-release replacement, forfeiture, repeated claims and authority-copy counterexample |
| `Tests/Visibility.lean`, `Tests/Retention.lean` | Predictable public rules, hidden alternatives, dictionary enumeration, capacity, ACK-only deletion and held-prefix blockers |
| `Tests/Encounter.lean` | Replay binding, double-mint refusal, retention deadlines, late holds and repeated start reservation |
| `Tests/PayloadPool.lean` | Global overflow despite local fit, safe pruning, metadata caps, release permissions and stale revisions |
| `Tests/Reservation.lean` | Reservation conflicts, conversion, excess payload, exhausted credit, pruning and unchanged retry credit |
| `Tests/Termination.lean` | Expiry boundaries, committed/settled refusal, unchanged certificates, held cleanup and stopped rewards |
| `Tests/Recovery.lean` | Partial logs, pruned prefixes, complete retries, missed deadlines, settled receipts and stopped tickets |
| `Tests/Cases.lean` | Decision-only holds, another unresolved case, wrong source/digest/authentication, stale CAS and closure-first refusal |
| `Tests/Archive.lean` | Missing ACKs, exact manifests, held handoff, expired-but-open archives, closed holds and case aggregation |
| `Tests/InventoryCompaction.lean` | Wrong owners and origins, duplicate and stale requests, retries, count adoption, held items and bounded replacement pages |
| `Tests/Generations.lean` | Held or live evidence, unused starts, stale epochs, duplicate issue, safe-integer exhaustion and a broken reset that permits reissuance |

`State` and `Command` are arbitrary types. `step` is a total deterministic
function; rejected commands, trusted time receipts and RNG must be represented
explicitly by the application. A trace is indexed by natural numbers, and only
the prefix of the declared length is relevant. Empty traces are allowed.
The original `locate` handles `2^depth` transitions. `locateRange` handles any
nonempty interval without padding, returning an index and midpoint-query count;
empty intervals return `none`. Given agreeing left endpoints and disagreeing
right endpoints, the selected adjacent states witness a disagreement and the
query count is at most `ceilLog2 width`. `ceil_log2_minimal` proves this is the
least exponent whose power of two covers the width. This does not bound actual
hash verification or serialization costs. Merkle opening checks are modeled
separately in `Merkle.lean`.

`FinalityEvidence` connects the gate's booleans to the exact trace's semantic
validity or timely challenge coverage. `finality_gate_sound` proves validity
when that evidence and an accepted gate are supplied. `valid_checkpoints_compose`
chains a child's initial state to its actual parent output, while
`finalized_invariant` carries an application-proved kernel invariant through
finalization. The evidence hypotheses still need implementation refinement.

`Quorum.lean` counts fixed roster indices rather than signature packets. Under
`2q > n+f` and at most `f` faulty identities, two qualifying signer sets have an
honest member in common. `quorum_decisions_unique` then proves agreement if the
sets authenticate signatures for the same voting instance and honest signers
do not equivocate. It does not establish a complete BFT protocol.

`Merkle.lean` does not assume that a finite cryptographic digest is globally
injective. If an accepted opening misrepresents the committed context, kind,
count or value, it produces a collision between structured preimages that occur
in the opening and committed-tree hash transcripts. `encoded_collision` converts
this to a byte-level hash collision when the canonical encoder is unambiguous
on those inputs; `collision_splits_encoding` also covers ambiguous encoders.
No cryptographic security or encoding-injectivity claim is proved.

`Fraud.lean` replaces the old explicit opening-equality assumptions with three
checked openings. `verified_fraud_refutes_or_collision` concludes either trace
invalidity or such a collision. `localized_fraud_accepted` connects logarithmic
localization to a generated proof accepted by this verifier. Conversely, a
valid trace is never accused if the involved inputs do not collide. The accepted
proof's opening-input transcript has exactly
`2*ceilLog2(n+1) + ceilLog2(n) + 6` entries, including root and leaf preimages.
This is a transcript-size theorem, not a machine-time or network-cost theorem.

The research commitment is a perfect binary tree of minimum covering depth;
out-of-range leaves use a dedicated `none`, while real states and commands use
distinct tags. Prefix-extensionality and empty-command-root uniqueness are
proved. This representation differs from MoonBit's odd-last-node duplication,
leaf-to-root paths and canonical string encoding. No wire compatibility,
raw-path parser correctness or MoonBit Merkle refinement is claimed yet.

The original `Trace.lean` opening-equality theorem remains as an abstract adapter
contract; the new fraud verifier discharges those equalities conditionally on
the absence of collisions in its concrete transcripts. Timely honest challenge
coverage remains an environmental hypothesis. No custom cryptographic or watcher
axiom is declared. The model does not prove real hash/signature security, input
authenticity/completeness, availability, liveness, DoS bounds, full quorum protocol
correctness, sparse-state witness verification, or production-kernel refinement.

`Chronology.lean` models one serialized, durable authority ledger entry. A new
commitment must arrive before the scheduled release; retries preserve the
original receipt. Successful histories keep the same root, release the fixed
seed after commitment, and cannot reuse a consumed or forfeited slot. These
properties do not prohibit private client-side simulations. The model assumes
trusted receipt times and a secret seed until release; it proves no VRF
security, probabilistic unpredictability, atomic database refinement, ticket
issuance policy, multi-round parent binding, gameplay validity or reward minting.
See the [Japanese chronology design](../../docs/gameplay-chronology-ja.md).

`Visibility.lean` distinguishes exact public computations from hidden target
values with equal observations. It rules out a predictor correct in every
possible world when equal views have different targets; it proves no bound on
guessing probability or real cryptographic secrecy. `Retention.lean` proves
byte/count bounds and preservation of non-prunable chunks through contiguous
prefix deletion. Trusted finality/retention facts and accurate durable counters
remain host obligations. See the [privacy and storage design](../../docs/private-views-and-bounded-storage-ja.md)
for the bounded IndexedDB prototype, its integration status and limits.

`Encounter.lean` connects timed reveal to deterministic reward execution and
models irreversible case-window closure. It also proves that reserving starts
never overwrites an already-spent start, across arbitrary issuance histories.
The root here denotes an authenticated log, with real hashing, decoding,
signature checks and durable CAS left to host refinement. The
[bounded encounter integration](../../docs/encounter-lifecycle-ja.md) exercises
these boundaries with WebCrypto, SQLite and real Chromium, without claiming a
proof of that implementation or of the game rules themselves.

`PayloadPool.lean` checks global and local byte/item admission together, with
all other queues represented by an unchanged context. Pruning a safe prefix
keeps the global budget valid. Scope counts bound metadata, and a once-written
scope needs authenticated closure before release. Incarnation/revision lemmas
state the conditions under which an old grant cannot match a recreated queue;
real authentication, global atomic counter updates and overflow refusal remain
host obligations. See the [shared-pool implementation and measurements](../../docs/shared-payload-pool-ja.md).

`Reservation.lean` accounts for used and promised bytes/items jointly. Successful
recording consumes one credit item, and the last item releases byte slack.
`history_spends_once` and `history_count_bounded` cover arbitrary write histories
with intervening pruning; deleting payload never replenishes credit. These
proofs assume the host binds one credit to a stable scope and atomically updates
its counters. They do not reserve physical disk or prove the HTTP/IndexedDB
implementation. See the [reservation and signed API integration](../../docs/encounter-http-and-reservation-ja.md).

`Termination.lean` preserves an occupied start while permanently stopping reward
admission. Retrying closure keeps its certificate, and cleanup requires elapsed
retention and no hold before refusing all later holds. Arbitrary histories after
closure cannot mint. Reservation release lemmas separately conserve other
scopes' payload and unused credit. Authentication, atomic updates, safe integer
checks and physical storage remain host obligations; the
[termination integration](../../docs/encounter-termination-ja.md) exercises them.

`Recovery.lean` proves that no recovery decision produces the `playing`
capability. A complete retained log permits retrying its existing commitment;
partial logs or missed commit windows interrupt the session. Terminal recovery
requires no raw log. Authenticated observations, accurate counters, JS time and
controller refinement remain host obligations. The
[default game screen](../../docs/encounter-ui-ja.md) connects those decisions to
bounded session persistence and real Worker browser tests.

`Cases.lean` replaces an unqualified single hold bit with finite immutable case
slots. Deciding a case preserves its hold; acknowledging an exact source and
decision leaves all other cases unchanged. Placing a case fences the ticket
revision, while closed retention blocks new cases. Authentication, slot-to-ID
binding, accurate SQL views and a shared atomic transaction remain host duties.
See the [case-service integration](../../docs/encounter-cases-ja.md).

`Archive.lean` separates receiving a durable custody acknowledgement from
closing the case window. Handoff keeps holds and the remote copy; release
requires final closure and the minimum retention deadline. Starting from safe
custody, every open history retains a local or remote copy of the exact target.
Archive truthfulness, physical durability, authentication and runtime refinement
remain host obligations. See the [archive integration](../../docs/encounter-archive-ja.md).
