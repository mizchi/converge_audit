# 中断したencounterの終了とログ・予約の解放

更新日: 2026-10-18。[容量予約と認証付きAPI](./encounter-http-and-reservation-ja.md)へ、
未確定ticketの終了を追加した。途中まで記録したログや未使用予約を、報酬確定から切り離して解放できる。

## 終了できる状態

| 操作 | 初回に許す条件 |
| --- | --- |
| `terminate(ticketId, "abandoned")` | 所有者が署名し、報酬が未確定。issued / committed / revealedを中断 |
| `terminate(ticketId, "expired")` | 所有者が署名し、commitがなく、サーバー時刻がcommit受付期限へ到達 |
| 同じticketの終了再送 | 保存済みの同じ終了証明書を返す。理由・時刻・保持期限を変更しない |

commit済みticketを時間経過だけで失効させる処理は追加していない。
その中断には所有者による明示的な`abandoned`要求を使う。自動失効schedulerも未実装である。
確定済み報酬の取り消しや、アイテムの無効化にはこの操作を使わない。

終了は台帳のphaseを`forfeited`にする。元のticket、使用済み開始権、commitment、公開済みseedの記録を残す。
以後はcommit・reveal・settleを拒否し、新しい報酬も市場受理も作らない。
初回終了の時刻が発行・commit受領・revealの時刻より前なら拒否する。
同じ開始権でstartを再送しても元のticketを返し、再抽選や開始権の返却は行わない。

終了とsettleは同じ行のrevisionを比較して更新する。
先にsettleが保存されれば終了を拒否し、先に終了が保存されればsettleを拒否する。
署名やreplayが並行して走っても、両方の結果を保存しない。
これは台帳へ採用する結果の一意性であり、実際の計算を一回に制限する保証ではない。

## 終了証明書と削除許可

終了証明書は次の内容をauthority署名で束縛する。

- ticket / unit / startHead / player / 所有者鍵 / queue / rules ID
- 固定済みroot。commit前なら`null`
- 終了理由、終了時刻、保持期限

終了証明書を作るだけではログを消さない。終了時刻から既定10秒の検証用保持期間を置く。
保留があれば期限後も解放しない。保持期間は参照設定であり、本番の異議受付期間を推奨する値ではない。
確定資産の複数caseは[既存case serviceのview](./encounter-cases-ja.md)から集計する。
資産がない中断戦闘の外部case受付は別工程であり、現状は信頼するhostのmanual holdを使う。

```text
所有者が中断を署名 → 台帳へ終了を保存 → 署名付き終了証明書
  → 保持期限到達・保留なし → 新しい保留の受付を不可逆に終了
  → 現在のqueue revisionとnextSequenceに対する削除許可
  → 全生ログ・未使用予約・queue登録枠を同時に解放
```

公開HTTPの`command.op`へ`terminate`と`closure`を追加した。
`terminate`は`{op, ticketId, reason}`、`closure`は`{op, ticketId, expectedRevision, nextSequence}`。
どちらも既存の所有者署名、unit束縛、body上限、rate limitの対象である。
署名付き削除許可は`{queueId, expectedRevision, nextSequence, closureId, authorization}`。
`closureId`は終了証明書のdigest。通常の確定ログ用prune grantとは署名domainを分ける。

authorityは削除許可を出す前に`retentionReleased`を保存する。
以後は新しいholdを拒否し、一度発行した許可の意味を後着のholdで変えない。
現在の参照ゲームは単独encounterで、settle以前に他のscopeへ資産や効果を出さないことを前提とする。
外部への未解決参照があるゲームでは、それをholdへ反映するまでこの終了許可を発行してはならない。

## ローカルの削除

`IndexedDbAuditPayloadPool`へ`releaseClosed(grant)`を追加した。
署名を検証した後、一つのtransactionでrevisionとnextSequenceを照合する。
認証を待っている間にappendされれば`concurrent_write`とし、ログを残す。
同じIDでqueueを作り直しても、古いハンドル・古いrevisionの許可は新しいqueueを削除できない。

正常に通れば、そのscopeだけのpayload、未使用byte/item予約、管理枠を返す。
途中の書き込み失敗では全部rollbackし、他queueのpayloadや予約は変更しない。
読み出しは最大65件、削除対象は最大64件に制限する。このencounterは最大2件なので一度で解放できる。
64件を超える一般queueにはこの一括解放を許さず、別の分割保持処理が必要になる。

終了時に生ログをサーバーへ送らず、ゲームreplayもしない。
サーバーは固定サイズの台帳行の参照・CASと署名で処理し、終了と削除許可は別の2要求とする。
これは報酬を永久に断念したscopeの終了であり、ゲーム実行の妥当性を軽量に証明する仕組みではない。
ローカルだけが最大2 chunkを読んで消す。今回この経路の追加レイテンシは測定していない。

一度も記録していない予約は従来の`releaseEmpty()`でも返せる。
一度記録したログは、終了証明書と専用許可を経て解放する。
通常pruneのACKや、「clientが中断した」という申告だけを代用しない。

```ts
const termination = await recorder.terminate("abandoned");
// 保持期限に達し、authorityが全holdの終了を確認した後:
const result = await recorder.cleanupTerminated(termination);
```

保持中にcleanupを要求するとHTTP 409になり、ローカルのログと予約は残る。
再起動後は同じticket / queueを開き直し、`terminate`の再送で同じ証明書を復旧できる。
終了・保持終了・削除の通信が失敗しても、署名と台帳の再読出しを使ってやり直す。
削除成功後の古いローカルハンドルは使用できない。poolの物理disk空き保証や、ブラウザによるDB消去の防止は含まない。

既存の信頼するhost向け`forfeit`で終了した行には、最初の`terminate`で証明書を作る。
その時点から保持期間を数え直し、過去の保持終了を推測して早期削除しない。

## 証明と確認

[`Termination.lean`](../formal/lean/ConvergeAudit/Termination.lean)の20定理・16例で、
終了後の報酬確定・市場受理の拒否、任意長の終了後履歴でのterminal性、開始権・root・holdの保存、
期限前のexpiry拒否、証明書を変えない再送、保持終了後のhold拒否を検査する。
[`Reservation.lean`](../formal/lean/ConvergeAudit/Reservation.lean)には3定理・2例を加え、
終了解放後の容量上限と、他scopeの実使用・予約を保存する条件を検査する。

MoonBitへ終了とcleanupの2 guard・11補題を追加し、game workerのJS / WASM-GC bridgeから呼べるようにした。
TypeScript authorityはそのJS gateを実際の判定に使う。
生成されたgame worker moduleの初期化は要求処理内で遅延実行し、Worker起動時の乱数初期化を避ける。
絶対UNIX millisecondをIntへ縮めず、safe-integerを検査してから期限との順序を0/1へ写す。
Leanでもこの写像の順序保存と範囲を検査し、Nodeでは2^31・2^32・UNIX時刻・MAX_SAFE_INTEGER付近を通している。
これは境界条件の一致を確認するもので、HTTP・署名・SQLite・IndexedDB全体へのrefinement proofではない。

実装テストでは署名を待機させ、settleと中断のどちらが先に保存されても片方だけが残ることを再現した。
Nodeで未使用・部分ログ・競合append・失敗rollback・偽造許可・別queueの保持を確認する。
workerdで実SQLiteとeviction後の終了証明書・保持終了の永続性、Worker入口で所有者署名を確認する。
Chromiumでは部分ログを残して中断し、reload後に証明書を復旧して、偽造許可の拒否と実許可での解放まで通す。
ChromiumのHTTP境界はNodeの実APIへinterceptし、本番network性能は測定しない。
Quintは既存protocolの回帰検査で、この終了処理専用の分散モデルは追加していない。

```sh
just test-encounter-lifecycle
just test-payload-pool
just prove-lean
just prove
just formal-check
```

既定ゲーム画面の復旧・終了・解放は[接続済み](./encounter-ui-ja.md)。
旧保存形式の移行、資産失効・appeal、中断/部分ログのarchive接続、全originの保存予算、本番用暗号gateの移行は残る。
確定済みreplay資料の[archive移管](./encounter-archive-ja.md)は接続済みである。
この作業では本番公開や、既存ゲームの所有権・売買フローの切替は行っていない。
