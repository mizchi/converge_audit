# 1 encounterの記録・確定・市場受理・削除

更新日: 2026-10-18。最初の統合経路を、固定60 tick・単独プレイヤー・最大1アイテムに限定して実装した。
実装は[game/encounter](../examples/cf-game-audit/game/encounter/index.ts)。
クライアントの接続処理は[EncounterRecorder](../examples/cf-game-audit/web/src/audit/encounter-recorder.ts)へまとめ、
記録・署名・返却された乱数とレシートの検証・市場受理・削除を同じcontractで実行する。
公開Worker APIと開始前容量予約は[接続済み](./encounter-http-and-reservation-ja.md)。
[既定のゲーム画面](./encounter-ui-ja.md)もこの経路へ切り替えた。
[共有payload pool](./shared-payload-pool-ja.md)への切替により、複数encounterの生ログも同じ容量予算を使う。

## 通るようになった経路

```text
ログ全体の容量を予約 → 認証された開始権で署名付きticketを発行
  → 入力30件ごとにchunkを作り、容量制限付きIndexedDBへ記録
  → 所有者署名付きの入力rootを一度だけ固定
  → サーバー時計の公開時刻後に、固定済み乱数を署名して公開
  → 固定した入力60件を実際のゲームkernelで再実行
  → 拾得したアイテムに確定レシートを発行
  → 市場ではレシートID・確定台帳・所有者署名を確認
  → 保持期限と保留の終了後、署名付き許可で生ログを削除
```

公開されていたseedをそのまま使う既存モードとは別の経路である。
秘密はticket発行時にCSPRNGで256 bit生成し、authorityのSQLite行へ保存する。
プレイヤーにはticket固有の`H(ticketId, secret)`だけを先に渡す。
32 bitのkernel seedへ変換するのは入力rootの固定と公開の後であり、
32 bit seedのhashを事前公開して列挙可能にする構成にはしていない。
同じ開始権の再送では同じticketを返し、破棄・期限切れ・再起動によって再抽選しない。

入力rootにはticket、unit、開始権、プレイヤー、所有者鍵、rules ID、queue世代、件数とchunk digest列を束縛する。
replayではchunkの連続性、件数、canonical framing、hash、tick順、入力axisを検査する。
アイテムの値・個数はクライアントの申告から受理せず、kernelの最終inventoryから取り出す。
asset IDへticket IDを付け、異なるencounterの32 bit seed衝突で同一資産を作らない。

## 計算と持ち歩くデータ

最初の確定では**全60 tickのreplayが必要**。これは楽観的監査へ移る前の基準となる経路である。
市場受理は過去の入力を要求せず、固定サイズに制限した確定行の参照と所有者署名の検証で済む。
同じ確定要求の再送では保存済みレシートを返し、replayしない。
ローカルの生ログ削除後も`restoreReceipt()`で署名付きレシートを再取得でき、市場受理のためにログを復元し直す必要はない。
同時確定ではSQLiteのrevision比較により、採用する結果を一つにする。
並列要求のreplay処理そのものが一回しか走らないことや、crashをまたぐexactly-once計算は保証しない。

[ローカル実測](../examples/cf-game-audit/benchmarks/encounter-local-2026-10-17.json):
Node v24.21.0 / darwin arm64 / SQLite `:memory:`、warmup 20回、測定200回。

| 処理 | p50 | p95 |
| --- | ---: | ---: |
| 60 tickの検査・replay・確定署名・保存 | 0.135 ms | 0.263 ms |
| 市場受理 | 0.098 ms | 0.238 ms |
| 確定要求の再送 | 0.0065 ms | 0.0105 ms |
| 削除許可の署名・発行 | 0.054 ms | 0.127 ms |

この入力例の生ログは2 chunk合計661 bytes、レシート984 bytes、市場要求376 bytes、削除許可445 bytes。
これは小さな参照ゲームの測定であり、通信、disk fsync、Worker scheduling、browser処理を含まない。
複雑な実ゲームのreplayやremote APIのレイテンシをこの数値から見積もることはできない。
start / commit / reveal / settle / market / pruneは公開APIでも別操作で、
RPC統合と確定頻度の調整は未実装である。HTTP追加署名の費用はこの内部service実測には含まれない。
60 tickと3秒の最短commit待機は検証用設定であり、通常ゲームへその頻度を推奨する値ではない。
待機時間はサーバーの受領時刻を制限する条件であり、その間に人間が操作したことや、公開情報で探索しなかったことの証明ではない。

このrecorderの1 queueは最大16 KiB、そのうち8 KiBをheadroomとして残し、payloadは2件・各4 KiB以下に制限する。
共有poolの既定値は1 MiB中896 KiBをpayload用に使い、256 chunk・128 queueまでとする。
prune後の登録枠は`release()`で返せる。レシートだけの復旧はqueueを作らない`recoverReceipt()`でも行える。
削除許可はqueue世代、revision、prefix終端、checkpointを署名で束縛する。
保留の追加と保持終了を同じ台帳のCASで競合させ、保持を終了した後の新規保留は拒否する。
発行済み削除許可を後着の保留で無効化しないためである。

## 証明と実装の対応

[`Encounter.lean`](../formal/lean/ConvergeAudit/Encounter.lean)の15定理と
[`Tests/Encounter.lean`](../formal/lean/Tests/Encounter.lean)の17例で、次を検査する。

- 固定したrootと、同じticketの公開seedで実行した結果だけを確定する。
- 保留中の報酬は市場へ受理しない。
- consume後に再びmintしない。APIの再送応答は保存した結果の読み出しとして扱う。
- 確定、期限到達、保留なしがそろうまで保持を終了しない。
- 保持終了後は保留を追加できず、保持操作は確定済み結果を変えない。
- 使用済み開始権は、その後の発行履歴によって復活しない。

MoonBitでは[x/game_audit/audit/encounter_chronology.mbt](../src/x/game_audit/audit/encounter_chronology.mbt)に
4 guardと13補題を追加した。commit前、reveal後、consume一回、retention終了の条件を表す。
TypeScript hostがこのMoonBit guardを呼ぶbridgeは未接続であり、異言語間の完全なrefinement proofではない。
MoonBitのInt時計へ接続するときには、絶対UNIX millisecondを直接縮小せず、検査済み相対時刻へ変換する必要がある。

Leanのrootは認証済みログを表す抽象値である。
SHA-256/Ed25519の安全性、authority時計、秘密の漏洩防止、SQLiteの永続CAS、
ゲーム規則そのものの正しさは、このLean証明の結論に含まれない。

```sh
just test-encounter-lifecycle
just bench-encounter
just prove-lean
just prove
just formal-check
```

Nodeでは実暗号、SQLiteのclose/reopen、IndexedDBのrestore、改竄・重複・並列確定・holdを検査する。
Playwrightでは実Chromiumに記録したログをリロード後に取り出し、authorityの実replayで市場受理まで進め、
実署名による削除許可でのみ削除できることを確認する。
workerdでは実Durable Object SQLiteで一意発行・CASとeviction後の確定行保持を検査する。
Quintの既存protocol検査も回すが、この新しいencounter全体のQuintモデルを追加したものではない。

## 次に接続する順序

1. 旧snapshotなどの移行、全originの保存予算、上限に達したレシートのarchive責任移転を実装する。新画面のcontrol領域は80 KiB・最大16戦分で停止する。
2. 接続済みの[case集計](./encounter-cases-ja.md)を資産失効・appealへ広げる。
   確定済みreplay資料の[archive移管](./encounter-archive-ja.md)は接続済みで、部分ログ・別保管サービスへの拡張は残る。
3. 既存の所有権移転・市場listingへ接続する。ここでの市場処理は受理判定までで、売買や移転を実装しない。
4. データ可用性、watcher、期限内の異議受付を先に成立させてから、初回全replayを楽観的監査へ置き換える。

`issue`と`setEvidenceHold`は信頼するhost専用操作である。
manual holdに加え、既存case serviceに結び付けた全caseを[集計する](./encounter-cases-ja.md)。
裁定だけでは解除せず、各sourceのexactな解決通知が永続化されるまで市場受理と削除を止める。
`startHead`を利用者の自由なnonceとして公開すると、ticketを無制限に取得できる。
現時点では固定genesisから始める単独encounterだけを扱い、既存parent状態の継承や複数プレイヤーの秘密入力は扱わない。
authority署名鍵の永続保管・rotationはhostの責務として注入しており、この内部module自身は鍵保管サービスを実装しない。
生ログ削除後も開始権の使用済み記録・資産の確定行は残る。新APIは開始権をDOごとに1,024件で止めるが、authority全体の長期圧縮は未実装である。
未成立・中断ticketには[専用の終了証明書と削除許可](./encounter-termination-ja.md)を発行する。
replay確定したticketの取り消しには使わず、保持期限と保留なしを条件に、部分ログと未使用予約を解放する。

公開情報による経路探索やbot操作は、引き続き禁止できない。
ここで防ぐのは、このticketの未公開乱数を見た後の履歴差し替え・再抽選・二重mintである。
