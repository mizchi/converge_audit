# レシート集約とページ付きinventory

端末の未集約レシートを最大16戦に抑えたまま、17戦目以降も継続できるようにした。
画面の「レシートを集約」で署名済みinventory checkpointへ置き換える。
16件に達した状態で次の戦闘を始める場合も、開始権を消費する前に同じ集約を行う。
集約対象のローカルraw logは、事前に正規のcleanupまたは[archive移管](./encounter-archive-ja.md)で解放する。

以前のアイテムは中央のinventory一覧から3戦分ずつ取得する。
各アイテムには元のticketと署名済みレシートが付き、市場への持ち込みでは元のレシートIDを指定する。
全履歴やreplay logを持ち歩かず、売るアイテムのレシート1件を検証すればよい。
ページを切り替えるとキャッシュを置き換え、端末へ全アイテムを蓄積しない。
集約後の一覧取得には中央への接続が必要になる。

## どこへ何を残すか

| 領域 | 保存するもの | 上限 |
| --- | --- | --- |
| IndexedDB control image | checkpoint 1件、未集約レシート、進行中のsession、再試行中の集約要求 | image全体80 KiB、checkpoint 2 KiB、未集約レシート最大16戦 |
| 一覧のRAM cache | 元のticket・レシート・市場受理状態 | 1ページ3戦、各4 KiB以下。次ページは置き換え |
| 中央の元ledger | ticket、確定レシート、消費済み開始権、case/retention状態 | 既存の有限admission上限に従う |
| 中央inventory index | owner/unitごとの連番とticket ID・receipt ID | 世代を跨いで累積する。safe integerの上限を検査 |
| 中央inventory head | 最新の署名済みcheckpoint | owner/unitごとに1件 |
| raw replay資料 | 既存payload poolまたはarchive | 従来の保持・case・容量規則を維持 |

一覧ページはIndexedDBへ保存しない。CryptoKeyは従来どおり別の固定件数recordに一つ保存する。
この予算は論理JSON/payload容量であり、IndexedDB・SQLiteの物理overheadを含まない。
所有アイテム自体の総数を一定サイズで端末にすべて保存する保証は設けていない。

## 集約のcontract

[`inventory-checkpoint.ts`](../examples/cf-game-audit/game/encounter/inventory-checkpoint.ts)がwire型・正規frame・境界を定義する。
checkpointには署名鍵、owner、unit、rules、revision、前checkpoint ID、batch digest、累積root、
レシート数、item数、作成時刻を署名する。batchは呼び出し側の順序を保持する最大16件のticket IDで、重複を拒否する。
receipt IDはレシート全体の署名対象を特定し、batch digestは順序付きの`(ticketId, receiptId)`列を束縛する。
累積rootは直前rootとbatch digestから更新する。

中央の[`inventory-store.ts`](../examples/cf-game-audit/game/encounter/inventory-store.ts)は、対象が同じowner/unit/rulesの確定済みledger行であることを確認する。
新規登録ごとにゲームを再実行したり、過去のbatchを走査したりしない。
権威自身の永続ledgerを出所として用い、元のレシートを再発行しない。
未集約であることを索引で確認し、最大16件のmember登録とhead更新を一つのSQLite transactionで確定する。
非同期の署名中にheadが進んだ場合は、transaction内の再確認で拒否する。
直前と同じ要求の再送は同じcheckpointを返す。違う古いheadや既登録ticketの再集約は拒否する。
DOの応答は既存の`storage.sync()`を経由して永続化を待つ。

署名付きowner HTTPに次を追加した。要求・応答とも従来の16 KiB以内である。

| command | 入力 | 応答 |
| --- | --- | --- |
| `inventory-compact` | `expectedCheckpointId`またはnull、1〜16件の`ticketIds` | 署名済みcheckpoint |
| `inventory-page` | 最新`checkpointId`、`after`連番 | 最大3件の元レシート、次の連番またはnull |

ページは同じcheckpointの範囲を連番で参照する。古いcheckpoint IDでの照会は拒否する。
別の所有者・部屋のticketを登録できず、一覧からauthority-privateなseedやledger内部状態を返さない。

このrootはbatch履歴のcommitmentである。各アイテムのMerkle inclusion proofは提供していない。
一覧の出所検証には、取得した元のticketと元のレシートのauthority署名を使う。
中央を信頼せずに完全な一覧の包含・欠落をオフライン検証する仕組みは、別途必要になる。

## 中断・競合・保持

1. 端末が`expectedCheckpointId`と対象ticket ID列を、元のレシートと同じimageへ保存する。
2. 中央へ送信し、返ったcheckpointの署名、owner/unit、前head、batch digest、root、件数差分を検証する。
3. 一つのIndexedDB transactionでcheckpointを採用し、対象レシートと再試行要求を除去する。

中央がcommitしたあとに応答を失った場合も、端末で採用transactionが失敗した場合も、元の資料と要求が残る。
再読込では同じ要求を再送してから通常のsession復旧へ進む。二重計上しない。
同じownerを複数の独立したクライアントが操作し、保存中の要求より先へ別のcheckpointを進める運用は未対応である。
現行画面は同じブラウザ内の操作をWeb Locksで排他する。異なる古いheadは自動的に上書きしない。

従来のv1 imageは、checkpointと要求がnullの状態として読み込む。
revision、保持中のレシート、端末鍵をリセットしない。checkpointだけが残っていて鍵がない場合も、新しい鍵へ勝手に置き換えない。

集約は証拠の保管終了ではない。元ledgerのcase、hold、retention、archiveを変更しない。
未解決caseを持つアイテムも一覧へ残すが、市場受理では従来どおりその時点の全caseを確認する。
archiveへ移したあとにレシートを集約しても、case解決前にarchiveを削除する権利は得られない。
市場での受理は売買・所有権移転ではない。

## 計算量と測定

`b ≤ 16`、ページ幅`p ≤ 3`、中央の登録件数を`N`とする。
集約は索引参照と登録が`O(b log N)`、batchのhash入力は`O(b)`で、中央の署名は1回である。
端末は集約前に最大16件のticketとレシート、合計32署名を再検証する。
ページ取得は`O(log N + p)`の範囲参照と`p`件の元ledger参照を行い、端末で最大6署名を検証する。
市場への持ち込みは元のレシート1件で、ゲームの全履歴を再生しない。
SQLiteの索引や既存case集計の費用を含めて、厳密な定数時間であるとは主張しない。

再現用の`just bench-encounter-inventory`と[測定JSON](../examples/cf-game-audit/benchmarks/encounter-inventory-local-2026-10-18.json)を追加した。
100回・warmup 10回、各DBに16戦分の実際に確定したレシートを用いる。
実Ed25519・インメモリSQLiteでのservice CPUを測り、HTTP認証、通信、disk fsync、IndexedDB、Worker schedulingは含まない。
本番レイテンシや、1,024件時点の性能を測定したものではない。

| 処理 | p50 | p95 |
| --- | --- | --- |
| 中央で16件を集約 | 0.258 ms | 0.358 ms |
| 中央で同じ16件を再送処理 | 0.127 ms | 0.147 ms |
| 中央で一覧3件を取得 | 0.040 ms | 0.048 ms |
| 端末で16 ticketと16 receiptを検証 | 2.249 ms | 2.356 ms |
| 端末でcheckpointを検証 | 0.068 ms | 0.081 ms |
| 中央で以前のアイテムを市場受理 | 0.097 ms | 0.106 ms |

サンプルでは16件分のcontrol JSONが27,861 bytesから807 bytesへ減った。
checkpointは714 bytes、一覧3件の応答は5,312 bytes、アイテム1件のlistingは376 bytesだった。
ID長やitem値でbyte数は変わるため、実装では各上限も別に検査する。

## Leanと検証

[`InventoryCompaction.lean`](../formal/lean/ConvergeAudit/InventoryCompaction.lean)に18定理、
[`Tests/InventoryCompaction.lean`](../formal/lean/Tests/InventoryCompaction.lean)に19例を追加した。
元ledgerとの一致、owner/unitの保存、重複拒否、再送時の不変性、履歴全体の出所、
holdを保存した市場判定、端末の16件・3件上限、中央累計のsafe integer上限を検査する。
checkpoint採用時には対象レシートが中央に残ることも証明する。

形式モデルは正確なrequest/head/receipt識別子を用いる。
実装のdigestによる識別にはSHA-256の衝突困難性、レシート認証には署名の偽造困難性を仮定する。
LeanはWebCrypto・SQLite・IndexedDBのrefinement、物理永続化、中央の可用性を証明しない。
既存Quintはprotocol回帰検査として実行し、この集約専用の分散モデルは追加していない。

```sh
just test-encounter-inventory
just bench-encounter-inventory
just prove-lean
just prove
just formal-check
```

Nodeは17戦への継続、全ページの参照、古いアイテムの市場受理、両側transactionのrollback、
応答消失、競合集約、別owner、改竄、鍵喪失、v1 imageの読込を確認する。
実Workerでは複数caseの保持中に集約し、DO eviction後の一覧復旧と市場保留を確認する。
Chromiumではarchive移管後の集約、市場受理、再読込、次の開始権の利用可否を確認する。

後続の[世代終了](./encounter-generations-ja.md)で1,024 admission上限を世代ごとに使い直せるようにした。
archiveの1 MiB・128登録枠も、全資料の解放後に世代を閉じて再利用できる。
旧出所とinventory索引の総保存量を無期限に圧縮する実装は残る。
取り消し・売買後のinventory更新、独立archiveの可用性、checkpointのオフライン包含証明は次の設計対象である。
