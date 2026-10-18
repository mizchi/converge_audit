# 上限付きencounterを既定のゲーム画面へ接続

更新日: 2026-10-18。
既定の`/`を、[開始前予約・署名付きAPI](./encounter-http-and-reservation-ja.md)と
[中断・ログ解放](./encounter-termination-ja.md)を使う画面へ切り替えた。
公開seedを入力して再生成する従来のデモは`/legacy.html`へ移した。
新画面は旧snapshot、journal、runごとの鍵やDBを作らず、旧保存形式の自動移行も行わない。

## 実行手順

```sh
just dev-cf-game
# http://127.0.0.1:8787/ を開く
```

初回起動でローカルauthority用のEd25519鍵を、Git対象外の
`examples/cf-game-audit/.dev.vars`へ権限0600で保存する。次回起動でも同じ鍵を使う。
片方の鍵設定だけが存在する場合は上書きせず停止する。不正な鍵の対応はWorker側で拒否する。
E2Eの既知のfixture鍵は`dev:e2e`専用であり、本番用の代替鍵ではない。

開始権は画面から自由生成できない。画面の「開始権の割り当て用情報」にある端末公開鍵を使い、
別のterminalからローカルの運営操作で割り当てる。

```sh
pnpm --dir examples/cf-game-audit dev:assign-start <端末公開鍵>
# 画面の「状態を再確認」を押し、開始権を選んで「戦闘を開始」
```

CLIの追加引数は`[unit] [startHead] [playerId]`。
`ENCOUNTER_LOCAL_ORIGIN`で指定できる送信先はloopback HTTPに限定する。
この開発コマンドはローカルのadmin tokenを使い、ブラウザへadmin tokenやauthority秘密鍵を渡さない。
部屋は`?unit=demo`が既定値。同じ保存領域では一つの進行中戦闘を扱い、別の部屋に残った戦闘は元の部屋で終了する。

`pnpm web:dev`単独ではWorker APIを提供しないため、この画面の開始・復旧は動かない。
bootstrapが失敗した場合は操作を止め、旧デモへ自動的に切り替えない。
本番の暗号gateは引き続き有効であり、この変更だけで本番配備可能にはならない。

## 画面と通信

| 段階 | ローカル処理 | authorityへ送る操作 |
| --- | --- | --- |
| 起動 | 同じ非抽出端末鍵と保存済みsessionを復元 | 公開configuration、所有者署名付きadmissionsと必要なstatus |
| 開始 | レシート枠を確保し、入力全体8 KiB・2 chunkを予約 | 割り当て済み開始権から同じticketを取得 |
| プレイ | 20 Hz・60 tickを実行。30入力ずつ永続化 | tickごとのRPCなし |
| 入力確定 | 全60 tickの保存完了後、rootを署名 | commit。発行から3秒後以降、4秒未満に受領する検証用設定 |
| 戦利品確定 | 公開された乱数とレシートを検証 | release後にreveal、settle。authorityが全60 tickをreplay |
| 市場受理 | 検証済みレシートから所有者署名を作成 | market。生ログを再送しない |
| ログ解放 | 保持期限後、認証済み許可でpayloadと予約・登録枠を解放 | prune、または終了済みticketのclosure |

市場の操作は受理判定であり、売買や所有権移転は別工程である。
ここでの3秒のプレイ、1秒のcommit猶予、10秒の保持期間は短い検証用設定。
ネットワーク遅延やタブ停止で期限を逃すことはあり、本番ゲームへそのまま推奨する値ではない。

戦闘中の描画は公開mechanicsだけを使う。seed 0によるローカルpreviewから、
seed、item ID、rarity、power、inventoryを除いて描画し、戦利品の内容は確定レシートの検証後にだけ表示する。
異なるseedで60 tickの公開状態が一致する回帰テストを置いた。
これは現在のkernelの性質であり、将来の非公開乱数が移動や戦闘へ影響するゲームへ無条件には拡張できない。
公開mechanicsの予測、bot、外部での探索そのものを禁止する保証でもない。

## 復旧と停止

session controllerはゲーム描画、通信、IndexedDB control保存から分離した。
再読み込みでは所有者・部屋に対応する署名付きticketとterminal証明書を検査し、authorityの状態を参照する。
既定画面はWeb Locksでorigin内の同時操作を一つに制限する。Web Locksが使えなければ開始しない。
これは正規画面の競合防止であり、悪意ある所有者による直接API操作への認証境界はサーバーにある。

| 復旧時の状態 | 結果 |
| --- | --- |
| start応答が不明 | 全量予約を先に確認し、同じ開始権を再送。空きがなければ発行を要求しない |
| 入力が一部だけ永続化 | `interrupted`。未保存入力を補わず、プレイを再開しない |
| 全2 chunkが保存済みでcommit窓内 | 同じログをcommitできる。新しい入力を追加しない |
| commit応答が不明 | statusで固定済みrootを確認し、公開を待つ |
| 未commitで公開時刻を経過 | 中断として扱う。後付けの入力確定を試みない |
| 確定済み | レシートだけを復旧できる。解放済みqueueを再作成しない |
| 終了済み | 終了証明書を保持し、期限後の解放へ進む。開始権を戻さない |

画面が非表示になった場合や描画間隔が500 msを超えた場合もプレイを止める。
停止中の入力を後から生成して追い付かせる処理は入れていない。
保存失敗時は確定へ進まず、「保存済み」の件数は成功した永続書込だけを数える。
サーバー側のholdや保持期限により削除を拒否された場合はデータを残す。

## 保存上限

| 領域 | 上限・扱い |
| --- | --- |
| 入力RAM buffer | 最大30入力 |
| 現在のencounter | 8 KiB・2 chunk、各4 KiB以下。開始前に全量予約 |
| 共有raw payload pool | 1 MiB中128 KiBをheadroomとし、896 KiB・256 chunk・128 queue以内 |
| control JSON | 一つのsession image、最大80 KiB。current最大8 KiB、履歴の各レコード最大4 KiB |
| 確定レシート | 未集約は履歴とcurrentを合わせて最大16戦。次の開始前に署名済みcheckpointへ集約 |
| 集約済みinventory | 2 KiB以下のcheckpoint 1件。元レシートは中央から3戦ずつ取得しRAM cacheを置き換える |
| 端末鍵 | 一つの非抽出CryptoKeyと公開鍵。session imageとは別の固定件数record |

control imageはJSON化した実データのbyte長を検査して保存する。
隠れたArrayBufferなどがstructured cloneで容量検査をすり抜けることを避け、revision付きtransactionで更新する。
保持中sessionがあるのに端末鍵を失った場合は、勝手に別の鍵へ置き換えない。
これらはアプリの論理予算であり、IndexedDBの物理的な記録overhead、CryptoKeyの実装内部容量、
同じoriginの旧デモDBや他領域を合計した容量保証ではない。browser quota確保の保証もない。

旧デモDBの移行、全originの統合予算は今後の作業となる。
16戦分に達したら[inventory checkpointへ集約](./encounter-inventory-checkpoint-ja.md)して継続する。
確定済みreplay資料は「ログをサーバーへ預ける」から[archiveへ移管できる](./encounter-archive-ja.md)。
これはローカルraw payload枠を空ける操作であり、その後にレシートも集約できる。
サーバーの[case集計](./encounter-cases-ja.md)は接続済みで、未解決のcaseがあれば削除要求を拒否する。
case一覧・保持理由の専用画面はまだない。

## Leanと検証

[`Recovery.lean`](../formal/lean/ConvergeAudit/Recovery.lean)の8定理と
[`Tests/Recovery.lean`](../formal/lean/Tests/Recovery.lean)の10例を追加した。
復旧から`playing`が生じないこと、全ログがない状態でcommit待機へ進まないこと、
期限後の未commitを中断にすること、確定・終了の復旧が生ログを要求しないことを検査する。
入力されたremote状態・ログ進捗の真正性は前提であり、TypeScript・IndexedDB・時計・暗号のrefinement proofではない。

```sh
just test-encounter-ui
just prove-lean
```

Nodeの実暗号・SQLite APIとfake IndexedDBで、全経路、部分保存、commit応答喪失、
空き不足時の発行抑止、保存失敗rollback、control予算とCAS、開発鍵の再利用を確認する。
Playwrightは実Worker/DOへ接続し、開始から市場受理・期限後削除・レシート復旧まで実行する。
別タブ拒否、部分ログからの再開拒否、中断・期限後解放も確認する。
既存デモは`/legacy.html`で回帰検査する。
