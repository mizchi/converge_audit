# 空の精算レシートとinventoryの番号範囲

アイテムを取得せず精算した戦闘は、保持を終了して世代を閉じたあと、所有者がinventoryから片付けられる。
元の出所とinventoryの1件ずつの索引を削除し、削除した連番を最大の連続範囲へまとめる。
空レシートが何件連続しても、その区間は範囲1行になる。
この参照ゲームの経済報酬は`items`だけである。通貨・経験値・別の開始権などを生むゲームへ適用するときは、
それらの確定状態を保存する条件も必要であり、アイテム数0だけで削除してはいけない。

累計精算件数は変えず、残したアイテムの連番と元の署名も変えない。
未精算の中断戦闘を扱う[復旧放棄](./encounter-recovery-release-ja.md)とは別の処理である。

## 削除できる条件

所有者署名付きの`inventory-retire-empty`へ、現在のcheckpoint IDと1〜16件のticket IDを送る。
元の行動ログ、ticket全文、レシート全文は送らない。順序も要求の署名とbatch digestに束縛する。

サーバーは各ticketについて、次を確認する。

- 同じowner・unit・rulesの精算済みレシートで、アイテム・市場受理済み資産・archive custodyがない。
- 保持期限を過ぎ、保持終了が確定しており、手動holdも生きたcaseもない。
- 署名付きticketの世代が現在より古い。現世代の開始権の記憶は削除しない。
- 最新checkpointのinventory索引に、同じticket ID・receipt ID・有効なordinalがある。

署名の前に検査し、署名後のtransaction内でも全条件、行のrevision、索引のordinalを再確認する。
そのtransactionで出所・索引を削除し、番号範囲の結合とcheckpointの更新も行う。
どこかが失敗すれば全部を戻す。ゲームを再生したり元レシートを再発行したりはしない。
別のbatchが先に同じcheckpointを進めた場合は拒否する。

## checkpoint v2と互換性

v1の署名frameとappend処理は従来のまま残す。最初の空レシート削除でv2へ進み、以後のappendもv2を使う。
v2の署名には操作種別と削除済み空レシート数を加える。

| 値 | 空レシートを削除したとき |
| --- | --- |
| `receiptCount` | 累計精算件数のため変えない |
| `itemCount` | 変えない |
| `retiredEmptyCount` | 今回の削除件数を加算 |
| `revision` | 1だけ進める |
| `operation` | `retire-empty`。通常の集約では`append` |
| `previousId`・`root`・`batchDigest` | 前checkpoint・操作・順序付きticket IDへ束縛 |

`itemCount + retiredEmptyCount ≤ receiptCount`を維持する。
全counterはJS safe integer以内とし、revisionの加算も上限で拒否する。
rootは操作履歴へのcommitmentであり、Merkle inclusion proofではない。

番号に穴を開けた古いcheckpointを引き続き使うことはできない。
新checkpoint・出所削除・範囲更新が同じtransactionなので、削除前のsnapshotへのページ要求は409になる。
v2を扱えない旧clientへの同時運用や、旧server binaryでの書き込みは対応範囲に含めない。

## ページと範囲の例

元のordinalが「1: 空、2: アイテムあり、3: 空」なら、削除後は次の形になる。

```json
{
  "positions": [2],
  "emptyRanges": [{ "first": 1, "last": 1 }, { "first": 3, "last": 3 }],
  "records": ["元ticketと元レシートのrecord"],
  "after": 0,
  "next": null
}
```

実応答にはcheckpoint IDも入る。1ページはレシートと範囲を合わせて最大3要素である。
端末が持つ元レシートは引き続き最大3件で、ページを移ると前のcacheを置き換える。
各要素が直前の末尾＋1から始まり、最後のordinalが`next`または累計件数と一致することを検査する。
範囲の中から指定した`after`にも、残りの部分範囲を返せる。

空レシート1〜128を全部片付けた場合は範囲`[1,128]`だけを返し、128回のページ照会を行わない。
後から129件目のアイテムをappendしても、元のordinal 129と署名で参照・市場受理できる。

範囲情報の正しさは、認証されたauthority APIとそのtransactionを信頼する。
端末はboundedな連番・件数と元レシートの署名を検査するが、範囲にアイテムが含まれないことを
不信なサーバーに対して暗号学的に証明するページではない。v1でも一覧の完全性に同じ信頼境界があった。

## 再試行と端末保存

画面の「空のレシートを片付ける」は、表示中の最大3件の空レシートを対象にする。
HTTP contractは最大16件をまとめられる。自動的に全ページを巡回する処理は入れていない。
ローカル復旧に残しているレシートや、まだ後片付けしていない戦闘があれば拒否する。

端末は現在のcheckpointを残したまま、前checkpoint IDとticket IDの保留要求をIndexedDBへ保存する。
返ってきたcheckpointの署名、scope、操作、前ID、件数、digest、rootが合う場合だけ、
新checkpointへの置き換えと保留解除を1回のIndexedDB transactionで行う。
元ticket・レシートを保留情報へ重複保存しない。

サーバーは直前の操作の`previousId`と`batchDigest`が一致すれば、出所を読む前に同じcheckpointを返す。
そのため、出所が削除済みでも応答消失や端末保存失敗から復旧できる。
後の操作でheadが進んだあとの古い再送を受理する無制限の履歴cacheは持たない。
clientは保留要求を完了してから次の集約・プレイへ進む。複数deviceが同じ鍵で競合するheadの自動統合は未対応である。

ネットワーク切断、5xx、内容の合わない200応答は保留のまま再試行する。
信頼するendpointからの409は、その要求が確定しなかった応答として保留を解除し、checkpointを維持する。
現世代で片付けを試みたことで、未消費の開始権を使えず世代も閉じられなくなる状態を避ける。
実DOは従来どおり`storage.sync()`の後に応答する。

## 計算量と残る保存量

残る出所・索引数を`N`、番号範囲数を`G`、batch件数を`b ≤ 16`とする。
削除は最大`b`件の出所と索引を調べる。各ordinalについて範囲の直前と直後だけを索引で取得し、
隣接する範囲を最大2行削除して1行にまとめる。過去の全履歴や全範囲を走査しない。
索引の操作は`O(b(log(N+1) + log(G+1)))`で、hash入力は`O(b)`。
サーバーはHTTP所有者署名を1回検証し、新checkpointへ1回署名する。端末はその署名とdigest/rootを検証する。
元レシートの再計算・全件再検証・ゲームtickの再実行はない。
ページも最大3要素の照会で、巨大な空区間を1要素で通過できる。

完全に結合された範囲の数は、残るレシート数＋1以下になる。
全件空レシートを順次片付ける経路では、累計が増えても出所0行・inventory索引0行・範囲1行になる。
同じunit/ownerには最新checkpointも1行残る。
アイテムのある出所、未承認の空レシート、保持中の資料、case履歴は引き続き保存する。
ゲーム全体のディスク使用量を一定にしたものではなく、SQLiteのページ・WALが即座に縮む保証もない。

追加通信はbatchごとに1要求。管理者による世代終了と、候補を表示する既存のページ取得は別に必要である。
端末の自動巡回・旧世代全体の自動削除・startへの要求同梱は未実装。

[`bench-encounter-empty-inventory.ts`](../examples/cf-game-audit/scripts/bench-encounter-empty-inventory.ts)は、
実際の空精算を128件ずつ21世代、計2,688戦行う。
1世代をwarmupとし、16件batchの削除160回と全空ページ取得20回を測る。
所有者署名付き要求、同一プロセスのHTTP、実Ed25519、SQLite `:memory:`、端末相当のcheckpoint署名とdigest/root検証を含む。
ネットワーク・fsync・IndexedDB・Worker scheduling・case登録の費用は含まない。
測定結果は[JSON](../examples/cf-game-audit/benchmarks/encounter-empty-inventory-local-2026-10-19.json)へ保存する。

| 処理 | p50 | p95 | 測定回数 |
| --- | --- | --- | --- |
| 16件の空レシート削除と端末相当のcheckpoint検証 | 1.570 ms | 9.304 ms | 160 |
| 全空ページの取得と構造検証 | 0.189 ms | 3.784 ms | 20 |

計測値はこのホストの経過時間であり、CPU消費時間そのものではない。
NodeのGC・OS待ち・暗号処理待ちを分離しておらず、p50とp95にも差がある。
Worker外側のsource rate limit、cold start、大きな資産索引も測定対象ではない。

各世代の最後には出所0行・inventory索引0行となった。
最後の128件の出所JSONは278,034 bytesから0 bytesへ減り、累計2,688件を表す範囲`[1,2688]`が1行残った。
最新checkpointは最大834 bytes、全空ページは最大173 bytesだった。
物理的なSQLiteのページ・索引・WALやcaseの容量を含む値ではない。

## 証明と検査

[`EmptyInventory.lean`](../formal/lean/ConvergeAudit/EmptyInventory.lean)に30定理、
[`Tests/EmptyInventory.lean`](../formal/lean/Tests/EmptyInventory.lean)に25例を追加した。

- 圧縮して展開すると、元の連番付きslot列と一致する。
- 片付けたあとも全アイテムと累計件数が一致する。
- アイテムあり・hold中・保持中・現世代のレシートは消えない。
- 空区間は1行になり、範囲数は残るレシート数＋1以下、総行数はその2倍＋1以下になる。
- 同じ直前操作は削除済み出所なしで再試行でき、件数を二重加算しない。
- 違う古い要求、重複ID、空batch、16件を超えるbatch、条件不成立の削除を受理しない。

従来の`InventoryCompaction.lean`は全レシートを索引に保持する段階のモデルである。
今回のモデルでは、削除した空レシートを番号slotとして表し、アイテムと連番を保存する性質を証明する。
数学モデルの`pack`は圧縮形式の意味を定義するものであり、実装の全履歴走査を指示するものではない。
実装は有界batchを局所的に結合する。SQLの計算量・暗号の偽造困難性・DB永続化へのrefinementは証明していない。
元レシートの認証とowner/unitの一致、不可逆な保持終了、全caseの集計はhostが供給する事実として仮定する。

MoonBitには6条件のguardとpostcondition、7補題を追加し、auditと実Worker exportの両方で全64組を確認する。
Nodeは両側の範囲結合、rollback、署名待ちのcase変化、競合batch、四世代128戦、v2後のappendと市場受理を検査する。
実WorkerはDO eviction後の再送と残るアイテムを、Chromiumは確定直後に応答を落としたIndexedDB復旧を検査する。
Quintは既存protocolの回帰検査であり、この追加操作専用の分散モデルは新設していない。

```sh
just test-encounter-empty-inventory
just bench-encounter-empty-inventory
just prove-lean
just prove
just formal-check
```

次の課題は、アイテムを譲渡・消費した後の出所と受理履歴をどこまで保持するかである。
現在のencounter参照実装には譲渡・消費の確定条件をまだ接続していないため、この経路で資産ありのレシートを削除しない。
