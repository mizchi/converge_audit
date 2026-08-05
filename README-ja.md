# mizchi/bft

[`mizchi/converge`](https://github.com/mizchi/converge) のlocal-first CRDTへ接続する、
敵対環境向けのevent認証・checkpoint監査ライブラリです。

[English](README.md)

## 最終目標

個人または小規模チームでも、MMO的なオンラインゲームを制作・運営できるようにすることを
目指しています。

すべてのプレイヤーを中央サーバーで毎frameシミュレーションする大規模構成は、個人開発では
費用・運用の両面で現実的ではありません。一方、完全なP2Pでは、改変client、ログの隠蔽、
二重発行、結託をそのまま信用できません。

そこで、このプロジェクトでは役割を次のように分けます。

```text
リアルタイム操作・演出
  client predictionで即時処理し、中央応答を待たない
                │
                ▼
player-local DB
  signed eventと監査状態を保存する
                │
                ▼
同じencounter / match / interest groupのpeer
  event、root、署名を相互に敵対的検証する
                │
                ▼
checkpoint + witness certificate
  通常時はcompactなcommitmentだけを中央へ送る
                │
                ▼
小さな中央authority
  checkpointを受理し、報酬・rank・assetをsettleする
                │
      sample / challenge / fork / high-value時だけ
                ▼
deterministic replay
  必要なtranscriptまたはproofを取得して再検証する
```

中央サーバーをなくすことが目標ではありません。identity/keyのprovision、policy、最終checkpoint、
高価値結果、marketplaceは中央の信頼境界として残します。削減したいのは、全プレイヤーの全frameを
中央で常時処理・保存・再計算するコストです。

## このライブラリがしていること

`mizchi/bft`はゲームルールそのものではなく、検証可能な履歴を作るためのmechanismを提供します。

- converge eventをsession、roster、public key、digest、signatureへ拘束する。
- 同じplayer counterに異なるeventを出すequivocationを検出する。
- 因果依存が揃うまでeventをbufferし、正しい順序で認証済みeventだけを渡す。
- event集合をMerkle tree / authenticated mapへ集約し、compact proofを生成する。
- event → micro → macroの階層checkpointを、arrival orderに依存せず生成する。
- distinct witnessの署名を集め、duplicateとequivocationが収束するquorum状態を作る。
- checkpointのexact parent、duplicate、gap、forkをfail-closedに分類する。
- seal、durable outbox、ACK、lease、retry、crash recoveryをpure contractとして定義する。

通常経路では中央へ送る量を、全event logではなくevent数に比例しない少数のroot、metadata、
witness署名へ近づけます。
不一致を調べるときはMerkle proofにより`O(log n)`で対象leafを局所化し、完全replayはsampling、
challenge、fork、高価値報酬、marketplaceなどへ限定する設計です。実際の通信量はwitness数、
interest groupの大きさ、checkpoint間隔、保持policy、ゲームkernelに依存します。

checkpointだけではreplayできないため、finalityまたはdispute期限までは、選ばれたpeerがtranscriptを
保持する必要があります。中央の常時保存を減らす代わりに、保持責任と取得不能時の結果保留をprotocolへ
明示する、というtrade-offです。

これはblockchainでも、分散consensusで世界全体を一つの順序へ並べる仕組みでもありません。
独立な操作はCRDTとして並び替えを許し、順序がゲーム結果を変える部分だけをgame-specificな
deterministic kernelで解決します。

## パッケージ構成

| package | 責務 |
| --- | --- |
| `mizchi/bft` | 署名付きconverge event、roster拘束、equivocation検出、因果配送 |
| `mizchi/bft/audit` | checkpoint cadence/retention、finality見積り、head分類 |
| `mizchi/bft/audit/merkle` | immutable Merkle treeとinclusion proof |
| `mizchi/bft/audit/authmap` | deterministic authenticated mapとmembership/non-membership proof |
| `mizchi/bft/audit/layered` | watermark駆動のevent→micro→macro checkpoint |
| `mizchi/bft/audit/quorum` | domain-separatedな認証済みvote収集 |
| `mizchi/bft/audit/delivery_auth` | producer署名とdistinct witness quorumによる配送認証 |
| `mizchi/bft/audit/runtime` | atomic seal/outbox/ACK、local store、peer retry契約 |
| `mizchi/bft/x/game_audit/*` | PvE/PvP/open-world/inventory/marketplaceの実験policyとkernel |

`src/audit`はgame payloadをopaque digestとして扱う汎用層です。誰をwitnessにするか、何票を
finalityとするか、攻撃・回避・lootが合法かは`src/x/game_audit`または実際のゲーム側が決めます。

## examplesが確認したいこと

### `examples/node-audit-runtime`

プレイヤーごとのlocal-first DBとpeer transportの参照実装です。

Node.js 24の`node:sqlite`を使い、event、equivocation、checkpoint、head、closure、outbox、ACK、
peer route、lease、retry、fork evidenceを一つのtransaction domainへ保存します。途中crashで
checkpointの一部だけが残らないこと、restart後も未ACK送信を再開できること、認証済みforkだけを
隔離できることを確認します。

このexampleが答えたいのは「一人のplayer clientが、自分の監査状態をlocal DBで保持しながら、
複数peerへbounded fanoutし、停止・再起動をまたいでもcheckpoint protocolを壊さないか」です。
production用mobile DB、端末keystore、WebTransport/WebSocketはまだ接続していません。

### `examples/cf-game-audit`

低頻度checkpointを受理する中央settlement serviceの参照実装です。

Cloudflare Workers、SQLite-backed Durable Objects、Queueを使い、coordination unitごとにheadと
outboxを分離します。通常checkpointは直接authorityへ配送し、Queueと完全transcript replayは
sample、challenge、fork、high-value、marketplaceへ限定します。

| pattern | 相互監査したいもの | 中央で確認したいもの |
| --- | --- | --- |
| 1:N PvE / dungeon | authority event、参加者sample、予兆と入力receipt | clear・lootが正しいevent列から生成されたか |
| N:N PvP | cross-team witness、公開状態、同一slotのequivocation | referee checkpoint、score、rank結果 |
| irregular open world | encounter周辺observer、遅延sampling、eligible-set seal | sampled/high-value encounterとasset生成 |
| marketplace | origin receipt、current-owner head、authenticated-map proof | 正当に生成・移転されたassetだけを出品できるか |

このexampleは巨大なMMO serverの完成品ではありません。「中央が全frameを受け取らず、compactな
checkpointを安価に受理し、疑わしい結果だけをdurableかつidempotentにreplayへ昇格できるか」を
実装・故障注入・実測するためのinfrastructure prototypeです。

## 形式手法で確認していること

アルゴリズムの主張ごとに、最小の検証手段を使い分けます。

| 対象 | 手段 | 現在確認している範囲 |
| --- | --- | --- |
| cadence、retention、head、seal、vote merge | MoonBit proof → Why3/Z3 | pure predicateと数学整数上の不変条件、計200 goals |
| crash、drop、retry、bounded outbox、witness quorum | Quint / TLC | 有限actor・epochモデルのsafety/liveness。正常4設定で反例なし |
| guardが本当に必要か | 意図的に壊したQuint module | 7設定すべてで期待した反例を検出 |
| SQLite/DO/Queue/HTTPへの写像 | integration testとfault injection | atomic rollback、restart、duplicate、fork、ACK loss |
| 通信量・latency | local/remote benchmark | 特定環境のengineering baseline。一般SLAではない |

形式手法は、モデルへ書いた性質についてのみ判断します。Quintでは暗号検証をBooleanへ抽象化しており、
MoonBit proofもhash衝突耐性、署名偽造困難性、disk/networkの実装を証明しません。

## 保証しないこと

- 入力が人間によるものだったこと。
- aimbot、wallhack、外部認識補助が存在しないこと。
- witness rosterのSybil耐性や、多数peerの結託耐性。
- game-specific replay kernelに漏れがないこと。
- 未監査の`experimental_crypto` backendがproduction securityを満たすこと。
- あらゆる地域・負荷で目標latencyや通信量を達成すること。

これらは端末security、identity/roster policy、監査済み暗号、game design、playtest、運用監視と
組み合わせて扱う必要があります。certificate不足やtimeoutも直ちにcheat確定とはせず、結果保留や
中央replayへの昇格として扱う設計です。

## 開発と検証

```sh
just check-all
just test
just prove
just formal-check
just test-node-audit-runtime
just test-cf-game-audit
```

最初に読む文書は[docs/README.md](docs/README.md)です。全体像は
[ゲーム監査prototype](docs/game-audit-overview-ja.md)、ゲーム上の表現制約は
[予兆とリアルタイム設計](docs/telegraph-game-design-ja.md)、不規則encounterは
[open-world選択的監査](docs/open-world-audit-ja.md)、配送・quorum形式モデルは
[Quint protocol model](formal/quint/README.md)を参照してください。

## License

Apache-2.0
