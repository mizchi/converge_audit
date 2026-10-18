# 開始前のログ容量予約と認証済みHTTP経路

更新日: 2026-10-18。[単独encounter](./encounter-lifecycle-ja.md)へ、開始前予約とWorker APIを接続した。
既定のUIも[接続済み](./encounter-ui-ja.md)。本番公開は行っていない。

## 開始時に確保するもの

`EncounterRecorder.start`は、共有IndexedDB内に**8 KiB・2 chunk・1 queue**を予約してから、開始要求を送る。
この参照ゲームの全60 tickを2 chunkへ記録できる最大容量である。
queue IDは`H(unit, startHead)`から決まり、サーバーが返すticket IDを知らなくても先に予約できる。
開始権はサーバーが信頼する登録済み資源であり、利用者が自由に増やすnonceではない。

全体の不変条件は次の二つ。headroomは予約の対象に含めない。

```text
usedBytes + reservedPayloadBytes <= maxBytes - headroom
itemCount + reservedItemCount    <= maxItems
```

記録時は予約を実使用へ振り替える。通常queueのappendも全予約を差し引いた残余だけを使うため、
他のencounterや別タブが予約済み容量を消費できない。
最後のchunkを書いた時点で余ったbyte予約を返す。pruneや再openでは使用回数を返さない。
同じIDと設定による`reserve`の再送は同じ残余を開き直し、二重計上しない。

既定の896 KiBのpayload予算なら、8 KiBの未使用予約は最大112 encounter分。
chunk数256件・queue数128件の上限も独立に適用する。
予約失敗時は開始APIを呼ばない。発行後の通信失敗では予約を保持して、同じ開始権で再送する。
一度も書かなかった予約は`releaseEmpty()`で解放できるが、サーバー側の使用済み開始権は戻らない。

予約・追加・削除・解放は、scopeと全体counterを同じreadwrite transactionで更新する。
予約は論理容量の保証であり、物理diskを確保する操作ではない。browser quota等による書き込み失敗は引き続きあり得る。
旧共有poolの予約counterが両方とも未定義の場合だけ0へ移行し、片方だけ欠けた状態や不整合は拒否する。

## 公開APIと信頼境界

| URL | 認証と責務 |
| --- | --- |
| `POST /v1/pve/:unit/encounter-admissions` | 管理者Bearer token。開始権と所有者を不変の行として登録 |
| `POST /v1/pve/:unit/encounter` | 所有者のEd25519署名。登録済み開始権・ticketに対する操作のみ |

登録bodyは`{unit, startHead, playerId, ownerPublicKey}`。
公開bodyは`{version, unit, ownerPublicKey, issuedAt, expiresAt, command, signature}`。
`command.op`は`start / commit / reveal / settle / receipt / market / prune / terminate / closure`。
中断と失効後の保持・解放は[終了処理](./encounter-termination-ja.md)にまとめた。
正規化した配列にdomain、unit、所有者、期限、操作、全引数を含め、SHA-256のdigestへ署名する。
未知のfield、非正規base64url、2件を超えるchunk、4 KiBを超えるchunkを受け付けない。
chunked bodyも読みながら16 KiBで打ち切る。応答の読み出しも16 KiB以下に制限する。

署名の有効期間は最大60秒で、現在はclient時計がサーバー時計より進んだ要求を許容しない。
nonce履歴は保存しない。同じ署名付き要求は期限内に再送でき、台帳の状態遷移を冪等に扱う。
「計算が物理的に一回しか走らない」という保証には使わない。
ticketは開始権、所有者、queue ID、乱数commitment、公開時計をauthority署名で束縛し、
recorderは信頼済みauthority鍵で検証してから記録する。

Worker入口がsource bucketを上書きし、既存の1 source・60秒・30要求の制限を共有する。
制限は署名検証より前に適用する。管理者tokenはWorkerとDO側の両方で確認する。
開始権はDOごとに最大1,024行で、同じ権利の再登録は同一内容だけを受理する。
使用済み行も残すので、この上限へ達したら新規登録を停止する。中央metadataの長期圧縮は別途必要である。

authority鍵はhostが`ENCOUNTER_SIGNING_SEED_HEX`をsecretとして、
対応する`ENCOUNTER_SIGNING_PUBLIC_KEY`を設定する。起動時に非extractableなWebCrypto鍵へ取り込み、
鍵対応を検査する。未設定・不正設定では503とし、要求ごとの鍵生成で置き換えない。
鍵rotationと外部署名サービスへの移行は未実装。
決定的なseedがあるのはVitest専用fixtureだけで、wranglerの配布設定には含めない。

**既存Worker全体のproduction暗号gateは維持している。** この新経路は標準WebCryptoを使うが、
Workerの既存経路がexperimental backendである間、production profileでは入口から503となる。
この実装をもって本番配備可能とは扱わない。

```ts
const transport = new HttpEncounterTransport({
  endpoint: `https://game.example/v1/pve/${authorization.unit}/encounter`,
  unit: authorization.unit, owner, cryptoBackend,
});
const recorder = await EncounterRecorder.start({
  factory: indexedDB, payloadPool, authorization,
  trustedAuthorityKey, owner, cryptoBackend, transport,
});
```

HTTP transportはHTTPSの固定endpointを要求し、redirectを拒否する。同一originでの利用を想定する。
`EncounterRecorder.open`は既存ticketを復旧する経路として残し、新規開始には`start`を使う。
署名・queue ID方式を変える前のprototype ticketは再署名して受理し直さず、検証で拒否する。
旧ticketの移行や旧画面のsnapshot保存先は別途扱う。

## 計算と検証範囲

通常の予約・appendはcounterの参照と更新で、過去ログをreplayしない。
初回確定は引き続き全60 tickをreplayし、市場受理はレシートID・確定台帳・所有者署名で済む。
API署名とticket署名の費用は、以前の[内部service実測](./encounter-lifecycle-ja.md)に含まれない。
RPCは現在も開始・commit・reveal・settleの4操作に分かれる。市場受理と削除許可は別要求であり、
通信回数の統合や本番gameの確定頻度の調整は今回行っていない。

[`Reservation.lean`](../formal/lean/ConvergeAudit/Reservation.lean)の21定理と18例で、
予約後の上限、記録への振り替え、余剰返却、残余0の拒否、再open時の残余保持、
他scopeの予約の保存、削除を挟む任意長の履歴での使用件数上限を検査する。
MoonBitはbulk予約guardと6補題を持ち、TypeScriptがJS bridgeを実際の判定に使う。
これらは数学的容量規則の証明であり、IndexedDB・HTTP・署名・ゲーム全体へのrefinement proofではない。

Nodeで容量競合、巻き戻し、通信失敗の再送、HTTP改竄と実replayを確認する。
workerdではWorker/DO入口、実SQLite、署名、eviction後の同じticket、rate limitを確認する。
Chromiumでは2タブの予約競合とreloadを確認し、別テストでFetchの署名付きwireから市場受理・削除まで通す。
後者はnetwork境界をinterceptしてNodeの実API/SQLiteへ渡すテストであり、本番network性能の測定ではない。

```sh
just test-payload-pool
just test-encounter-lifecycle
just prove-lean
just prove
just formal-check
```

未成立ticketの認証済み終了と予約の解放は[接続済み](./encounter-termination-ja.md)。
既定画面の復旧・終了も[接続済み](./encounter-ui-ja.md)。
確定資産の[case集計](./encounter-cases-ja.md)と確定済みreplay資料の[archive移管](./encounter-archive-ja.md)も接続済み。
旧保存形式の移行、資産失効・appeal、レシート圧縮とarchive自動GCが残る。
全originのsnapshot・inventory・receiptまで含めた容量制御と、楽観的監査のwatcherも引き続き別工程である。
