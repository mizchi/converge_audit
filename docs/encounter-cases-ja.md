# encounterのcase集計と保持終了の競合

更新日: 2026-10-18。
既存の署名付きcase serviceを、確定済みencounterの資産へ接続した。
caseの受付、裁定、sourceによる解決通知には既存の認証・cursor・永続化経路を使い、
新しいencounter側adapterで、そのcaseが市場受理と生ログ解放を止めるようにした。

## 受付から解放まで

```text
source署名付きのcaseを受付
  → case・inbox・ticketとのbinding・ticket revision更新を同じtransactionで保存
  → 市場受理と削除許可を拒否
  → arbiter署名でcaseを棄却
  → まだholdは解除しない
  → 同じsourceの署名付き解決通知を、正しいcursorと完全一致する裁定IDで受付
  → 全caseの通知が永続化され、manual holdもなければhold解除
  → 保持期限と確定条件を満たした削除許可を発行し、以後の新規caseを拒否
```

複数caseを一つのboolへ上書きするAPIにはしていない。
`EncounterAuthority`は従来のmanual holdに加え、永続case viewの集計結果も確認する。
一つのcaseの解決や`setEvidenceHold(false)`で、他のcaseのholdを外すことはできない。
case行が欠けている、裁定がまだない、解決通知がまだない、のいずれもholdとして扱う。
不整合を検出しても、容量を空けるためにログを捨てない。

## 公開contract

入口は既存の以下のAPIを使う。caseの対象は確定レシートに実在する最大1資産で、
入力ログそのものをcase要求に持ち歩く必要はない。

| 操作 | API | 認証 |
| --- | --- | --- |
| case受付 | `POST /v1/pve/:unit/game-asset-lineage-cases` | 登録sourceの署名付きhold、exact reference |
| 棄却裁定 | `POST /v1/pve/:unit/game-asset-lineage-case-dismissals` | admin入口と登録arbiterの署名 |
| 解決notice取得 | `POST /v1/pve/:unit/game-evidence-case-resolution-polls` | 既存のsource認証とaudience/cursor検査 |
| 解決通知の受付 | `POST /v1/pve/:unit/game-evidence-case-resolution-envelopes` | 同じsourceの署名、exact resolution、連続cursor |
| 市場受理・削除 | 既存の署名付き`encounter`操作 | 所有者署名に加え、全caseの保持状態を検査 |

新しいencounter referenceは次の値に固定する。署名されているだけでは受理しない。

| field | 値 |
| --- | --- |
| scope / unit | `reference-game` / ticketのunit |
| asset ID | `receipt.statement.items`に実在するID |
| ancestor ID / kind | `receipt.receiptId` / `origin` |
| epoch / checkpoint digest | `0` / 確定した入力root |
| boundary protocol / purpose | `1` / ticketのrules ID |
| boundary manifest | ticketの256 bit秘密に対するseed commitment |
| boundary scope / unit | ticketのplayer ID / queue ID |

同じcaseの再送は既存caseを返す。解決済みcaseを再びholdへ戻さず、source cursorも増やさない。
ログ解放後の同じcaseの再送も同様であり、新規caseの受付とは区別する。
署名の偽造、別のreceipt・root・queue・manifestへの付け替え、誤った裁定IDによる解決は拒否する。

## 削除許可との競合

`encounter_evidence_case_bindings`はcase IDを既存case serviceの行とticketへ対応付ける。
case追加時は`fenceEvidenceCase`でticketのrevisionを更新する。
binding、case、inbox、revisionはDurable Objectの同じ`transactionSync`で保存し、成功してからACKする。
途中で失敗すれば、全部をrollbackする。

| 先に保存した操作 | 後着の操作 |
| --- | --- |
| case追加とrevision更新 | 古いrevisionによるretention CASを拒否。再読込でholdを検出 |
| retention終了のCAS | 新規case受付を拒否。case・inbox・bindingを作らず、cursorも進めない |

許可への署名を待つ間に新しいcaseが来ても、すでにretentionを不可逆に閉じていれば受付を拒否する。
発行済みの削除許可を、後から追加したholdで取り消す構成にはしない。
これは受付順序の保証であり、無期限の異議受付や公平な通信配送を保証するものではない。

## 計算と保存の上限

1 ticketにbindingを**生涯最大16 case**まで作る。解決済みbindingも消して枠を再利用しない。
同じcaseの再送は枠を使わず、17件目の新規caseは保存前に409で停止する。
これは新しいencounter bindingの件数上限であり、既存case service全体や全originのbyte予算ではない。

| 処理 | 追加の仕事 |
| --- | --- |
| case対象の取得 | asset ID中のticket IDから、台帳の主キーを参照。レシート内の実在資産を確認 |
| holdの確認 | ticket用binding索引と、case/notice主キー索引を参照。最大16 bindingを確認 |
| 市場受理 | 所有者署名検証の前と、採用直前にholdを再確認 |
| 削除許可 | 全caseが解決済みかを確認し、ticketのretention CASを実行 |
| プレイ中 | case用のtickごとのRPCや保存は増やさない |

全行replayや、過去のゲーム履歴の走査は追加していない。
SQL索引の探索には全体の行数に応じた費用があり、数学的な定数時間を主張するものではない。
初回の60 tick全replay、市場受理時に生ログを要求しない境界は維持する。

## 証明と検査

[`Cases.lean`](../formal/lean/ConvergeAudit/Cases.lean)の14定理と
[`Tests/Cases.lean`](../formal/lean/Tests/Cases.lean)の14例で、次を検査する。

- 生きたcaseが一つでもあれば保持を終了できない。
- manual holdの解除や、裁定だけではcaseのholdが消えない。
- 解決通知は同じsourceと裁定を必要とし、他のcaseを変更しない。
- case追加後は古いrevisionで保持を終了できない。
- 保持終了後は新規caseを受け付けず、占有したcase枠を上書きしない。
- case集計を既存の`Encounter.marketRead`と`Encounter.retire`へ接続しても、これらの拒否条件が成立する。

有限slotと実際のcase IDの一意な対応、真正な署名、正確なSQL view、同一transaction内のfenceはhostの責務である。
Leanはその条件下の判断を証明し、SHA-256/Ed25519やTypeScript・SQLiteのrefinementを証明しない。

```sh
just test-encounter-cases
just prove-lean
just prove
just formal-check
```

Nodeでは複数case、manual hold解除による迂回、裁定だけでの削除、競合CAS、失敗rollback、
16件上限、不整合行を検査する。実Workerでは既存のsource/arbiter署名付きAPIを使い、
2件の受付、棄却、exactな解決通知、DO eviction、最後のhold解除、市場受理、削除、後着case拒否を通す。
既存Quint検査は回帰検査であり、新しいencounter binding全体のQuintモデルを追加したものではない。

## 残る接続

今回の対象は確定資産のorigin caseと、その棄却・sourceによる解決である。
不正認定後のencounter資産失効・appeal、資産を作らなかった戦闘の外部case受付、
未対応の裁定を理由にholdを自動解除しない。
確定済みreplay資料の[archiveへの保管責任移転](./encounter-archive-ja.md)は接続済みで、移管後もcaseの保持を続ける。

既存source relayのbuilderはcursorとnoticeのboundary一致を要求する。
同じsourceが複数の異なるencounter boundaryを同時に処理する自動relayには、別途その対応が必要である。
今回のWorkerテストは同じticket boundaryの2 caseを検査したもので、自動relayの多boundary運用の保証ではない。

新しい既定画面はcaseによる削除拒否でログを保持するが、case一覧や保持理由の専用表示はまだない。
raw pool、control、case service、archiveを合計した保存予算や、archiveなしで新規開始を無期限に続ける保証もない。
