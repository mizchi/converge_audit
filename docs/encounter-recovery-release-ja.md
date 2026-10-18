# 中断した戦闘の復旧情報を片付ける

報酬を確定せず終了した戦闘は、所有者が復旧を放棄したあと、世代を閉じると中央の記録も削除できる。
開始権の再利用は世代の下限で拒否するため、削除した戦闘ごとのtombstoneを残さない。
精算済みレシートはアイテム数が0でもこの経路で削除しない。

対象は`forfeited`で、署名付き終了証明があり、保持終了が確定し、手動holdも生きたcaseもなく、
レシート・市場受理済み資産・inventory索引・archive custodyがない戦闘だけである。
容量不足や一定時間の経過だけでは復旧情報を捨てない。

## 所有者とサーバーの手順

1. 端末が終了証明を検証し、従来のclosure grantでIndexedDBのpayloadと予約を解放する。
2. 「終了した戦闘を片付ける」を押す。次の戦闘を始める場合も、直前の中断戦闘に同じ処理を行う。
3. 端末は元のticket・終了証明を残したまま`recoveryReleasePending: true`を永続化する。
4. 所有者署名付きの`release-recovery`を送る。サーバーは元ticketと終了証明の署名を検証する。
5. 同じSQLite transaction内で現在の保持・case・資産状態を再確認する。
   現世代なら`recoveryReleased`を記録し、旧世代ならその出所行を削除する。
6. 応答が一致すれば、端末は現在の戦闘情報を一つのIndexedDB transactionで外す。
7. 現世代で承認された記録は、通常の管理者による世代終了transactionで稼働台帳から削除する。

世代終了の条件は従来と同じで、未消費の開始権や未解決の保持があれば停止する。
1回の世代終了が調べる稼働台帳は最大1,024件。過去の全世代を走査するGCは行わない。
世代の終了証明は削除対象も含めた元ticket・終了証明のdigestへ署名するが、これだけで過去の記録を復元したりMerkle inclusionを検証したりはできない。

## 応答消失と再起動

`release-recovery`には最大4 KiBの元ticketと元の終了証明を持たせる。
サーバーの応答消失や端末の保存失敗でも、端末にはこの証明とpending状態が残る。
再読込時はstatusを取得する前に同じ解放要求を再試行する。

その間に世代が閉じ、対象行が削除されても、次の条件なら同じ応答を返せる。

- HTTP要求の所有者・unitと元ticketが一致し、元ticketと終了証明が正しい署名を持つ。
- 署名で束縛されたticketの世代が現在より古く、終了証明の保持期限を過ぎている。

古い世代を閉じるには全戦闘の保持終了が必要だったため、行がなくても新たな解放権を作る必要はない。
終了証明から新しい報酬や開始権は作れない。現世代の行がない場合は成功扱いにしない。
応答は`released`・`ticketId`・`terminationId`だけで、持ち運ぶ新たな署名証明は発行しない。
所有者署名付き要求に対する、信頼するHTTPS endpointの応答として扱う。

未承認の中断記録は残すので、従来の古いstart/status/closureによる復旧を続けられる。
片付け済みの記録を削除したあとは、そのstart/statusは403になる。pendingを持つ端末だけが元の証明で解放を再試行する。

unitごとの`encounter_generation_floors_v1`も世代と同じtransactionで更新する。
すべての出所を削除し、archiveを使わない構成でもこの下限が残る。
世代headだけを失った場合は0へ初期化せず拒否する。全DB消失からの復元や外部バックアップの正しさを保証する仕組みではない。

## 計算量と保存量

旧出所数を`N`、現世代の戦闘数を`k ≤ 1,024`とする。
解放要求はHTTP所有者署名・ticket署名・終了証明署名の3回の検証と、固定長のhash、
ticket ID・inventory索引・上限付きcaseの照会で済む。ゲームのtickや過去の行動ログは持ち歩かない。
索引による検索・削除は`O(log(N+k))`であり、大きな台帳でも一定時間という主張はしない。
現世代での解放は1行更新、旧世代なら1行削除。世代終了の走査とhashは`O(k)`である。

復旧放棄には中断1件につき追加の所有者HTTP要求が1回必要になる。
未精算のまま中断した場合の基本経路は`start → terminate → closure → release-recovery`の4要求で、
一覧・状態の照会や再送は別にかかる。世代終了はさらに管理者要求が1回必要であり、測定では128件ごとに行う。
次のstartへの同梱や複数解放のbatch化はまだ実装していない。

| 記録 | 保存範囲 |
| --- | --- |
| 承認済みの中断戦闘 | 現世代だけ。世代終了後は0行 |
| 未承認の中断戦闘 | 復旧のため出所行を保持。自動削除しない |
| 精算済みレシートとinventory索引 | 従来どおり保持。空のレシートも含む |
| 世代headと下限 | unitごとにそれぞれ1行 |
| 端末の解放再試行情報 | 現在の戦闘1件の範囲。成功後に削除 |

承認済み中断戦闘だけを繰り返す経路では出所行が累積しない。
ゲーム全体の保存量はまだ一定ではなく、保有アイテムの出所、空の確定レシート、未承認の復旧、case履歴が残る。
SQLの削除はページの再利用を可能にするが、DBファイルやWALがその場で縮むことは測定していない。

[`bench-encounter-recovery.ts`](../examples/cf-game-audit/scripts/bench-encounter-recovery.ts)は128件の中断・解放を
21世代繰り返し、最初の1世代をwarmupとして解放2,560回・世代終了20回を測る。
実Ed25519、所有者署名付き要求、同一プロセスのHTTP encoder/decoderとSQLite `:memory:`を含む。
通信・fsync・Worker scheduling、大きな出所索引、case登録の費用は含まない。
測定artifactは[JSON](../examples/cf-game-audit/benchmarks/encounter-recovery-local-2026-10-18.json)を参照する。

| 処理 | p50 | p95 | 回数 |
| --- | --- | --- | --- |
| 中断1件の復旧放棄 | 0.330 ms | 0.404 ms | 2,560 |
| 128件の世代終了 | 2.456 ms | 2.695 ms | 20 |

サンプル内の元ticket＋終了証明は最大1,511 bytes、応答は150 bytesだった。
2,688件を処理しても、各世代終了後の稼働台帳・旧出所・開始権はそれぞれ0行で、世代headと下限が各1行残った。
最後の128件の稼働JSONは228,644 bytesで、旧出所JSONは0 bytesになった。
本番の要求時間やCPU上限を保証する数値ではなく、SQLのページ・索引・WALの物理容量も含まない。

## 証明と検査

[`RecoveryRelease.lean`](../formal/lean/ConvergeAudit/RecoveryRelease.lean)に23定理、
[`Tests/RecoveryRelease.lean`](../formal/lean/Tests/RecoveryRelease.lean)に23例を追加した。
レシートのある出所、hold中・保持中・未承認・現世代の行が残ること、収集の冪等性と行数の非増加、
対象をすべて片付けるとtombstoneが残らないこと、世代fenceを変えずに古い開始権を拒否できること、
応答待ちの端末が元の証明を保持することを検査する。
世代を進めず稼働行だけ削除すると同じ開始権を再発行できる反例も固定した。

`Generations.lean`の全出所保存定理は従来の「全行を移す」段階の性質である。
今回の収集は中断した出所を意図的に除くため、追加モデルでは「レシートのある全出所を保存する」性質を証明する。
暗号署名の偽造困難性、hostの認証済みowner承認・全case集計、SQLite/IndexedDBの永続化を仮定し、
暗号実装やDBへのrefinementまで証明したものではない。
収集の証明は選択した有限の行集合に対する性質であり、Leanのリスト処理からSQLの計算量を導いてはいない。
実装の対象が1件または最大1,024件に収まることは、実際のqueryとテストで別に確認する。

MoonBitでは解放の4条件、削除の6条件を実装し、postconditionと8補題、全16・64組み合わせのguard検査を追加した。
Nodeでは応答消失、端末保存失敗、中央rollback、遅れて届く解放、128件・8世代後の出所0行、
未承認の復旧維持と別アイテムの市場受理を検査する。
Workerでは実際のDO eviction後の再送、Chromiumでは中断・cleanup・片付け・世代終了・再読込を検査する。
Quintは既存protocolの回帰検査であり、今回の分散モデルを新設したものではない。

```sh
just test-encounter-recovery
just bench-encounter-recovery
just prove-lean
just prove
just formal-check
```

後続の[空レシートの片付け](./encounter-empty-inventory-ja.md)では、inventoryのordinalを範囲へまとめ、
lost-response時のcheckpoint再試行を維持して空の精算済みレシートも削除できるようにした。
保有しなくなった資産の出所をどこまで外せるかは引き続き課題となる。
