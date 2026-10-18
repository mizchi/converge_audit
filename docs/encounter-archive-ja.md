# archiveへの保管責任移転

更新日: 2026-10-18。
確定済みencounterのreplay資料を、クライアントのIndexedDBからauthority側の上限付きSQLite archiveへ移せるようにした。
caseが未解決でもローカル枠を空けられるが、caseの保持義務はarchiveへ引き継ぐ。
archiveへの受領応答、ローカルの削除許可、保持義務そのものの終了許可を分けている。

## 保存するもの

archive bundleは署名付きticket、所有者のcommit、公開済み乱数を含むreveal、確定レシート、全2 chunkの入力からなる。
入力とrootだけでは戦利品を再実行できないため、乱数とゲーム結果の証明書も同時に保存する。
authorityの非公開台帳行全体は保存・返却しない。

新規bundleではticket・commit・reveal・レシートの署名と相互の対応、chunk hash、canonical framing、全60 tickの入力の連続性を確認する。
ゲームkernelを再実行して確定し直す処理は追加しない。
独立した再検証には保存した資料からkernelを実行でき、Nodeテストで元の`finalStateDigest`と一致することを確認している。

## 保管と二種類の解放

```text
全量のローカルログを保持
  → archiveへ送信して署名・root・入力を検査
  → bundle・保管証明・容量counterを同じtransactionで永続化
  → 署名付き保管証明を返す
  → authorityが保管証明を検査し、ticket台帳へ固定
  → ローカル専用のhandoff許可を発行
  → IndexedDBの生ログ・予約・queue登録枠を一括解放

case受付とarchiveの保持は引き続き有効
  → 最低保持期限が経過し、全caseの解決通知が永続化
  → authorityが保持受付を不可逆に閉じ、archive削除許可へ署名
  → archiveのpayloadを削除し、再送用のtombstoneを残す
```

保管証明はarchive鍵、authority鍵、ticket・unit・queue、入力root、レシートID、chunk digest列、
bundle全体のdigestと保存byte数、保存時刻、最低保持期限、`authority-release-v1` policyを束縛する。
このpolicyは「期限が過ぎればarchiveが消してよい」という意味ではない。
最低保持期限と、authorityの保持終了許可の**両方**を必要とする。

ローカル用handoff許可はqueue・revision・終端sequence・保管証明IDを署名で束縛する。
既存の終了証明書用許可と異なる署名domainを使い、`retentionReleased`やcaseのholdを変更しない。
正規クライアントは事前に固定したarchive鍵で保管証明を検査し、同じrootの全ログが保存済みであることを確認してから解放する。
他のqueue、古いrevision、偽造証明では解放できない。

archive削除許可はauthority署名で保管証明ID・ticket・queue・root・保持終了時刻を束縛する。
authorityは既存のcase集計と同じ保持終了CASを使う。
case追加が先なら削除を拒否し、保持終了が先なら新規caseを拒否する。
archiveも証明の対応と最低保持期限を検査してから削除する。

## 実装とAPI

[`SqliteEncounterArchive`](../examples/cf-game-audit/game/encounter/archive-store.ts)は
[`EncounterArchive`](../examples/cf-game-audit/game/encounter/archive.ts)の参照実装である。
Cloudflare例ではauthorityと同じDurable Objectの別テーブルへ保存し、同じ永続署名鍵をdomain別に使う。
ローカルのIndexedDBとは保存主体が異なるが、authorityから独立した障害領域や第三者archiveを実装したものではない。
テストではauthorityとarchiveに別SQLite・別署名鍵を使う構成も検査する。
公開Workerは応答前に`storage.sync()`を待ち、保管証明や削除許可を永続化完了前に返さない。

既存の所有者署名付き`POST /v1/pve/:unit/encounter`へ次のcommandを追加した。
request/responseは既存の16 KiB制限を使い、別所有者はticketを取得・操作できない。

| command | 処理 |
| --- | --- |
| `archive-upload` | 確定ticketの2 chunkを送り、authorityが台帳のticket・commit・reveal・レシートと合わせて保存 |
| `archive-handoff` | 永続化済みの保管証明に基づき、現在のqueue snapshot用のローカル解放許可を取得 |
| `archive-read` | bundleと保管証明を取得。archive削除後はbundleを`null`としてtombstoneを返す |
| `archive-release` | 保持期限と全caseを検査し、archive payloadを解放 |

`EncounterRecorder.archive()`と`cleanupArchived()`でアップロードとローカル解放を分ける。
再取得した資料は`verifyArchivedBundle()`で全体digest・署名・対応関係・入力を検査できる。
HTTP transportの`archiveRead()`はデコードを行う層であり、それだけを資料の真正性の検証とは扱わない。

既定画面の「ログをサーバーへ預ける」は、確定後にこの経路を使う。
移管後はレシートを残して新しい割り当て済み開始権を使える。
リロードで解放済みqueueを再作成せず、元のレシートを復旧する。
市場受理には引き続き生ログを持ち歩かず、未解決caseがあれば受理を拒否する。

## 失敗と再送

| 状態 | 結果 |
| --- | --- |
| archiveの容量不足・保存transaction失敗 | 保管証明を返さず、ローカルログを残す |
| 保存後に受領応答を喪失 | archiveの資料とローカルの両方が残る。同じbundleの再送で同じ証明を復旧 |
| authorityが証明を保存する前に停止 | ローカル解放許可はまだない。再送で保存済み証明を台帳へ固定 |
| ローカル解放後、control保存前に停止 | リロードでqueue不在を検出し、レシートを復旧。archiveは保持を続ける |
| archive削除transaction失敗 | payloadとcounterをrollbackし、同じ許可で再送可能 |
| 削除後の古いupload再送 | tombstoneで拒否し、同じticketに新しい保管証明を作らない |
| 容量counterが欠けている・不整合 | 0へ初期化せず停止。保持済み資料の容量を隠さない |

同じbundleの再送はbyte列のhashと既存証明を照合する。
再署名・全署名の再検証・kernel再実行は追加せず、保存byte数や保管証明IDも増やさない。
これはbundle内の検査と保管証明の再送についての話であり、所有者署名付きHTTP要求の認証は毎回行う。
初回の並列uploadでは検証計算が複数回走ることはあり、採用する保存行と証明を一つにする。
crashをまたぐexactly-once計算は保証しない。

## 計算と保存の上限

| 領域・操作 | 上限・費用 |
| --- | --- |
| bundle | canonical JSONのUTF-8で最大11,000 bytes。入力は2 chunk・各4 KiB以下 |
| 保管証明 | 最大3,000 bytes。bundleとの取得応答を16 KiB内に収める |
| 参照archiveのpayload | DOごとに合計1 MiBまで。新規保存時にtransactionで予約・反映 |
| 参照archiveの登録数 | 既定で1世代128 ticket。設定上限1,024。世代終了までは削除済みtombstoneも数える |
| 新規保存 | bundle全体のhash、署名とログの検査、保管証明への署名、永続write |
| 同じ資料の再送 | 小さなbundleのhashと主キー参照。保管証明を読み出す |
| archiveの削除 | 保持状態と署名を検査し、payload削除とcounterを同じtransactionで反映 |

単に同じorigin内の別DBへ移した構成ではない。中央側の保管容量を消費するため、
上限では新しい移管を止め、期限だけで古い資料を押し出さない。
物理的なSQLiteページ・WAL・索引・証明書のoverheadまで1 MiBに収まる保証ではない。
起動時の整合検査は上限付きの登録行を走査し、通常の取得は主キーで参照する。
通信レイテンシや本番の可用性・料金を測定したものではない。

archive移管はreplay資料の保管責任を移す。
レシートのローカル16戦上限は、後続の[inventory checkpointへの集約](./encounter-inventory-checkpoint-ja.md)で継続できるようにした。
登録tombstoneは後続の[世代終了](./encounter-generations-ja.md)で下限を進めて回収できる。
archiveの自動GC scheduler、別サービスへの再移管は残る。
現在のarchive削除は所有者署名付き`archive-release`から明示的に行い、画面に専用の削除操作はまだない。

## Leanと検証

[`Archive.lean`](../formal/lean/ConvergeAudit/Archive.lean)の15定理と
[`Tests/Archive.lean`](../formal/lean/Tests/Archive.lean)の13例を追加した。
正確なbundleの永続化後にだけ受領証明を作るモデルで、次を検査する。

- 保管証明なしではローカルを解放しない。
- ローカル解放はcase受付・hold・archiveのコピーを変えない。
- 時刻経過だけではarchiveを削除できない。
- 保持終了と期限経過、holdなしをそろえてからarchiveを解放する。
- 保持義務が続く任意の履歴で、ローカルまたはarchiveに対象のコピーが残る。
- 既存のcase集計を接続しても、生きたcaseがあればarchiveの削除を拒否する。

この結論には、正規の初期状態、署名を偽造できないこと、保管証明が実際の永続化を表すこと、
archiveが許可なしに資料を消さないこと、正確なcase集計をhostが満たす必要がある。
LeanはSQLite/WebCrypto/HTTPのrefinementや、第三者の可用性を証明しない。
形式モデルのmanifestは識別子・root・レシート・最低保持期限を抽象化し、実装のbyte予算は別途テストで検査する。

```sh
just test-encounter-archive
just prove-lean
just prove
just formal-check
```

Nodeでは実暗号・SQLiteとIndexedDB adapterを使い、偽造・改竄、容量不足、保存・削除のrollback、
ACK喪失、同じ証明の復旧、counter喪失、削除済みticketの再保存拒否を検査する。
実Workerでは複数caseの保持中に移管し、DO eviction後の復旧、全case解決後の削除まで確認する。
実Chromiumでは画面から期限前に移管し、ローカル枠の解放、リロード後の復旧、次の開始権の利用可否を確認する。
既存Quintは回帰検査であり、このarchive全体の新規分散モデルは追加していない。
