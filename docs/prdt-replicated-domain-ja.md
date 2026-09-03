# PRDT による Replicated Domain Object

[`examples/prdt`](../examples/prdt/README.md) は
[PRDTs: Composable Design and Verification of Consensus Protocols using Replicated Data Types](https://arxiv.org/html/2504.05173v3)
の考え方で、ドメイン固有の状態遷移と分散環境での入力収集・順序確定・複製・合意を分離する
TypeScript 参照実装である。MoonBit の監査ライブラリからは独立しており、コアは実行環境非依存、
Cloudflare Workers の Durable Object を runtime adapter の一つとして持つ。

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
追記・merge可能       rollback可能          後戻り不可
```

確定 decision の半順序は `Pending <= Accepted`、`Pending <= Rejected(reason)` のみ。
`Accepted -> Rejected`、`Rejected(a) -> Rejected(b)` は存在しない。
`decisionLessOrEqual` (`src/prdt/laws.ts`) がこの順序を実行可能に定義し、
property test が `decision(state) <= decision(applyDelta(state, delta))` を検証する。

### `alive` を proposal 時の precondition にしない

`hp > 0` は別 replica の並行 Damage で false に変わるため merge に対して安定でない。
proposal はそのまま受理し、tick の入力集合と順序が閉じた後に純粋な reducer が
直前状態に対して validate する。`test/negative/unstable-alive-guard.test.ts` が
「pre(s) が成り立つのに pre(merge(s, damage)) が破れる」例と、2 replica が逆の
局所判定に至る例を固定している。

### consensus safety と domain validity の分離

PRDT が保証するのは decision の両立可能性・単調性・knowledge の収束・確定ログの prefix safety。
「全 replica が一貫して死亡済み player の skill を Accepted にした」状態は agreement を満たすが
ゲーム規則上は無効なので、`test/properties/domain-validity.test.ts` が確定ログを走査して
`Accepted(SkillActivated) => HP > 0 かつ MP >= cost (直前状態)` と `HP >= 0` を別途検証する。

## 層と責務

```text
Runtime -> PRDT Protocol -> Finalization -> Domain
```

| 性質 | 担当 |
| --- | --- |
| `hp <= 0` なら dead、dead なら skill を reject、event 適用 | Domain (`src/domain`, `src/examples/mmo`) |
| batch 内 canonical order、一度だけ Accepted/Rejected に解決 | Finalization (`src/domain/resolve-batch.ts`) |
| tick の入力集合確定、異なる確定結果への分岐禁止、prefix safety | PRDT (`src/prdt`) |
| 証明書の真正性（single authority / quorum） | Finalizer (`src/finalizer`) |
| gossip、再送、partition、checkpoint、simulation、Durable Object | Runtime (`src/runtime`) |

## コア型

- `Envelope<C> = { id, tick, submittedBy, localSequence, command }`、`id = "${replicaId}:${localSequence}"`
- `Domain<S, C, E, R> = { initialState, validate, apply }`（純粋関数）
- `CommandOrder<C>`：`(tick, phase, submittedBy, localSequence, commandId)`、`commandId` が最後の tie breaker
- `ResolvedBatch`：`previousStateHash`、`orderedCommandHash`、verdict 列、`resultingState(+Hash)`
- `ProposalState<C>`：tick ごとの `CommandId -> Envelope` grow-only map。同じ id に異なる payload は `ProtocolError("ConflictingProposal")`
- `ClosureCertificate = { tick, parentDecisionHash, orderedCommandIds, orderedCommandsHash, certificate: Uint8Array }`
- `ClosureDecision`：`Pending <= Closed(c)`、`Closed(a) <= Closed(b) iff a == b`
- `CommittedLog<R>`：prefix order。分岐は `ProtocolError("PrefixConflict")`
- `ReplicatedDomainState = { proposals, closures, committed }`。`committed` は前二者から決定的に導出され、通信には乗せない

## 確定の流れ

1. replica が `propose` で Envelope を作り、`Delta { proposals, closures }` として gossip する
2. finalizer（authority または quorum）が tick の `orderedCommandIds` を固定した証明書を作る。
   `parentDecisionHash` は直前 tick の確定結果 hash（初回は genesis hash）
3. 各 replica の `applyDelta` は証明書を検証し、join し、closed かつ全 command 既知の tick を
   先頭から順に `resolveBatch` で materialize する
4. 証明書の id 順が canonical order と一致しなければ `OrderMismatch`、親 hash が違えば
   `ChainMismatch` として delta ごと拒否する
5. closure 後に届いた command は `RejectedLate(closedTick)`（`RejectAsLate` policy）。既存 batch は変化しない

## 検証

| 種別 | 内容 | 場所 |
| --- | --- | --- |
| Unit | dead/alive/MP 不足/clamp、入力順非依存、conflict、closure 重複、prefix、late command、証明書偽造/順序/親不一致、snapshot 復元、quorum、AuthorityHost | `test/unit` |
| Property (fast-check) | lattice laws（proposal / closure / log / vote / 全体状態）、permutation・duplicate・merge-tree 不変、snapshot 往復、decision monotonicity、closure uniqueness、prefix safety、late の不変、domain validity | `test/properties` |
| Simulation | 3 replica、reorder/duplicate/partition/heal/restart/anti-entropy、40 seed で収束と再現性 | `test/simulation` |
| Negative | unstable alive guard、premature acceptance | `test/negative` |
| Worker | workerd 上の Durable Object 経由で lethal race を解決し、client replica が anti-entropy で収束 | `test/worker` |

```sh
pnpm --dir examples/prdt install
just check-prdt
just test-prdt
just simulate-prdt 3 600
```

## 未実装・非目標

- Byzantine 耐性（quorum の equivocation 除外以外）
- quorum の liveness（leader election、view change、再投票）
- `MoveToNextTick` policy、cursor 付き差分配信、proposal/確定 prefix の compaction と GC
- entity/zone sharding、cross-scope transaction
- 本物の署名（同梱の authenticator は共有秘密の MAC。Ed25519 等に差し替える前提）
