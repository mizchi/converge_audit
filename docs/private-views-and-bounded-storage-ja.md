# 公開情報からの予測と、IndexedDBキューの保存量

更新日: 2026-10-17。

## 保証対象を分ける

公開情報から行う推論・探索そのものを、通常のブラウザー内で禁止する保証はできない。
例えば未来の攻撃が公開tickと公開状態だけで決まるなら、その規則をクライアントが別に実行できる。
正規playと、別の計算で最適化してから同じ入力を提出したplayは、同一のログだけから識別できない。

保証の対象は、未公開情報を渡さないこと、結果公開前に選択を一つに固定すること、
受理できる試行を一回に限定することである。
[時系列固定](./gameplay-chronology-ja.md)と[資産受理](./market-admission-cost-ja.md)へ接続する。
これはbotや公開情報からの統計的な推測を禁止したという主張ではない。
例えば未知の結果が公平な2択でも、当てずっぽうで50%は当たる。
暗号で扱うべき目標は、公開情報から得られる事前知識を超える情報を与えないことであり、
予測の成功率を0にすることではない。実gameの確率的な優位性の上限は今回のLean証明に含めない。

| 情報 | クライアントへ渡す範囲 |
| --- | --- |
| 自分の現在状態と確定済み経済状態 | 現在のplayと所有権確認に必要な範囲 |
| 相手の非可視位置・非公開の選択 | 公開条件を満たすまで送らない |
| 次の敵行動を決める秘密seed | 行動commit後の段階公開まで送らない |
| 未公開stateを含む完全replay | 信頼する監査者へ渡すか、公開してよい時点まで遅延する |
| 公開checkpoint | 非公開値を辞書探索できないcommitment設計が必要 |

[RiotのFog of War](https://www.riotgames.com/en/news/demolishing-wallhacks-valorants-fog-war)
は、見えるべきでない敵情報をクライアントへ送らない方向でwallhackを制限する。
クライアントへ渡した未来データをIndexedDBから後で消しても、すでにコピーした相手からは隠せない。
「全員が完全stateを複製し、その中の秘密を互いに知らない」という設計は成り立たない。
公開stateの収束と、秘密stateの保管者・公開条件を分離する。

単純なhashは秘匿機構にならない。例えば秘密が2択なら、両候補をhashして比較できる。
低entropyの秘密は、非公開の十分な乱数を持つhiding commitment等が必要になる。
queueの件数・payload長・配信時刻も秘密に依存すると漏洩し得るため、
必要に応じて固定cadence、padding、公開対象別の配信を設計する。
暗号文を先に配る場合も、復号鍵を早期に渡せば秘匿できない。

## キューを用途で分ける

| 用途 | 保持する内容 | 削除・上限時の扱い |
| --- | --- | --- |
| replay payload | 現在検証中の入力・必要状態を固定サイズchunkへ分割 | 明示的な削除権がある連続prefixだけ削除。満杯なら追加を拒否 |
| checkpoint outbox | 未ACKの小さなcommit/receipt配送 | ACK後に配送capacityを解放。履歴のretentionは別途判定 |
| control / evidence | head、cursor、失効状態、hold、retention anchor | payloadと別予算。未解決参照と再利用防止情報を残す |
| 将来の受信候補 | 許可された短い受信窓に入るpacketだけ | scope・件数・byte・sequence gapを制限。秘密の未来stateをprefetchしない |

無関係なpeerの全履歴を各playerが持つ設計にはしない。
自分が参加するscopeと監査担当の範囲へ限定し、同時に開けるscope数にも上限を設ける。
各scopeに上限があっても、scopeを無制限に作ればアプリ全体の保存量はboundedにならない。
新規データは認証・frame長・scopeを確認してから保存し、巨大な未認証payloadをqueueへ積まない。

## 追加した実装

[`IndexedDbAuditPayloadQueue`](../examples/cf-game-audit/web/src/audit/bounded-payload-queue.ts)
を、重いraw replay用の独立adapterとして追加した。
既存の`IndexedDbPlayerLocalStore`を自動置換したものではなく、
ブラウザーgameの全データや他のdatabaseを一括して制限する実装でもない。
各queueのlogical payload bytesと件数を制限する。

- `maxBytes`、`reservedBytes`、`maxItems`、`maxItemBytes`を必須指定し、設定を永続化する。
- `sequence`、64文字のcheckpoint digest、非空の`Uint8Array`を保存する。
- appendはpayloadとbyte/item counterを同じread-write transactionで更新する。
- 同じsequence・同じ内容は重複として返し、別内容、gap、削除済みsequenceは受理しない。
- 満杯時は`backpressure`を返す。古い未検証payloadを押し出さない。
- 再起動時はcursorで1度走査し、連続性とcounterを照合する。
- 通常appendは一定数のDB point operationと、追加chunk分のcopyで済み、全履歴を読み直さない。
- 同時に待機できるappendはconnectionあたり4件とし、DB待ちのpayload copyも無制限に積まない。
- 読み出し・pruneは1回最大64件。通常の読み出し件数はさらに小さく指定できる。
- quotaやdevice書込失敗ではtransactionをabortし、payload・counter・watermarkを一括rollbackする。

公開contractとpure policy wrapperは
[`payload-budget.ts`](../examples/player-local-runtime/payload-budget.ts)、
受付・削除guardとWhy3 contractは[`src/audit/payload_budget.mbt`](../src/audit/payload_budget.mbt)に分離した。

### 削除権の条件

このadapterの保守的な削除経路は、次のすべてを要求する。

1. 対象prefixの配送ACKがある。
2. gameplayの結果が確定している。
3. 必要なretention・appealが閉じている。
4. 未解決の参照がない。
5. queue ID、revision、終端sequence・checkpointを束縛するgrantをhostのverifierが認証する。

grantは対象prefix全体についての不可逆な削除許可であり、一時的に「今は異議なし」という通知ではない。
verifierは信頼する発行元・policy・closureを確認する必要があり、署名の存在だけで各条件を真にはできない。
local clockやrequestのbooleanを直接信頼してはならない。
新しいholdが後から有効に到着し得る間は、closureが成立したと扱わない。
grantの検証中にqueueが更新されれば、transaction内のrevision比較で削除を拒否する。
queue IDはその監査scope/世代を識別し、DB再作成時に別世代のgrantを流用しないhost contractが必要になる。

[単独encounterの統合例](./encounter-lifecycle-ja.md)では、実暗号によるretention grantの発行・検証と
実replay後の市場受理まで接続した。[公開APIと開始前予約](./encounter-http-and-reservation-ja.md)も接続済み。archiveへの保管責任移転、
[既定画面](./encounter-ui-ja.md)も接続済みである。
[共有payload pool](./shared-payload-pool-ja.md)では、複数encounterの生ログ・chunk数・空queueも含む登録数を制限し、
encounter recorderの保存先を切り替えた。新画面のcontrol JSONは80 KiB・最大16戦分に制限する。
旧snapshotの移行や、旧デモを含む全originの統合予算は未接続である。
認証callbackは必須であり、デフォルトで削除を許可する経路は用意していない。
このqueueは正規clientのcrash recoveryと容量制御を担い、悪意あるDB所有者からデータを保護する信頼根ではない。
市場は既存の認証・replay・所有権のgateを引き続き必要とする。

## 容量の算術例

初期運用案として、1つのreplay queueへ次の値を設定できる。既定値として自動適用はしていない。

```json
{
  "maxBytes": 16777216,
  "reservedBytes": 2097152,
  "maxItems": 2048,
  "maxItemBytes": 65536
}
```

payload上限は14 MiB、単体64 KiB。8件readならpayloadは最大512 KiB、
64件pruneなら最大4 MiBを1度に扱う。
件数制限は小さなchunkによるmetadata肥大化も抑える。
`reservedBytes`はpayload予算内のheadroomであり、別databaseのcontrol領域や物理disk空きを確保する予約APIではない。
browserのindex・structured clone・database overheadは`usedBytes`へ含めない。

保持が必要な時間を`W`、生成量を`r bytes/s`とすると、外部への保管責任移転がなければ
最低でもおよそ`rW`のpayload容量が必要になる。件数制限から来る上限も別にある。
例として8人、各10入力/秒、署名込み160 bytes/入力なら12,800 bytes/秒であり、
14 MiBはheader等を除いて約19.1分分にすぎない。1秒chunkなら、この時点では2,048件の件数上限よりbyte上限が先に来る。
1時間の証拠保持が必要なら、この設定で無期限に生成を続けることはできない。

小さな固定容量、無期限の未解決証拠保持、停止しない新規追加、の3つは同時に満たせない。
容量上限まで保護対象が溜まれば、監査対象の新規進行を保留するか、
archiveが必要な期間・holdを含めて保管責任を引き受けたことを認証する別の経路が必要になる。
後者は配送ACKと同じものではなく、今回の保守的な削除guardへ混同しない。

## IndexedDBの持続性

[Storage Standard](https://storage.spec.whatwg.org/)の`estimate()`は使用量・quotaの推定を提供し、
`persist()`は永続storageの扱いを要求する。
アプリ側のbyte予算とbrowserのquotaは別物であり、
永続化を許可されても、ユーザーの明示削除からデータを守ることはできない。
indexedDBだけへ唯一の監査証拠を置き、保存され続けることを保証する設計にはしない。
証拠を失った場合は資産受理を保留し、「ログがないので問題なし」と判断しない。

## 検証と形式化

```sh
just test-player-local-payload
just check-cf-game-audit
just prove
just prove-lean
```

Node/fake-indexeddbでは12テストでcapacity、reserve、再送・conflict、ACKだけの削除拒否、
未確定・hold・retention、古いgrant、再起動、同時書込、quotaとprune失敗のrollbackを確認した。
append burstに対する待機数の上限も確認する。
Playwrightでは実Chromiumの2タブ・再読み込み・capacity維持を確認する。
queue単体テストのretention証明書はmockである。
別のencounter統合テストでは、authority発行の実署名をNodeと実Chromiumで検証し、偽造許可による削除を拒否する。

Leanの[`Visibility.lean`](../formal/lean/ConvergeAudit/Visibility.lean)は6定理で、
公開情報だけで決まる値の予測可能性、同じ観測に異なる秘密が対応する場合の完全予測の不可能性、
2候補のcommitmentを列挙する例を扱う。
これは全worldに対する完全予測の議論であり、推測の成功確率・計算量・実暗号の秘匿性は証明しない。
`HidesSecret`は理想的な同一観測のcontractであり、実network・timing・sizeの非干渉性を証明したわけではない。

[`Retention.lean`](../formal/lean/ConvergeAudit/Retention.lean)は15定理で、
受付後のbyte/count上限、満杯時の拒否、ACKだけでは削除不可、hold保存、
連続prefixの削除と内容の再構成、保護された証拠の保持、watermarkの単調性を確認する。
IndexedDB engineの完全なrefinement proofや、grantの意味的正当性を証明したものではない。
