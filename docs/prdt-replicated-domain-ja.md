# PRDT による Replicated Domain Object

[`src/prdt`](../src/prdt/README.md) は
[PRDTs: Composable Design and Verification of Consensus Protocols using Replicated Data Types](https://arxiv.org/html/2504.05173v3)
の考え方で、ドメイン固有の状態遷移と分散環境での入力収集・順序確定・複製・合意を分離する
MoonBit 実装である。`audit/` と `x/game_audit/` からは独立しており、root の `Hasher` /
`Signer` / `Verifier` trait だけを共有する。コアは実行環境非依存で、
[`examples/prdt`](../examples/prdt/README.md) が Cloudflare Durable Object 上で
JS ブリッジ経由に動かす。

```text
Pure Domain State Machine
        +
Replicated Finalization Protocol
        =
Replicated Domain Object
```

## 設計判断

### 状態・予測・決定の分離

```text
Knowledge state  ->  Speculative view  ->  Final decision
追記・join可能        rollback可能          後戻り不可
```

確定 decision の半順序は `DecisionPending <= DecisionAccepted`、
`DecisionPending <= DecisionRejected(reason)`、`DecisionPending <= DecisionLate` のみ。
`Accepted -> Rejected` や `Rejected(a) -> Rejected(b)` は存在しない。
`decision_less_or_equal` (`src/prdt/laws.mbt`) がこの順序を実行可能に定義し、
property test が `decision(state) <= decision(apply_delta(state, delta))` と
`decision(a) <= decision(join(a, b))` を検証する。

### `alive` を proposal 時の precondition にしない

`hp > 0` は別 replica の並行 Damage で false に変わるため join に対して安定でない。
proposal はそのまま受理し、tick の入力集合と順序が閉じた後に純粋な reducer が
直前状態に対して validate する。`negative_test.mbt` が「pre(s) が成り立つのに
pre(join(s, damage)) が破れる」例と、2 replica が逆の局所判定に至る例を固定している。

### consensus safety と domain validity の分離

PRDT が保証するのは decision の両立可能性・単調性・knowledge の収束・確定ログの prefix safety。
「全 replica が一貫して死亡済み player の skill を Accepted にした」状態は agreement を満たすが
ゲーム規則上は無効なので、`property_test.mbt` が確定ログを走査して
`Accepted(SkillActivated) => HP > 0 かつ MP >= cost (直前状態)` と `HP >= 0` を別途検証する。

## パッケージと責務

```text
Runtime -> PRDT Protocol -> Finalization -> Domain
```

| 性質 | 担当 |
| --- | --- |
| `hp <= 0` なら dead、dead なら skill を reject、event 適用 | `prdt/mmo`（`Domain` の実装） |
| batch 内 canonical order、一度だけ Accepted/Rejected に解決 | `prdt` の `resolve_batch` |
| tick の入力集合確定、異なる確定結果への分岐禁止、prefix safety | `prdt` の `ProposalState` / `ClosureMap` / `CommittedLog` / `Protocol` |
| 証明書の真正性（single authority / quorum） | `prdt` の `Finalizer` 実装 |
| gossip、再送、partition、checkpoint、simulation | `prdt/runtime`、`prdt/mmo/simulation` |
| Durable Object などのホスト向け JSON ブリッジ | `prdt/worker` |

## コア型

- `Envelope[C] = { id, tick, submitted_by, local_sequence, command }`、`id = "<replica>:<local_sequence>"`
- `Domain[S, C, E, R] = { initial_state, validate, apply }`（純粋関数のフィールド）
- `CommandOrder[C]`：`canonical_order(phase)` が `(tick, phase, submitted_by, local_sequence, id)` を作る
- `ResolvedBatch`：`previous_state_hash`、`ordered_command_hash`、verdict 列、`resulting_state(_hash)`
- `ProposalState[C]`：tick ごとの `id -> Envelope` grow-only map。同じ id に異なる payload は `ConflictingProposal`
- `ClosureCertificate = { tick, parent_decision_hash, ordered_command_ids, ordered_commands_hash, attestations }`
- `ClosureDecision`：`ClosurePending <= Closed(c)`、`Closed(a) <= Closed(b) iff a == b`
- `CommittedLog[R]`：prefix order。分岐は `PrefixConflict`
- `State = { base, proposals, closures, committed }`。`committed` は `base` 以降の knowledge から決定的に導出され、通信には乗せない
- `Base[S]`：compaction 済み履歴の境界（`next_tick`、decision hash、その時点の domain state）。初期値は genesis
- `KnowledgeDigest` / `Catchup`：digest ベースの差分配信と、compaction で履歴を忘れた peer への base 転送
- hash は `canonicalize(json)`（キーをソートした JSON）の SHA-256。`hash_value` は任意の `ToJson` 値に使える

## 確定の流れ

1. replica が `ReplicatedDomain::propose` で Envelope を作り、`Delta { proposals, closures }` として gossip する
2. finalizer（`ClosureAuthority` または quorum の `Voter` 群）が tick の `ordered_command_ids` を固定した証明書を作る。
   `parent_decision_hash` は直前 tick の確定結果 hash（初回は genesis hash）
3. 各 replica の `Protocol::apply_delta` は証明書を検証し、join し、closed かつ全 command 既知の tick を
   先頭から順に `resolve_batch` で materialize する
4. 証明書の id 順が canonical order と一致しなければ `OrderMismatch`、親 hash が違えば
   `ChainMismatch` として delta ごと拒否する
5. closure 後に届いた command は `DecisionLate(tick)`（`RejectAsLate` policy）。既存 batch は変化しない
6. `Protocol::restore` は snapshot の knowledge から確定 prefix を再計算し、永続化された prefix と
   一致しなければ `SnapshotMismatch` にする
7. `Protocol::compact(retain_ticks~)` は古い batch を base に畳み込み、base 未満の proposal / closure を忘れる。
   verdict は変えないが、compaction 済み tick の command は `decision` に現れなくなる
8. `join` は新しい方の base を採用し、相手の確定 prefix が base と矛盾すれば `PrefixConflict` にする。
   `apply_catchup` は自分の prefix が否定できない場合にのみ相手の base を採用する（base の認証は未実装。
   `audit/` の checkpoint 証明書を差し込む位置）

### Quorum runtime

`runtime/QuorumAgent` は任意の replica が次の tick の closure を提案し、投票者は
「自分の next tick を対象とし、自分の head から連鎖し、既知の command のみを canonical order で並べた」
最初の提案に 1 tick 1 票で署名する。過半数を集めた replica が証明書を組み立てて delta として gossip する。
証明書の同一性は payload（tick・親 hash・id 列）で定義し、attestation の組み合わせが違っても同じ決定とみなす。
安全性は投票 lattice と過半数 threshold から従う。liveness は best effort（leader election や view change は無い）

## 検証

| 種別 | 内容 | 場所 |
| --- | --- | --- |
| Unit | canonical JSON / SHA-256 / MAC、lattice 各種、closure 重複、prefix、resolve_batch、MMO ドメイン規則、致死 race の両到着順、late command、証明書偽造・不正形・親不一致・非 canonical 順、snapshot 復元と改竄検出、quorum と equivocation | `src/prdt/*_test.mbt`、`src/prdt/mmo/*_test.mbt` |
| Property（seed 生成） | lattice laws、配送順・重複・merge-tree 不変、snapshot 往復、decision monotonicity、closure uniqueness、prefix safety、late の最終性、domain validity | `src/prdt/mmo/simulation/property_test.mbt` |
| Simulation | reorder / duplicate / partition / heal / restart / compaction + 状態転送 / digest 同期、single authority と quorum（3・5 replica、equivocating voter あり）、seed ごとの収束と再現性 | `src/prdt/mmo/simulation/simulation_test.mbt` |
| Negative | unstable alive guard、premature acceptance | `src/prdt/mmo/simulation/negative_test.mbt` |
| Bridge / Worker | JSON 文字列ブリッジ、workerd 上の Durable Object 経由で client replica が収束 | `src/prdt/worker/bridge_test.mbt`、`examples/prdt/test` |

```sh
just test-prdt
just check-prdt-boundary
just test-prdt-worker
```

## 未実装・非目標

- Byzantine 耐性（quorum の equivocation 除外以外）
- quorum の liveness（leader election、view change、再投票）
- `MoveToNextTick` policy、base（checkpoint）の認証付き転送、JS bridge の差分配信
- entity/zone sharding、cross-scope transaction
- 本物の署名（同梱の `SharedSecretAuthenticator` は HMAC。root の `Signer` / `Verifier` trait で差し替える）
- lattice laws の Why3 証明（`.mbtp`）。現状は seed 付き property test のみ
