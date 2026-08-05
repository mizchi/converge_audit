# Cloudflare参照ゲーム: Audit Survivors

Vampire Survivors風の移動と自動攻撃、FF14風の予兆回避、Diablo風のdeterministic item drop、
監査済みitemだけを出品できるハクスラを、`examples/cf-game-audit/web`として実装する。
これは`src/audit`の汎用contractを利用するゲーム固有の参照実装であり、汎用ライブラリへ戦闘規則を
逆流させない。

## 面白さを保つ制約

- 入力はクライアントへ即時反映する。server ACKを待って移動させない。
- simulationは30 tick/sの整数状態、描画は`requestAnimationFrame`で補間する。
- 攻撃は`telegraph_start_tick`と`resolve_tick`を先に公開する。解決時の位置でhit/dodgeを決める。
- 移動速度、world境界、tick連続性だけを監査可能な上限にする。任意軌道をserverが毎frame承認しない。
- dropはencounter seed、enemy identity、kill tick、drop indexから一意に導く。同じ履歴は同じitemへ
  収束する。
- drop直後のitemは`provisional`として装備・利用できる。出品だけをcheckpoint検証まで保留する。
- timeout、partition、under-quorumはcheat確定にせず、出品待ち・再送として見せる。
- rollback対象は最後の受理済みcheckpoint以後に限定し、UIでprovisional範囲を明示する。

## 最小vertical slice

1. WASD/矢印でarenaを移動する。
2. 敵はplayerへ接近し、playerは射程内の最寄り敵を自動攻撃する。
3. 円形AoEが45 tick前から表示され、resolve時に範囲外ならdodgeになる。
4. enemy killからseed固定のitemを生成する。
5. item上を通るとinventoryへ入り、監査前は出品不可になる。
6. verification receiptを適用すると同じitemが`verified`になり、出品可能になる。
7. origin receiptをWorkerへ送り、冪等なlistingが保存されると`出品済み`になる。

verification receiptはデバッグUIで偽装せず、browserからWorkerへsealed segmentを送り、authorityが
同じkernelをreplayした結果だけを適用する。現在は30 eventごとのmicro checkpoint、sealed leaf retention、
IndexedDBへのcheckpoint単位の永続化、authority item replay、receiptのSQLite永続化まで実装済みである。
run固有owner keyのgenesis束縛、二者署名transfer、current-owner署名済みreference market listing POST、
owner署名済みlisting cancelも接続済みである。実際のpeer witnessと売買UI、価格精算は次段階である。

## 状態と入力contract

simulation stateとrenderer/DOM/input deviceを分離する。

```text
InputFrame(tick, horizontal, vertical)
  -> advanceGame(previousState, input)
  -> Advanced(nextState, effects) | Refused(reason)
```

- `tick == previous.tick + 1`のみ受理する。
- axisは`-1 | 0 | 1`だけを受理する。
- 座標、速度、HP、damage、距離比較は整数で処理する。
- diagonal移動量を固定し、浮動小数のnormalizeをsimulationへ入れない。
- rendererはstateを変更しない。
- `effects`はそのtickで発生したtelegraph解決、damage、kill、drop、pickupだけを返す。

## 監査とcheckpoint

```text
30 Hz input/event stream (player-local)
  -> 1秒micro checkpoint
  -> 15秒、encounter終了、rare dropでmacro checkpoint
  -> peer/witness相互監査
  -> authority ACK
  -> verified item creation / inventory head
  -> marketplace listing
```

通常移動は中央serverへ30Hz送信しない。peer同期のpacketは複数inputをまとめ、checkpointは1秒単位を
初期値とする。rare dropや出品は最新macro checkpointを要求する。通信断中も遊べるが、その間のdropは
provisionalであり、監査不成立なら最後のACK地点までinventory lineageを戻す。

### 実装済みのplayer-local journal

- 1 tickを入力とcanonical effect集合からなる一つのleafにする。
- 30 leafを`mizchi/bft/audit/merkle`のMerkle rootへ畳み込み、最終game state digestと前checkpointを
  micro checkpoint envelopeへ束縛する。
- SHA-256とMerkle framingはTypeScriptへ複製せず、`src/x/game_audit/browser_bridge`からMoonBit実装を
  browser bundleへ直接linkする。
- drop effectに含まれるasset IDを、そのtickを含むmicro checkpointへ明示的に束縛する。
- sealed segmentのleafはroot生成後も保持し、challenge時のproof/replayに備える。
- game stateとjournalを一つのsnapshotとしてIndexedDBへ保存する。保存は完全なmicro境界だけで行い、
  reload時はevent root、checkpoint chain、最終state digestを再計算してから復帰する。
- browserはrunごとに32-byte seedからEd25519 owner keyを生成し、別のIndexedDB storeへ保存する。公開鍵は
  genesis digestへ含めるため、item精算直前に別鍵へ差し替えた自己整合ログは元のcheckpoint chainと一致しない。
- micro未満の未保存tickはreload時に失われる。初期cadenceでは最大29 tick、約0.97秒である。

IndexedDBは端末故障や改造clientに対する信頼根拠ではない。ここで保証するのはローカルcrash時の一貫した
復帰点であり、正当性は後続のpeer witnessまたはauthority replayで判定する。

### 実装済みのauthority item replay

browserはitem取得時に、そのassetを生成したsealed micro segmentだけを次へ送る。

```text
POST /v1/pve/:unit/game-item-verifications
  { seed, player_id, owner_public_key, asset_id, owner_signature,
    checkpoint, events[30] }
```

- client申告のeffectを信頼せず、canonical leafから入力だけを取り出す。epoch 0はtick 1から、後続epochは
  authority保存済みparent stateから共有kernelを再実行する。
- 再生成したeffect payload、tickごとのasset ID、Merkle root、最終state digest、genesis、checkpoint
  envelope/digestを完全一致で検査する。
- replayで実際に生成されたassetだけに、unit・checkpoint・asset・owner・epochへ束縛した
  `authority_receipt_id`を発行する。
- `owner_signature`はunit・player・seed・checkpoint・asset・genesis束縛済み公開鍵のcanonical digestへ署名する。
  Workerは高価なsegment replayより先にMoonBit Ed25519 bridgeでproof-of-possessionを検査する。
- receiptはDurable Object SQLiteへasset単位で保存する。同じrequestは`duplicate`として同じreceiptへ
  収束し、競合する再登録は409になる。receiptとauthority保存済みparent stateにも公開鍵を保存し、後続epochの
  鍵変更は拒否する。
- 公開入口はCloudflare由来の送信元をserver-secret HMAC bucketに変換し、raw IPを保存せず、unit・bucketごとに
  1分30件へ制限する。これにより最大約29秒分のbackfillとitem精算を一burstで行える。これはabuse低減であり、
  account identity、Sybil耐性、巨大NATの公平性は保証しない。
- browserはreceiptのasset、owner、owner public key、checkpointを送信requestと再照合し、全て一致した場合だけitemを
  `authority verified`へ変える。失敗時はprovisionalのまま再試行できる。

epoch 0より後のsegmentは開始stateをclientから信用しない。authorityが直前epochでreplay生成して保存した
stateとstate digestをparentとして使う。parentが未検証なら409で拒否する。browserは高価値itemを拾った時点で、
最後のauthority ACK以後の未検証segmentを`game-checkpoint-verifications`へepoch順でbackfillし、最後の
drop-bearing segmentを`game-item-verifications`へ送る。各requestは30 eventなので、通常時に30Hz streamを
中央へ送らず、精算時だけ未処理区間に比例したreplay costを払う。

同じplayer/seedで異なるtraceを同じDOへ混ぜないよう、browserはrun IDをURL、IndexedDB key、DO unitへ含める。
「新しいrun」は新しいrun IDを生成し、同じseedでも別encounterとして扱う。

### Reference item transfer

authority verification済みitemは、現在headのownerから次ownerへ次で移転する。

```text
POST /v1/pve/:unit/game-item-transfers
  { asset_id, authority_receipt_id, previous_head_id,
    from_owner_id, from_owner_public_key,
    to_owner_id, to_owner_public_key,
    previous_version, next_version,
    sender_signature, recipient_signature }
```

transfer文はunit、origin receipt、直前head、両owner identity/key、連続するversionをcanonical化する。
旧ownerのhandoff署名と新ownerのacceptance署名を同じdigestへ要求するため、鍵を持たない第三者による移転と、
新ownerが同意しないitemの押し付けを拒否する。`next_version == previous_version + 1`かつ保存済みheadとの完全一致
だけが、append-only transfer履歴の追加とper-asset head更新を同じSQLite transactionで行える。同じ二者署名の
再送は同じtransfer IDへ収束し、stale headやversion gapは409になる。

active listing中のtransferは、listingを古いownerのまま残さないため`asset_listed`で拒否する。正当なcancelを
保存した後だけtransfer gateが再び開く。

### Reference marketplace

verified itemのcurrent ownerは次を送る。

```text
POST /v1/pve/:unit/game-market-listings
  { asset_id, seller_id, authority_receipt_id,
    owner_public_key, owner_version, owner_head_id,
    listing_nonce, owner_signature }
```

DOは保存済みitem receiptとasset、authority receipt ID、最新のper-asset owner headを完全一致で照合する。
その後、unit・asset・seller・receipt・公開鍵・owner version・owner head ID・listing nonceに対する
`owner_signature`を検証し、
active listingと署名をSQLiteへ
冪等保存する。同じ出品の再送は決定的Ed25519署名と同じlisting IDで`duplicate`へ収束し、receipt偽造、
seller不一致、receiptだけを盗んだ第三者の署名、同一assetの競合listingはfail-closedになる。UIは成功後に
`common · market listed`と`出品を取り消す`へ遷移する。

current ownerはactive listingを次で取り消す。

```text
POST /v1/pve/:unit/game-market-listing-cancellations
  { listing_id, asset_id, seller_id, authority_receipt_id,
    owner_public_key, owner_version, owner_head_id,
    listing_nonce, cancel_signature }
```

cancel署名はunit、listing ID、asset、seller、origin receipt、出品時のowner key/version/headとnonceを
canonical化する。DOはactive listingと現在owner headの両方を完全一致で照合し、同じSQLite行を
`canceled`へ遷移させる。取消履歴は削除せず、同じnonceから導いたlisting IDは再出品に利用できない。
一方、新しい256-bit nonceなら同じowner headでも別listing IDとして再出品できる。その後の二者署名transferも
新しいowner version/headを作るため、新ownerは別listing IDで出品できる。
同じcancelの再送は、取消後にowner headが先へ進んでいても保存済み取消証跡へ`duplicate`として収束する。

この状態機械は`formal/quint/AssetOwnership.qnt`で3 owner・最大2 transferへ縮約し、versionがtransferごとに
正確に1進むこと、二者認証なしにownerが変わらないこと、active listing中にownerが変わらないことを
TLCで全到達状態検査する。暗号、HTTP decode、SQLite migrationは実装testの境界に残す。

このreference endpointはorigin receiptから始まる単調増加owner headのcurrent ownerを扱う。initial ownerの
version 0だけでなく、二者署名transfer後のownerも出品でき、旧ownerの署名は拒否される。売買成立、価格、
複数itemのatomic exchangeはまだ扱わない。将来は既存open-world `market-listing`の署名済みinventory headへ
接続する。reference checkpoint/item receiptはこのゲーム固有のauthority replay結果であり、汎用peer witness
quorumの代用ではない。owner keyは自己主権run identityを証明するが、`seller_id`を課金accountや現実の人物へ
結び付けるものではない。reference実装はexport可能seedをIndexedDBへ置き、未監査の`experimental_crypto`を使う。
productionでは認証済みaccountへの鍵登録、OS keystoreのnon-exportable key、鍵回復・rotation・失効を別途実装する。

## Cloudflare配置

- Viteでbuildした静的assetsはCloudflare Workers Static Assetsからedge配信する。
- `/v1/*`と`/health`だけWorker codeを先に実行し、既存Durable Objects/Queue APIへ渡す。
- simulation kernelはbrowser内、authority head・witness collection・market eligibilityはWorker/DO側に置く。
- static assetsとAPIを一deploymentに保ち、後でremote RTTとcheckpoint intervalを同じ環境で実測する。

Cloudflare設定は`assets.directory = ./dist`、SPA fallback、API routeだけのselective
`run_worker_first`を使う。asset requestでWorkerを毎回起動しない。

## UI検証

UIは[VLMKit](https://mizchi.github.io/vlmkit/)のplan/generate/runtime-gate workflowに合わせる。
`examples/cf-game-audit/specs`に実ブラウザで観測したrole/text、要求、生成規則を置き、未観測のlocator、
canvas座標、CSS/XPath、固定sleepを生成入力から排除する。authority通信はPlaywrightのnetwork routeで
一時停止し、provisional表示を検査してから解放するため、時間待ちに依存しない。

```sh
cd examples/cf-game-audit
pnpm ui:plan
pnpm ui:generate
pnpm test:e2e
```

`ui:plan`と`ui:generate`には対応LLM providerのcredentialが必要である。生成物は別specへ出し、既存の
hand-verified smoke testを自動上書きしない。このscenarioは状態遷移のbehavior testなのでVRT baselineは
要求せず、失敗時だけscreenshotとtraceを保存する。

## 非目標

- 初期sliceでMMO全体、課金、アカウント復旧、production key custodyを実装しない。
- client判定だけでitemをverifiedにしない。
- 物理演算や描画結果を監査対象にしない。監査対象は整数simulation stateとcanonical effectsである。
- `experimental_crypto`をproduction安全とみなさない。
