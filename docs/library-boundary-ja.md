# mizchi/bft のライブラリ境界

更新日: 2026-08-05

## 結論

`mizchi/bft` が一般化するのはチート検出そのものではなく、検証可能なイベント履歴を
commit、認証、収束、配送する機構である。ゲーム上の正当性は、用途ごとのdeterministic
validatorが判断する。CRDTとlocal-first同期は依存先の`mizchi/converge`が担当する。

CRDTの収束は「同じ入力集合から同じ状態へ到達する」ことを保証できるが、入力が現実の
プレイとして正しいことまでは保証しない。そのためCRDT本体を変更せず、
`mizchi/bft/audit/*`を任意利用の監査拡張として別moduleに置く。

```text
converge CRDT
  └─ audit mechanism
       ├─ commitment / Merkle / authenticated map
       ├─ authenticated quorum / delivery
       └─ durable seal / outbox / ACK / retry
            └─ application policy
                 └─ game replay semantics and UX
```

## 三つの責務

| 層 | 内容 | 配置 |
| --- | --- | --- |
| mechanism | digest、署名、Merkle、fork検出、quorum集計、配送、ACK、再送 | root package、`src/audit` |
| policy | cadence、保持期間、roster、閾値、sampling、信頼主体 | 共通の型・評価器は`src/audit`、具体値は利用側 |
| semantics | 命中、回避、移動、loot、勝敗、出品可否 | `src/x/game_audit` |

設定可能であることだけを一般化の根拠にはしない。例えばquorumのdistinct roster集計は
汎用機構だが、誰をrosterへ登録するか、何故そのidentityを信頼するか、`f`をいくつにするかは
deployment policyである。

## 現在のパッケージ判断

| package | 判断 | 理由 |
| --- | --- | --- |
| `audit/commitment` | 汎用 | payloadを解釈せずrootとparentを拘束する |
| `audit/merkle`, `audit/authmap` | 汎用 | inclusion/non-inclusion proofだけを扱う |
| `audit/layered` | 汎用 | opaque canonical eventをwatermarkで集約する |
| `audit/runtime` | 汎用 | seal/outbox/ACK/local store/peer retryの純粋契約 |
| `audit/delivery_auth` | 汎用 | destination固有statementとproducer/witness認証だけを扱う |
| `audit/quorum` | 汎用 | opaque subjectへのdomain-separated voteを認証・収束する |
| `audit/quorum/vote` | 汎用 | vote join-semilatticeとその代数則を証明する |
| `audit/runtime/bridge` | host bridge | primitive/JSONと汎用MoonBit契約の薄い境界 |
| `x/game_audit/checkpoint` | ゲームadapter | game checkpointを共通commitmentへ射影する |
| `x/game_audit/attestation` | ゲームpolicy | 汎用quorumをreplay/finalityへ接続する |
| `x/game_audit/replay`, `pvp_session`, `open_world` | ゲーム固有 | 状態遷移と合法性を解釈する |
| `x/game_audit/inventory`, `market` | 実験的domain | asset生成・所有・出品規則を持つ |
| `x/game_audit/wire`, `crypto`, `worker` | ゲームadapter | bundle schema、暗号backend、deploy用compositionを持つ |

inventory/marketは将来`x/provenance`へ分けられる可能性があるが、現時点では第2の独立した
利用例がなく、game replay型にも依存するため安定した監査coreへ昇格させない。

## 公開contractの昇格条件

新しい機能を`src/audit`へ置くには、原則として次をすべて満たす。

1. `src/x/game_audit`へ依存しない。
2. application payloadをopaque bytesまたはdigestとして扱う。
3. 不変条件を攻撃、loot、team、marketなどのdomain語なしで書ける。
4. cadence、quorum値、identity、authorityを固定しない。
5. pure state transitionとhost I/Oが分かれている。
6. 二つ以上の独立した利用シナリオで同じAPIを使える。

6は過早な抽象化を避けるための昇格条件であり、実験コードを`x/`に置くことを妨げない。

## 保証境界

汎用層が検査できるもの:

- canonical bytesとdigestの一致
- 署名とprovision済みidentity/keyの一致
- 同一slot/epochのforkまたはequivocation
- distinct roster quorum
- checkpointのexact parentと連続epoch
- atomic seal、durable outbox、ACK、bounded retryの前提条件
- Merkle/AuthMap proof

汎用層だけでは検査できないもの:

- 入力が人間の操作だったこと
- aimbot、wallhack、外部認識補助の不在
- rosterのSybil耐性や複数participantの結託
- ゲームルール上の命中・回避・item生成の正当性
- ネットワーク遅延下の体感的公平性

従って公開説明では`anti-cheat core`ではなく、`authenticated checkpoint and evidence
protocol`または「検証可能なcheckpoint監査基盤」と呼ぶ。

## 形式仕様との対応

| claim | model / implementation | epistemic status |
| --- | --- | --- |
| crashやdrop後もdurable outboxから再送できる | `formal/tla/CheckpointDelivery.tla` | 有限モデルで検査 |
| producer認証とdistinct roster quorumなしにreceiverを進めない | `formal/tla/WitnessQuorum.tla` | 有限モデルで検査 |
| vote競合が順序非依存にequivocationへ収束する | `src/audit/quorum` test | bounded実装テスト |
| delivery capabilityは全trust factsを要求する | `src/audit/runtime_contract.mbtp`, `audit/delivery_auth` | predicate証明 + 実装テスト |
| game actionが合法である | `src/x/game_audit/replay`以下 | gameごとの実装・テスト |

TLA+ではcryptographic verificationをBooleanへ抽象化しており、暗号強度やSQLite/HTTPの
実装そのものをmodel checkedしたとは主張しない。

## Adapter境界

`examples/node-audit-runtime`はNode.js 24 `node:sqlite`によるhost固有の参照adapterであり、
ゲーム規則を含まない。`examples/cf-game-audit`は汎用runtimeを利用するゲームdeploymentであり、
mode、routing、replay、marketplaceを含むためexample全体をcoreへ移さない。

game Workerは既存Cloudflare API互換のcomposition endpointを維持する。新しい汎用host adapterは
`audit/runtime/bridge`を直接利用し、game bundle全体を依存に持ち込まない。

## Decision ledger

| 項目 | 内容 |
| --- | --- |
| source | `mizchi/converge`のCRDT coreを保ちつつ、BFT event認証とcheckpoint監査を再利用可能にしたい |
| observation | coreから監査層への逆依存はなく、BFT adapterだけが`mizchi/converge/types`を必要とする |
| model question | package identityと配置だけを変え、既存の安全性・liveness contractを保存できるか |
| machine result | 307 MoonBit tests、200 proof goals、TLA+正常4/破損7 configuration、Node 16 tests、Cloudflare 42 testsが移動後も通過 |
| decision | mechanismをcompanion module `mizchi/bft`へ抽出し、finalization/replay/trust値は`x/game_audit`へ残す |
| lock | `just check-audit-boundary`, `moon test`, `just prove`, `just tla-check`, `just tla-counterexamples`, Node/Cloudflare adapter tests |
