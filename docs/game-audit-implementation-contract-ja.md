# ゲーム監査 persistence / transport 実装契約

更新日: 2026-08-04

状態: 今後追加するruntime adapterに対する規範契約。現在の実装充足度は11節に示す。
「しなければならない」はMUST、「原則とする」はSHOULDとして扱う。

## 1. 位置付け

この文書は、player-local DB、同じ監査単位のpeer、権威サーバーを接続する
checkpoint runtimeの実装契約を定める。ゲームの戦闘規則ではなく、eventの永続化、
epoch close、checkpoint seal、outbox、ACK、head、gap recovery、crash recoveryを対象にする。

規範の担当は次のように分ける。

| 対象 | source of truth |
| --- | --- |
| 既存の公開型と純粋なhead/policy判定 | `src/audit/**/*.mbti`, `.mbtp`, runtime test |
| persistence/transportが今後満たすべき契約 | 本文書 |
| crash/drop/partitionを含む状態遷移 | `formal/quint/CheckpointDelivery.qnt`, `formal/quint/WitnessQuorum.qnt` |
| wire encoding、署名domain、decode budget | `docs/game-audit-wire-ja.md`とgame adapter |
| event完全性、合法手、報酬、asset生成 | 個別gameのmanifestとdeterministic kernel |

Quint/TLCは本文書の一部を有限状態で検査するが、本文書全体の証明ではない。逆に、現在の
prototype実装が本文書を満たしていない箇所は、既成事実として仕様を弱めず`Pending`として扱う。

## 2. 責務分離

```text
converge/audit
  pure policy + commitment projection + head classification
  + persistence/transportの抽象contract
                 │
game adapter     │ epoch closure / expected frontier / replay rule
                 ▼
concrete runtime   local DB + peer transport + authority DB/Queue
```

### 2.1 converge汎用層

汎用層は次を所有する。

- checkpoint commitmentの必須field
- watermark、head、outbox、ACKの状態遷移と結果型
- exact-parent、historical duplicate、fork、gap、staleの分類
- transaction境界とidempotency規則
- retry schedulerが満たす順序・公平性契約

汎用層は、どのeventがゲーム上必要か、誰が勝ったか、lootを生成してよいかを決めない。

### 2.2 game adapter

game adapterは次を所有する。

- scopeとepochごとの固定rosterまたはeligible participant集合
- 各authorの連続counter frontierと、入力なしを表す認証済みclose/idle evidence
- `TrustedEpochClosure`を発行できるmode固有quorum
- checkpointへのgame manifest、state root、effect rootの射影
- timeout、challenge、under-quorumをcentral replayへ送るpolicy

### 2.3 concrete runtime

DB、Queue、WebSocket、P2P transportなどのadapterは、汎用状態遷移をatomicかつdurableに
実現する。transport成功をgameplay検証成功として扱ってはならない。
pureな分類・検証とDB mutationを分離し、transaction adapterは分類結果に従うだけにする。

## 3. 識別子と境界

すべてのevent、closure、checkpoint、ACK、outbox keyは最低でも次の境界へ拘束する。

- protocol versionとmessage purpose
- game/rule manifest digest
- scope/session ID
- coordination unit ID（party、match、zone、encounter）
- epoch
- sender/authority identity

別scope、別manifest、別purposeのdigestや署名を再利用してはならない。epochとcounterは
非負のbounded integerとしてdecode時に検査し、内部の加算前にもoverflowを拒否する。

## 4. 論理データ契約

以下は概念型であり、公開MoonBit API名は実装時に`.mbti`差分として確定する。

### 4.1 `AuthenticatedEvent`

最低field:

- boundary情報、author ID、author counter、audit time
- canonical payloadまたはpayload digest
- causal dependency commitment
- signature suite、key ID、signature

不変条件:

- `(scope, author, counter)`は一つのdigestにだけ対応する。
- 同じkeyと同digestは`Duplicate`、異digestは`Equivocation`であり、到着順で上書きしない。
- author counterにgapがあるeventは保存してよいが、適用・closure完了には使わない。
- client wall clockをそのままaudit timeとして信用しない。

### 4.2 `TrustedEpochClosure`

最低field:

- boundary情報とepoch
- roster/eligible-set digest
- authorごとの最終連続counter frontier
- close/idle evidenceまたはauthority receiptのcommitment
- closureを承認したidentity集合とcertificate digest

`TrustedEpochClosure`は、期待event集合がローカルDBに揃ったことを検査した後だけ構築できる
capabilityとする。単なる時刻経過、client申告、未認証watermarkから構築してはならない。

open rosterでは「世界中の全player」を期待集合にしない。match roster、party roster、
interest group、事前seal済みeligible setなど、有限でcommit済みの集合へscopeを切る。

### 4.3 `SealedCheckpoint`

共通commitmentとして次を拘束する。

- scope、epoch、previous checkpoint digest
- manifest digest
- event root、public state root、effect root
- hidden stateを使う場合のsealed-state commitment
- `TrustedEpochClosure` digest
- producer identityとsignature

checkpoint digestはcanonical bytesから一度だけ計算する。retryのたびに再生成してはならない。

### 4.4 `CheckpointAck`

ACKは少なくともscope、epoch、checkpoint digest、authority identity、decisionを認証する。
成功ACKは`Accepted`または`Duplicate`だけである。`Gap`、`Fork`、`StaleUnknown`、
`BoundaryMismatch`、timeoutを成功ACKとして扱ってはならない。

ACK channelが署名を使わない場合も、mTLSやsession-bound authenticated channelにより同等の
identity/boundary保証を持たせる。senderはACKを永続化してからoutbox entryを完了扱いにする。

### 4.5 `OutboxEntry`

最低field:

- `(scope, destination, epoch, checkpoint_digest)`から導くidempotency key
- 送信するcanonical envelope bytes
- `pending | in_flight | acknowledged`状態
- attempts、next retry time、last transport error
- created/acknowledged time

`queued`やsocket write成功は`acknowledged`ではない。outbox容量不足時はcheckpoint sealを
成功させず、gameplay結果をprovisionalに留める。

容量として数えるのは`pending + in_flight`の未ACK entryである。`acknowledged` tombstoneと
対応するACK evidenceは重複排除・retry・appeal期間の証跡として保持するが、配送容量を消費しない。
総履歴件数の上限・pruneは、この配送backpressureとは別のretention policyで定める。

状態遷移は次に限定する。

```text
pending ──claim/lease──> in_flight ──valid success ACK──> acknowledged
   ▲                           │
   └── timeout/drop/restart ───┘
```

`in_flight`は期限付きleaseとし、process crash後に期限切れentryを`pending`へ戻せなければならない。

### 4.6 操作結果型

公開contractは単一の`Bool`で成功・不足・不正・障害を潰さない。少なくとも次を型で区別する。

```text
EventAdmission  = Stored | Duplicate | Equivocation | Refused
ClosureDecision = Ready(TrustedEpochClosure) | PendingEvidence | Conflict | Refused
SealDecision    = Sealed | AlreadySealed | PendingEvidence | Backpressured | Refused
AuthorityResult = Advance | Duplicate | SameEpochFork | ParentFork
                | Gap | StaleUnknown | BoundaryMismatch | Refused
DeliveryResult  = Acknowledged | PendingTransport | Rejected
```

`PendingEvidence`と`PendingTransport`はcheat判定ではない。`Refused`はdecode、boundary、容量、
内部整合性などのreason codeを持ち、retry可能性を呼出側が判定できる形にする。

## 5. 永続状態

実DBのtable名は自由だが、次の論理relationを復元できなければならない。

| relation | primary/unique key | 必須性質 |
| --- | --- | --- |
| authenticated events | scope + author + counter | digest不変、equivocation別保存 |
| epoch closures | scope + epoch | roster/frontier/certificateを固定 |
| checkpoint history | scope + epoch | digest、parent、canonical bytesを保持 |
| local head | scope singleton | historyのlatest exact chainを指す |
| checkpoint outbox | scope + destination + epoch + digest | sealと同じtransactionで作成 |
| authority ACK history | authority + scope + epoch + digest | historical duplicateを復元可能 |
| fork/challenge evidence | boundary + conflict key | 吸収的で上書き不能 |

同じscopeの`checkpoint history + local head + outbox`は同じtransaction domainに置く。
別DBへ分ける場合は、同等のrecoverable transaction protocolとcrash testを必須とする。

## 6. 操作契約

### IMPL-EVENT-001: event admission

事前条件:

- size/decode budget内のcanonical message
- boundary、key、digest、signatureが検証済み

事後条件:

- 新規eventはdurableに一度だけ保存する。
- 同一digestの再送は状態を変えず`Duplicate`を返す。
- 同一author/counterの異digestは既存値を変えずequivocation evidenceを追加する。
- DB失敗時はgame state、frontier、watermarkを進めない。

### IMPL-CLOSE-001: trusted closure admission

事前条件:

- roster/eligible setがmanifestへ拘束されている。
- frontierまでの全counterが連続し、該当eventが認証済みDBに存在する。
- equivocation、未解決gap、必要quorum不足がない。

事後条件:

- 条件を満たす場合だけopaqueな`TrustedEpochClosure`を返す。
- 不足は`PendingEvidence`、矛盾は`Conflict`として分離する。
- timeoutだけでcheat確定または完全closureにしない。

### IMPL-SEAL-001: seal and enqueue

一つのtransactionで次を行う。

1. `TrustedEpochClosure`のboundary/epochと未消費性を確認する。
2. local headに対して`epoch = current + 1`とparent一致を確認する。
3. canonical event集合からcheckpointを生成してhistoryへinsertする。
4. local headを進める。
5. 必要な各destinationのdurable outbox entryをinsertする。
6. closure/watermarkを消費済みにする。

どれか一つでも失敗した場合は全変更をrollbackする。特に「headだけ進んだ」「checkpointはあるが
outboxがない」「watermarkだけ進んだ」という状態を作ってはならない。

汎用層の`prepare_atomic_checkpoint_seal`は、transaction内で読んだstorage snapshotから上記4種類の
変更を含むopaque write-set planを生成する。既知digestの再実行は、history/head/必要outbox/closure消費が
すべて存在すると確認できる場合だけ`AlreadyCommitted`である。一部だけ存在する既知checkpointは
`SealIncompleteKnownCommit`としてfail-closedにする。plan生成自体はcommitではなく、adapterは
expected snapshotのCASと全write-setを一transactionで行わなければならない。

### IMPL-PROVISION-001: authority boundary provisioning

- authorityのboundary、destination identity、initial epoch/digestは、最初のcheckpoint受信より前に
  認証済みcontrol planeからdurableに設定する。
- 未設定receiverはcheckpointから設定を作らず、fail-closedにする。
- 設定後のboundary/initial headは上書きしない。同一設定の再実行だけをduplicateとして許す。
- sourceは必要destinationすべてのprovision完了をdurableに確認するまでsealしない。

### IMPL-AUTH-001: checkpoint delivery authentication

- transport上で自己整合するidempotency keyは認証ではない。
- receiverを更新する前に、jobがsourceのdurable outbox entryとboundary、destination、epoch、digest、
  canonical bytes、created orderまで一致することを認証する。
- 同一trust domainでは認証済みinternal RPCを使ってよい。敵対的peer transportではproducer signature、
  roster/quorum capabilityを検証し、同じ認証済みdelivery境界へ変換する。
- canonical statement/approvalはMoonBit contractだけがserializeし、Workerはそのexact bytesを標準WebCryptoと
  既存MoonBit verifierで二重検証する。両者が同じproducer/quorum capabilityへ到達した場合だけmutationを許す。
- 新規producer/witness writerは外側protocol v2だけを生成し、producerと各approvalへkey ID/version、
  purpose、scope、unit、subject、digest、署名時刻を含むkey-bound authenticationを付ける。writerは
  signerとverification key record、および期待scope/unitの不一致を署名前に拒否する。
- control planeは公開鍵履歴、exclusive `legacy_accept_until_ms`、`max_clock_skew_ms`をsourceと各receiverへ
  同じpolicyとして永続化する。v1は`now_ms < cutoff`でのみ受理し、v2は履歴中のexact key versionを要求する。
  legacy roster公開鍵はv1 drain専用であり、rotation後のv2はroster identityと履歴recordへ照合する。
- unknown、改ざん、未認証jobはreceiver history/head/fork evidenceを一切変更しない。

### IMPL-COLLECT-001: remote witness collection

- collection開始時にexact delivery statement、producer署名、provision済みpolicy、deadlineをdurableに固定する。
  producer-only bundleは標準WebCryptoとMoonBitのpartial dual verifierが発行したexact-bound capabilityを要求する。
- witness approval endpointは管理tokenではなく署名を認証情報とし、unknown collection、非roster、
  statement/key/digest/signature不一致をcollection/approval/conflict状態へ入れない。`under_quorum`は
  不正ではなく収集中を表すため、両verifierが一致したpartial capabilityなら受理する。
- source rate-windowはDoS防御状態なので暗号拒否されたattemptも計数する。これはapproval/equivocation
  evidenceの受理とは区別する。
- exact duplicateは承認数を増やさない。同じwitnessの異なる応答は、競合応答自体の署名検証に成功した
  場合だけequivocation evidenceとして保存する。
- distinct roster approvalが必要数へ達した時だけ`ready`へ一方向遷移する。`ready`後のbundleは凍結する。
- deadlineまでにquorumへ達しなければ`expired/pending`とし、cheat確定にしない。
- sealは`ready` collectionと自身のboundary、destination、epoch、parent、digest、canonical bytesが
  完全一致した場合だけauthentication bundleを取り出す。
- 活性保証には、未採用の正直な応答がhostile duplicate/invalid floodに永久に飢餓化されない公平な
  queueingまたはrate limitを仮定する。
- 公開入口はtransportが認証した送信元をserver secret付きHMACのpseudonymous bucketへ写像し、
  raw sourceを保存せず、clientが指定した内部bucketを信用しない。secret欠落時はfail-closedにする。
  少なくともcollection・bucket単位の有限rate limitにより、あるbucketのfloodが別bucketの
  quotaを消費しないことを回帰検査する。NAT、IP churn、botnetを独立故障とみなせるとは仮定しない。
- witness秘密鍵はpeer processからauthorityへ送らない。peerは公開collectionのroster、deadline、
  statement digestを検査し、ローカル署名した1 approvalだけを提出する。

### IMPL-SEND-001: ordered retry

- 通常の初回送信は複数epochをpipelineしてよい。
- retry schedulerは各`(scope, destination)`について最古epochの未ACK entryを優先する。
- 同epochではcreated time、digestのような公開されたdeterministic tie-breakを使う。
- retryは同じcanonical bytesとidempotency keyを再利用する。
- backoff/jitterは許すが、entryを永久に飢餓させてはならない。
- transport timeout、drop、partitionは不正判定にせず`pending`へ戻す。

### IMPL-PEER-SEND-001: player-local bounded peer fanout

- peer endpointはaudit boundaryと同じlocal DBへ事前provisionし、同一identityのendpoint差替えを
  通常data pathから許可しない。
- fanout選択、backoff、成功reset、複数response分類は汎用MoonBit policyをsource of truthとする。
- route claimはSQLite leaseと単調なattempt orderを一transactionで保存し、process memoryだけの
  in-flight countに依存しない。crash後はlease期限までbackpressureし、その後retry可能にする。
- senderの最大試行時間はlease以下でなければならない。これを満たさない構成は送信前に拒否する。
- response bodyへbyte上限を設け、peer identityとapplication固有signature/certificateを検証した後だけ
  successまたはfork判定へ入れる。未認証の異digestはfork evidenceにしない。
- 認証済み異digestはcanonical responseと共にdurableに保存し、同じtransactionで当該routeを
  quarantineする。正常responseが先に届いてもforkを隠さない。
- timeout、oversize、未認証、到達不能、lease中はcheat確定にしない。
- `now_ms`はaudit unitの永続化されたclock originからの32-bit相対時刻とする。Unix epoch millisecondsを
  MoonBit `Int`へ直接渡さず、長寿命unitはclock範囲内でrotationする。

### IMPL-RECV-001: authority checkpoint admission

authorityはdecode budget、signature、boundaryを検査してから、同じtransaction内でhistoryと
headを分類・更新する。

| decision | authority mutation | senderへの結果 |
| --- | --- | --- |
| initial/exact `Advance` | history insert + head advance | success ACK |
| historical exact `Duplicate` | head不変 | success ACK |
| `SameEpochFork` | head不変、fork evidence追加 | reject/escalate |
| exact-next `ParentFork` | head不変、fork evidence追加 | reject/escalate |
| `Gap` | head不変 | expected headを返しgap recovery |
| `StaleUnknown` | head不変 | reject/resync |
| `BoundaryMismatch` | head不変 | reject、告発には使わない |

history lookupはcurrent head比較より先に行う。authorityがepoch 2まで進んだ後にepoch 1の
正しいretryを受けても`Stale`ではなく`Duplicate` ACKを返し、senderのoutboxを解放する。

### IMPL-ACK-001: acknowledge outbox

- ACKのauthority identity、boundary、epoch、digestを元entryと照合する。
- `Accepted`と`Duplicate`だけが`acknowledged`へ遷移できる。
- ACK更新はdurableにcommitする。
- unknown ACKは無視または監査記録へ送り、別entryを完了させない。
- acknowledged tombstoneは少なくともretry/appealの重複期間中保持する。

### IMPL-GAP-001: atomic gap recovery

gap responseは開始head、target epoch、最大件数を拘束し、連続するcanonical checkpoint列を返す。
receiverは全要素のsignature、boundary、epoch、parentを検査した後だけ一括commitする。一要素でも
不正なら正しいprefixを含めてheadを変更しない。

### IMPL-PRUNE-001: evidence pruning

- 未ACK checkpointとoutbox entryをpruneしない。
- unresolved fork/challenge/appealが参照するevent、proof、checkpointをpruneしない。
- 認証済み参照はdurable holdとして保存し、未解決の間は呼出側の指定がなくてもpruneを止める。
- hold解決は元のboundary、epoch、checkpoint、referenceと完全一致する認証済みdecisionだけを受け入れ、
  解決証跡は対応checkpointをpruneするまで保持する。
- event leafを消した後に返せる精度をmicro/macro精度より細かく表示しない。
- authority historyはhistorical duplicate判定とappeal windowを満たす期間保持する。
- prune watermark自体をdurableにし、crash後に保持期限を巻き戻さない。

## 7. crash consistency

最低限、次のcrash pointをfault-injection testで固定する。

| crash point | restart後に許される状態 |
| --- | --- |
| event transaction commit前 | event/frontierとも未反映 |
| event commit後 | eventが再送なしでも復元可能 |
| seal transaction途中 | history/head/outbox/watermarkがすべて旧状態 |
| seal transaction commit後・send前 | checkpointとoutboxが復元され再送可能 |
| send後・ACK前 | 同じbytesを安全に再送可能 |
| authority commit後・ACK消失 | historical `Duplicate` ACKで回復可能 |
| ACK受信後・local commit前 | ACK再受信またはcheckpoint再送で回復可能 |

authority process/storageのcrash recoveryは現在のQuintモデル外だが、productionではhistory、head、
fork evidence、ACK結果をdurable transactionから復元しなければならない。

## 8. 活性契約と非保証

次をすべて仮定したとき、閉じた最新epochは最終的にauthority headへ到達しなければならない。

1. epochのroster/eligible setとfrontierが有限で固定される。
2. 必要eventまたは正当なclose/idle evidenceが最終的に正直なreplicaへ届く。
3. crashしたnodeが最終的にrestartし、partitionが最終的に解消する。
4. retry workerが継続稼働し、最古未ACK entryを永久に飢餓させない。
5. 繰り返し送信したmessageの少なくとも一つが最終的に配送・処理される。
6. authorityのexact-parent historyが失われない。

いずれかが満たされない場合、finalityは保証しない。withholding、長期partition、under-quorumは
`Pending`またはcentral escalationであり、それだけでcheat確定にしない。

Quint/TLCで検査済みの性質は、2 peer・2 epoch・3 eventにおける上記の有限抽象である。

## 9. mode別のclosure adapter

| mode | 有限な期待集合 | closureに最低限必要な根拠 |
| --- | --- | --- |
| 1:N PvE | encounter開始時party roster | authority receipt + participant frontier、または独立witness |
| N:N PvP | match rosterとteam assignment | 全authorの連続frontier + cross-team/referee certificate |
| open world | seal済みinterest group/eligible encounter set | plan/seal publication + assigned observer certificate |

party全員または同一teamだけの署名は、取引可能assetやrankのeconomic finalityには十分でない。
game adapterは既存の`n > 3f`、`n-f` quorumとcentral escalation policyを適用する。

## 10. resourceと運用契約

- event、checkpoint、gap page、outbox batchには件数・byte数・proof depth上限を設ける。
- outbox high-water mark到達時はsealをfail-closedにし、provisional表示とbackpressureを返す。
- retry回数上限は配送停止ではなく、alarm/escalation levelの変更に使う。
- metricは最低でもoldest pending age、pending count、attempts、ACK latency、gap/fork数、
  seal拒否数、prune backlogをscope別に持つ。
- logへprivate payloadやkey materialを出さず、digest/idempotency keyで追跡する。

## 11. 現在の実装との対応

| 契約 | 現状 | 判定 |
| --- | --- | --- |
| policy、commitment、head pure classifier | `src/audit`、Why3、runtime test | Implemented / Proven scope |
| closure/ACK/atomic seal/delivery authentication/evidence inbox/poll schedule/case/source resolution handoffとvote mergeのfail-closed gate | `src/audit`の60 proof goals + quorum vote 8 goals + `src/audit/runtime` | Implemented / Proven scope |
| opaque atomic seal plan/outbox、lease、release、最古retry選択 | `src/audit/runtime` | pure contractはImplemented + Tested |
| watermark駆動micro/macro builder | `src/audit/layered` | in-memoryはImplemented、mode固有closure検証adapterはPending |
| player-local authenticated event DB | 共通host contract + Node 24 SQLite / IndexedDB relation、event/equivocation/checkpoint/head/closure/outbox/ACK履歴、retention anchor、active/resolved evidence hold、source別evidence inbox cursor/poll job、lease/attempt fencing、revision CAS、起動時全image検証 | Node/IndexedDB Reference Implemented + Tested / mobile SQLiteはPending |
| seal + local head + checkpoint outboxのatomic transaction | opaque planから公開write-setを導出し、player-local Node SQLite、browser IndexedDB、Cloudflare SQLiteで一括適用、player-local adapterは共通4 fault rollback | Tested locally / mobile SQLiteはPending |
| player-local evidence prefix pruning/poll | MoonBit一段guard、appeal floor、protected/equivocation pin、durable active/resolved evidence hold、署名済みhash-chain hold envelope、source cursorとのatomic apply、bounded single-page polling、durable poll schedule/lease/attempt fencing/backoff/restart回復/operational terminal、ACK済みprefix、durable anchor、Node SQLite/IndexedDB rollback | Proven predicate/auth/hash-chain/page/schedule gate + Tested locally / poll schedulerからcase endpointへの自動提出はPending |
| lineage case起票・裁定 | scheme別evidence source/arbiter verifier、別roster、hold referenceによるexact origin/checkpoint binding、case SQLite、v2 uphold certificateとdismissal certificateのexact case ID、resolution CAS、dismissal history、hold resolution draft、provisional revoke、時間制appeal、finalized/expired、ancestor別decision history、単一asset status readとUX射影 | MoonBit/Why3 gate + Quint normal/broken model + Worker SQLite Tested locally / transfer case・production key rotationはPending |
| case resolution source relay | case起票時の署名済みplacement、arbiter certificate付きdurable resolution notice、key-bound v2 poll/envelope writer、cutoff付きv1/v2 dual reader、履歴compile + O(1) exact key lookup、audience/unit/cursor拘束、sourceによるcertificate再検証、publish前exact envelope永続化、SQLite lease/attempt fencing/backoff/alarm、crash後同一再送、player-local bounded pollerによるhold解除 | MoonBit/Why3 gate + case/relay/migration Quint normal/20 broken + authority/source Worker/IndexedDB Tested locally / production roster rotation・外部signer service実deploymentはPending |
| authority boundary/initial headの事前provision | 管理API → destination DO、source側provision ledger、未設定receiver拒否 | Tested locally |
| Queue jobのsource outbox認証 | receiver mutation前のsource DO exact-match | Tested locally |
| producer署名 + provision済みwitness quorum | `src/audit/delivery_auth`のopaque capability、MoonBit canonical serializer、標準WebCrypto + MoonBit dual verifier、source/receiver二重gate | Proven gate + dual verifier Tested locally |
| versioned key lifecycle | key ID/version/purpose/scope/public keyを含むcanonical statement、署名時点validity/effective revocation、provision時履歴compile、O(1) exact lookup、rotation後の過去checkpoint検証、revision CAS + append-only event、同期/非同期共通preflight、WebCrypto非抽出signer、旧seed一方向migration | MoonBit 5 goals + key lifecycle/migration Quint normal/8 broken + Cloudflare SQLite/IndexedDB transaction + secret-backed signer Worker + MoonBit/WebCrypto共通vector + browser E2E Tested。source resolutionとcheckpoint deliveryのv2 writer/cutoff付きdual reader、policy永続化、rotation後witness選択はImplemented / mobile SQLite・timestamp trust・実provider監査はPending |
| remote witness collection | 公開pull/ローカル署名submit、producer/各approvalの標準WebCrypto + MoonBit partial capability、pure bounded fanout/指数retry/backpressure/複数response選択、SQLite collection、deadline | remote E2E + crypto ingress + pure scheduler Tested / socket push・global fair queueはPending |
| observer reserve-before-sign | MoonBit proved classifier/canonical key、Durable Object SQLite reservation + sequence transaction、exact retry、conflict evidence、Merkle snapshot/trusted anchor、内部専用RPC | Quint正常/volatile Red model + workerd fault/eviction/signer-failure/concurrency/corruption test。Cloudflare referenceはImplemented、device/mobile DB・外部署名credentialはPending |
| player-local peer checkpoint fanout | MoonBit JS policy、SQLite route/lease/attempt/backoff/fork quarantine、bounded HTTP POST、restart lease | loopback 7 tests / 実credential・WebSocket/WebTransportはPending |
| 最古未ACK checkpoint retry worker | direct DO RPC、SQLite lease、DO alarm + pure選択契約 | Tested locally + remote E2E |
| authority exact-parent + historical duplicate | 専用receiver history/head transaction + generic classifier | Tested locally + remote ACK-loss recovery |
| authenticated success ACK | internal DO channel + opaque MoonBit ACK gate + SQLite tombstone | Proven core + remote 20/20 |
| atomic gap batch | in-memory transportとCloudflare gap API | Partial |
| server-side central replay outbox | Cloudflare `replay_outbox` | Tested locally |
| multi-asset inventory checkpoint | MoonBit opaque verified capability/write-set digest、canonical 1〜64 proof wire、Cloudflare全head/history/idempotency transaction | Proven gate + Tested locally / 汎用player-local checkpoint storeへのinventory write-set拡張はPending |
| checkpoint transportの有限safety/liveness | Quint/TLC、bounded outbox込み11,340 distinct states | Model checked、capacity gate除去で反例 |
| checkpoint traceの実装conformance | Quint ITFをMoonBit policy + Node SQLiteへstep replayし、event/head/未ACK outbox/authority射影を比較 | Deterministic MBT Tested |
| witness collectionの有限safety/liveness | Quint/TLC、4 roster + 1 intruder、safety 30,720 / liveness 19,456 distinct states | Model checked |
| witness認証gateの実装conformance | Quint ITFを実Ed25519 MoonBit delivery authenticationへstep replayし、accepted roster/status/receiver射影を比較 | Deterministic MBT Tested |
| authority DB crash/restore | Durable Object local testのみ、Quint範囲外 | Partial |

管理者限定の`x-audit-checkpoint-dispatch: deferred`はfault injectionとQueue互換試験だけに使う。
これは初回direct RPCを保留するが、entryはlease付き`in_flight`へ進み、30秒後のalarmはdirect retryする。
省略時のproduction契約は`direct`である。

Cloudflareの`replay_outbox`は中央replay job用、`checkpoint_outbox`は汎用checkpoint seal用である。
後者もCloudflare reference adapterではtransport/lease/retry/ACKまで接続した。さらにcheckpointの
exact statementをproducerとprovision済みwitness quorumが署名し、source seal前とreceiver mutation前の
両方で検証する。署名収集は公開pull/ローカル署名/submit型referenceとper-source rate limitまで接続し、
東京clientから全modeの`apac-ne`、PvPの`wnam`/`weur` hintを各20 run測り、並列3/4 quorumとsealを
100/100 E2E確認した。さらにPvP `apac-ne`でauthority ACKまで20/20確認し、seal開始からACKは
mean 0.729秒 / p95 1.003秒だった。ただしoutbound push、global/roster-aware fair queue、production端末DB統合、
監査済みproduction cryptoは未接続である。単一client・単一egressのremote実測をproduction P2Pの
source独立性や全地域SLAと同一視してはならない。

key lifecycleのwire/storage移行、routine rotationとretroactive revocationの区別、private-key custodyは
[署名鍵ライフサイクルと過去checkpoint検証契約](./key-lifecycle-ja.md)をsource of truthとする。

形式仕様とのreconciliation ledger:

| 項目 | 内容 |
| --- | --- |
| source | Quint `sendCheckpoint`は`checkpoint.in(availableOutbox(peer))`を要求する |
| implementation observation | 以前のQueue consumerは自己整合した未知jobをreceiverへ先に渡せた |
| model question | source outboxにないjobでauthority headを更新できるか |
| machine result | workerd反例で偽造jobが先にacceptedされ、後続の正規jobがsame-epoch forkになった |
| decision | 実装bug。receiver mutation前にsource outbox exact-matchを必須化した |
| lock | unprovisioned receiver拒否とforged-consistent job後の正規delivery成功test |

| 項目 | 内容 |
| --- | --- |
| source | `IMPL-AUTH-001`は敵対的peerでproducer署名とroster/quorum capabilityを要求する |
| implementation observation | internal outbox exact-matchだけでは、peer由来checkpointの生成主体と相互承認を証明しない |
| model question | 認証Booleanを呼出側が偽装せず、完全なtrust factsを通過した値だけreceiverへ渡せるか |
| machine result | MoonBit lemmaはstatement/policy/producer identity/signature/roster/quorumの全条件を要求し、opaque capability以外から受理値を生成できない。key authentication migration Quintはv2-only writer、v1 cutoff、履歴、exact bindingを外す4 broken modelで反例を出す。workerdでは保存cutoff後のv1を無変更拒否し、DO再起動後にv2を受理した |
| decision | game固有の署名bundleを汎用transport前段へ追加し、transport順序はsource outbox完全一致へ分離した。新規writerはv2だけを生成し、v1は保存されたexclusive cutoffまでのdrainに限定する |
| lock | source under-quorum無変更、receiver署名改ざん・foreign witness・under-quorum無変更後の正規delivery成功、保存cutoff/再起動、rotated witness key selection test |

| 項目 | 内容 |
| --- | --- |
| source | `AUD-TRUST-003`と`IMPL-COLLECT-001`はtimeout/under-quorumをcheat確定せず、正直なquorum到達時の活性を条件付きで要求する |
| implementation observation | 「何らかの応答を公平に処理する」だけではhostile duplicateを処理し続け、未採用の正直な応答を飢餓化できる |
| model question | foreign/duplicate/timeout下で不正なready/receiver advanceを防ぎ、正直な未採用応答が公平ならeventually readyになるか |
| machine result | safety 30,720、liveness 19,456 distinct statesで反例なし。弱い公平性ではhostile duplicate starvation反例を検出した。標準WebCryptoとMoonBitはproducer-only/partial quorumの成功・拒否を一致させ、生成WebCrypto鍵だけでproducer→witness→full quorumを完走した |
| decision | 活性仮定を「未採用の正直な応答が公平に処理される」へ限定する。正当なunder-quorumにはexact-bound partial capabilityを発行する。peerはproducer bundleを再検証し、注入signerがrosterと一致した場合だけ署名する。reference adapterではhashed sourceごとのfixed windowを入れ、global fairnessはproduction要件として残す。rate-window attemptはapproval受理状態と分離する |
| lock | `WitnessQuorum.qnt`、producer/roster gateを外す2 broken module、`production-crypto.test.ts`の標準sign/partial capability、`witness-client.test.ts`のretarget/no-POST、workerd invalid producer/foreign/invalid/duplicate/quorum/expiry/source-isolation test、20-run local flood benchmark |

| 項目 | 内容 |
| --- | --- |
| source | conditional livenessはcrash/restart後も未ACK outboxを再送し、authority ACKをdurableに保存することを要求する |
| implementation observation | 本番の新規isolateでalarmがMoonBit runtimeをロードせずACK gateを呼び、authority commit後もsource entryが`in_flight`へ残った |
| model question | process-local runtimeを失った状態から、durable outboxだけでhistorical Duplicate ACKを回収できるか |
| machine result | production tailで未初期化例外を観測。dispatch入口へruntime loadを移した後、同一entryはattempt 4の`Duplicate`で自動回復し、続くremote 20 runは20/20 `Accepted` |
| decision | runtime初期化はHTTP handlerではなく、alarmを含む全checkpoint dispatchのpreconditionにする。ロード関数が返すbranded `LoadedCheckpointRuntime` capabilityをseal、receiver認証、witness収集、ACK gateの必須引数にする |
| lock | TypeScript capability contract、偽造tokenを3同期gateで拒否するtest、direct dispatch integration test、43 Worker tests、remote direct/deferred ACK artifacts |

| 項目 | 内容 |
| --- | --- |
| source | `IMPL-EVENT-001`、`IMPL-SEAL-001`、`AUD-OPS-004`はevent/equivocationとseal/ACKのatomic永続化・restart復元を要求する |
| implementation observation | opaque outbox値だけのmemory snapshotでは、実プロセス再起動後にSQLite/IndexedDB行から安全に再構築できない |
| model question | 公開row DTOを改ざん・欠損させたimageからorphan headやACK履歴なしのacknowledged outboxを復元できるか |
| machine result | MoonBit正常imageはevent/equivocation/head/outbox/ACKを復元し、orphan headとACK footprint欠損を拒否した。Node SQLiteでもrestart後の同値image、stale CAS、容量超過、ACK footprint欠損を検査し、history/head/outbox/closure各書込み直後の例外は全旧状態へrollbackした |
| decision | `PlayerLocalAuditStore`を汎用reference transaction、`PlayerLocalSealPlan::write_set()`をstorage-neutral境界とし、物理adapterは公開DTOを同一transactionで保存・再構築する。未認証network payloadからwrite-set/ACKを直接構築してはならない |
| lock | MoonBit local store 26 tests、Node SQLiteとIndexedDBへ同じ11 conformance tests、engine固有のrestart/collision/quota/migration tests、`just test-node-audit-runtime`と`pnpm test:assets`。Quintのatomic `sealNextCheckpoint`を実装へ対応付けるが、DB engine自体をmodel checkedしたとは主張しない |

| 項目 | 内容 |
| --- | --- |
| source | Issue #13はNode SQLiteとbrowser IndexedDBへ同じstorage contract、atomic seal、restart再送、ACK容量解放、quota/migration fail-closedを要求する |
| implementation observation | browser game固有snapshotだけでは、汎用checkpoint outboxとACK証跡を同じ構造でmobile/Nodeへ移植できず、version upgradeとquota failureの境界も曖昧になる |
| model question | 既存Quintのatomic `sealNextCheckpoint`射影を保ったまま、非同期DB adapterでもpartial write、stale revision、破損ACK footprint、未知schemaを受理せず再起動できるか |
| machine result | Node SQLite/IndexedDB共通conformance 11件、Node全28件、IndexedDB/asset全36件が通過した。Chromium 128 epochではseal mean 1.85 ms / p95 3.3 ms、ACK mean 1.28 ms / p95 2.3 ms、reload + 全image検証2.2 msだった |
| decision | DTO/validator/MoonBit write-set policyを`examples/player-local-runtime`へ分離し、IndexedDBはcheckpoint/head/closure/outbox/revisionを一transactionで適用する。quota、未知future schema、欠損ACK証跡はfail-closedにする |
| lock | `pnpm test:assets` 36 tests、`bench:player-local-indexeddb:browser`、Node package 28 tests。game snapshotとのcross-store atomicity、mobile SQLite、暗号化at-restは未達として残す |

| 項目 | 内容 |
| --- | --- |
| source | `IMPL-PRUNE-001`は未ACK checkpoint、未解決fork/challenge/appealを削除せず、prune watermarkをcrash後も巻き戻さないことを要求する |
| implementation observation | ACK tombstoneを無期限保持すると配送capacityとは独立に端末DBが単調増加する。一方、先頭以外を削除するとcheckpoint parent chainを復元できない。また未解決参照を呼出側の`protected_epochs`だけで渡すと、指定漏れにより必要証拠を削除できる |
| model question | durable anchor直後の連続epochだけを対象に、appeal floor、全outbox ACK、未解決参照なしを同時に要求し、未解決参照を認証済みdurable holdから自動導出すれば、必要証拠を飛び越えずprefixを短縮できるか。未認証またはbinding不一致の解決でholdを解除できないか |
| machine result | MoonBitのpruning/hold predicate 8 proof goalsが、prune受理時の全guard、未ACK/protected拒否、hold配置・解決の認証とexact bindingを証明した。Node SQLite/IndexedDB共通testはanchor restart、未ACK/protected/equivocation/active hold停止、hold解決、stale CAS、4 fault rollbackを通過。Chromiumで8 epoch pruneは10.4 ms、imageは161,528から151,571 bytesへ減少した |
| decision | pruningは時間的interleavingを増やすworkerではなく、一段のpure eligibilityをMoonBitで証明し、CAS transactionをconformance testでrefineする。認証済み参照は永続的な`active -> resolved` relationにし、active holdをvalidator自身が保護対象へ加える。削除は連続prefixのみ、最後のdigestをdurable anchorにし、anchor以前を指す遅延appealはfail-closedにする |
| lock | `pruning.mbtp`、`pruning_test.mbt`、MoonBit hold/pruned-image restore、Node 28 tests、IndexedDB/asset 36 tests、Chromium pruning benchmark。階層Merkle pruningは別要件として残す |

| 項目 | 内容 |
| --- | --- |
| source | `IMPL-PRUNE-001`のdurable holdは認証済み参照だけを受理し、暗号backendはstorage/pruning contractから交換可能でなければならない |
| implementation observation | low-level runtimeへ呼出側が`authenticationSucceeded=true`を直接渡すだけでは、外部HTTP payloadとのtrust boundaryがコード上に現れず、署名対象fieldの追加漏れも検出できない |
| model question | source/message ID、boundary、checkpoint/reference、resolution decision、source別sequence/previous digestを一つのdomain-separated statementへ束縛し、設定済みsourceの署名検証後だけ既存MoonBit gateへ渡せば、改ざん・未知source・再送・gapをfail-closedまたは冪等に扱えるか |
| machine result | 実MoonBit Ed25519 adapterを使うbrowser runtime testで、改ざん署名とsource mismatchは無変更拒否、正しいplace/resolveは永続化、同じsequence/digest再送は`no_change`、署名済みでもwrong previous digestとsequence gapは無変更拒否になった。共通wireはcrypto固有型を持たずauthenticator interfaceだけに依存する |
| decision | `evidence-hold-wire.ts`をcanonical wire contract、`evidence-hold-authenticator.ts`を交換可能な参照crypto adapter、browser runtimeを検証済みenvelopeからdurable hold/cursorへの接続点とする。poll transportはこのAPIだけを呼ぶ |
| lock | `evidence_inbox.mbtp`の3 proof goals、`player-local-indexeddb.node-test.ts`のsigned hash-chain envelope test、TypeScript strict check、IndexedDB/asset 36 tests |

| 項目 | 内容 |
| --- | --- |
| source | 外部裁定sourceのcursorはcrash/restart後も巻き戻らず、hold更新と同じ受理単位で進む必要がある |
| implementation observation | hold保存後に別transactionでcursorを進めると、その間のcrashで同じmessageを別状態へ再適用するか、逆順にすると未保存holdを処理済みとして飛ばせる |
| model question | 現在sequenceが`-1`以上、次がexact `+1`、previous digest一致、message digest前進、認証成功、操作許可の全条件を満たすときだけcursorを進められるか |
| machine result | MoonBit/Why3で3 obligationsを証明した。Node SQLite/IndexedDB共通conformanceはhold後・cursor後の障害注入で旧imageへのrollback、restart後のcursor復元、bad resolutionの無変更拒否を通過した |
| domain wording | source chainのmessageを一件受理するか一件も受理しないかのどちらかであり、holdだけ・cursorだけが端末DBへ残る状態は作らない |
| decision | hold mutation、source cursor、storage revisionを一つのDB transactionへ入れ、hash-chain guardはMoonBit bridge、CAS/refinementは共通host validatorと両adapterで再検査する |
| lock | `evidence_inbox.mbt/.mbtp`、共通conformance 11件、Node 28 tests、IndexedDB/asset 36 tests。sourceからのdurable取得schedule/backoffは後続のpoll job契約へ分離する |

| 項目 | 内容 |
| --- | --- |
| source | 外部裁定sourceは敵対的または障害中でもあり得るため、resource上限と受信期限を越えたpageで端末DBを進めてはならない |
| expected claim | deadline前に受信し、message件数/response bytesが上限内で、source/cursor anchorが一致するpageだけをmessage検証へ渡す。timeout/期限切れはactive holdを解除しない |
| implementation observation | `response.json()`を直接使うとbodyを上限なしに確保し、pageを一括成功扱いすると後半の不正messageか前半の正当messageのどちらかを誤って扱う |
| model question | 受信時刻、deadline、message count、response bytes、source/cursor bindingの全guardを満たす場合だけpageをadmitできるか |
| machine result | MoonBit/Why3で4 obligationsを証明した。browser testは正しい2-message page、durable cursorからの再開、real HTTP POST、wrong anchor、response deadline、request timeout、byte/page超過、不正な後続messageを検査し、29 asset testsが通過した。Chromiumで13,648-byte/16-message pageは85.3 ms、5.33 ms/messageだった |
| domain wording | remote responseが遅い・巨大・別cursorでもhold状態は変わらない。page途中に不正messageがある場合は、それ以前に個別認証された連続prefixだけが残る |
| decision | `evidence-inbox-polling.ts`をpage DTO/decoder、browser `evidence-inbox-poller.ts`をbounded POST driverとする。deadlineはresponse受信期限であり、caseを自動dismissする時刻ではない |
| lock | `evidence_polling.mbt/.mbtp`、`evidence-inbox-poller.node-test.ts` 4 tests、`pnpm typecheck`。durable schedule/backoffとoperationalなexpired/escalated遷移は後続のpoll job契約へ分離する |

| 項目 | 内容 |
| --- | --- |
| source | bounded pollerをtimerから直接呼ぶだけでは、process/tab再起動後のin-flight状態、二重実行、retry時刻、期限到達を復元できない |
| expected claim | sourceごとに一つのjobを永続化し、dueかつdeadline前でleaseが空いたときだけclaimする。各claimは単調attempt tokenを発行し、completionはtokenとlease expiryの完全一致を要求する |
| implementation observation | lease expiryだけをCAS tokenにすると同じexpiryで再claimされた古いworkerを識別できない。またpoll timeoutがleaseより長い構成では正常なworker同士が重複し得る |
| model question | deadline到達後のclaimを常に拒否し、backoff stepを非減少かつcap以下に保ち、物理DBではrestart後のlease expiry回復とstale completion拒否を維持できるか |
| machine result | MoonBit/Why3でclaim/deadline/backoffの4 goalsを追加した時点でcoreは50 goals、case handoffとsource resolution追加後の現在は60 goals。共通conformance 11件をNode SQLite 28 testsとIndexedDBで通し、browser scheduler 5 testsがdue実行、100→200 ms指数backoff、restart reclaim、deadline expiry、別claim後のlost lease、absolute Unix msの相対duration正規化を確認した。asset全体は36 tests |
| domain wording | `expired`は取得期限の終了、`escalated`は人手・上位系へ引き渡した運用状態であり、cheat判定でもchallenge/appealのdismissでもない。どちらもactive holdを維持する |
| decision | logical imageへsource別job、deadline、next poll、failures、attempt count、scheduled/in-flight/expired/escalatedを含める。leaseはdeadlineでcapし、`requestTimeout <= leaseDuration`を実行前に要求する。成功はfailuresを0へresetし、失敗はMoonBit policyのdeadline-capped backoffで再scheduleする。JSのabsolute Unix msはMoonBit `Int`へ直接渡さず、hostで現在時刻を0とするbounded relative durationへ正規化する |
| lock | `evidence_poll_schedule.mbt/.mbtp` 4 goals、共通storage conformance、SQLite table、IndexedDB schema v6、`evidence-inbox-scheduler.node-test.ts` 5 tests。poll terminalはcase起票でもhold解除でもなく、case提出は独立adapter責務とする |

| 項目 | 内容 |
| --- | --- |
| source | Issue #17。active evidence holdは調査開始の根拠であって、cheat verdictや経済状態の変更権限ではない |
| expected claim | roster内sourceが署名したactive placementを、scope/unit/asset/origin/boundary/epoch/checkpointへexact bindした場合だけcaseを永続化する。case作成だけではasset/listingを変更しない。case IDを含む外部arbiter v2 certificateはcaseとlineageを同時にupholdし、別の署名付きdismissal certificateはcaseだけを閉じてlineageを変えない。どちらも端末holdを直接解除せず、sourceがexact resolutionとnext cursorを再署名した場合だけ解除する |
| implementation observation | holdの署名だけを検証して任意asset IDと組み合わせると、正しいholdを別assetへretargetできる。case作成を既存revoke endpointへ直結すると、evidence sourceがarbiter権限を得てしまう |
| model question | 未認証/retarget hold、case作成時auto-revoke、未認証/retarget uphold/dismissal certificate、dismissal時asset mutation、case closeだけのhold自動解除、未認証/retarget/stale-cursor source resolutionを許す各broken構成で安全性が破れるか |
| machine result | MoonBit/Why3でcase admission/decision/dismissal/source resolutionの10 obligationsを証明した。case Quint/TLC正常modelは反例なし、12 broken modelは意図した反例を検出する。追加relay modelも正常反例なしで、poll credential/pending durability/retry durability/attempt fenceを外した4 modelが反例を出す。key authentication migration modelも正常反例なしで、v2-only writer、legacy cutoff、key history、exact bindingを外した4 modelが反例を出し、4 rollout scenarioを通す。authority workerdはdurable notice、arbiter certificate再検証、v1 cutoff、v2 key history/binding、source署名改ざん拒否、next cursor、冪等再送、player inboxのplacement→resolve連鎖を検査する。独立source workerdは503 backoff、not-due、eviction後lease回復、key-bound v2署名poll、publish前pending保存、publish失敗後eviction、exact bytes再送、duplicate ACK後cursor前進を検査する。IndexedDB testはplacement/resolutionを既存pollerへ適用する |
| domain wording | 「監査中」「case棄却」「使用禁止」「端末hold解除」を分離する。caseがopenでも通常プレイと出品を止めず、uphold時だけquarantineする。case close時点ではholdを解除せず、認証済みsourceがexact resolutionを次のhash-chain cursorへ再署名したときだけ端末holdを解除する |
| decision | holdの`reference_digest`をcase reference hashとし、case IDはreference hashと署名済みmessage digestから導出する。cryptoは`scheme -> verifier`、identityは`EVIDENCE_HOLD_SOURCE_ROSTER`/versioned key historyと`LINEAGE_ARBITER_ROSTER`へ分離する。poll credentialはauthority origin/unit/source/cursor/limitを署名し、v2 authenticationでpurpose/key scope/unit/subject/digestへ再束縛する。新規writerはv2だけを生成し、dual readerのv1 cutoffはauthority設定で必須にする。arbiter certificate付きnoticeをdurable outboxへ保存し、sourceが再検証・再署名したenvelopeだけを既存player-local inboxへ流す。authority Workerとsource relayを別deployにし、relayも秘密鍵ではなく`SOURCE_SIGNER` service capabilityだけを持つ |
| lock | `evidence-lineage-case.ts`、`evidence-case-resolution-relay.ts`、source resolution authorization adapter、`evidence-resolution-relay-worker.ts`、`verification-key-signer-worker.ts`、`wrangler.source-relay.jsonc`、`evidence_lineage_case_*_allowed`、`evidence_case_source_resolution_allowed`、`EvidenceLineageCase*.qnt`、`EvidenceResolutionRelay*.qnt`、`KeyAuthenticationMigration*.qnt`、case/resolution/inbox endpoints、authority/source SQLite CAS、Worker/IndexedDB integration tests |

| 項目 | 内容 |
| --- | --- |
| source | `AUD-ASSET-004`は、管理tokenだけでなく外部arbiterが認証したlineage decision、期限付きappeal、独立した祖先revocationを要求する |
| expected claim | domain-separated statementへscope/unit/asset/ancestor/kind/revision/outcome/reason/timestampsを固定し、roster内arbiterの署名、certificate期限、exact CAS、exact appeal target、appeal deadlineがすべて成立する場合だけdecision head/historyを進める |
| implementation observation | 旧APIは自由文reasonと管理tokenだけで`revoked`/`eligible`を切り替えられ、appealがどのrevokeを覆すか、いつまで有効か、誰が裁定したかを永続化していなかった |
| model question | provisional revokeを期限後もeligibleへ自動復帰させず、別祖先のrevokeを残し、wrong target・期限外・stale revision・未認証certificateを拒否できるか |
| machine result | MoonBit/Why3で外部certificate admissionの4 goalを含む176 goalを証明した。Quint/TLCは正常model 795 msで反例なし、authentication/certificate time/revision/appeal target/deadlineの5 broken modelで意図した反例を検出した。workerdは無署名、unknown arbiter、期限切れcertificate、wrong lineage、stale revision、期限外appeal、exact duplicate、複数revoke、DO eviction後のappealを検査した |
| domain wording | certificate期限は署名付き命令の受理期限、appeal deadlineは既存revokeを覆せる期限である。期限切れrevokeはcheat確定でも自動restoreでもなく、asset利用を止めた`expired` caseになる |
| decision | 暗号方式は`scheme -> verifier` registry、identityは環境provision rosterへ分離する。decision IDはcanonical statement digest、署名とarbiter metadataをhistoryへ保存する。eligible appealは直前decision IDを明示し、quarantine済みlisting nonceを復活させない |
| lock | `lineage-decision-certificate.ts`、`asset_lineage_certificate_allowed`、`LineageAppeal*.qnt`、両lineage decision/status endpoint、SQLite head/history migration、Worker 101 tests、Playwright 4状態回復test |

| 項目 | 内容 |
| --- | --- |
| source | `AUD-EVENT-002`は同一slotのequivocationを吸収的かつrestart可能に保持し、同一digestのcanonical bytes衝突をfail-closedにする |
| implementation observation | accepted event側のdigest collisionは拒否していたが、既知のconflicting digestを別canonical bytesで再投入すると2件目のevidenceを追加できた |
| model question | runtime自身が、restore validatorのdigest一意制約に違反するdurable imageを生成できるか |
| machine result | broken testは`LocalEventEquivocation`を返した直後に同一conflict keyが重複し、restart拒否となる経路を再現した。修正後はMoonBit/Node SQLiteとも`digest_collision`で無変更拒否し、全testが通った |
| decision | accepted branchだけでなくequivocation branchでも、同一digest・異canonical bytesをcollisionとして扱う |
| lock | `player-local store refuses a canonical collision on a known fork digest`とNode同形test |

| 項目 | 内容 |
| --- | --- |
| source | `IMPL-PEER-SEND-001`とQuint retry抽象は、bounded fanout、crash後の再試行、未認証応答の無害化、認証済みforkの吸収を要求する |
| implementation observation | pure schedulerだけではprocess再起動時のin-flight数を復元できず、送信timeoutがleaseより長い構成では正常稼働中にも同じrouteを再claimできる |
| model question | durable lease中のrestart、1成功+1未認証/失敗、1成功+1署名済みforkで、backpressure・fair retry・fork evidenceは期待どおり残るか |
| machine result | Node loopback 7 testsでMoonBit JS選択、2並列上限、restart lease、期限後retry、success/failure永続化、oversize拒否、署名済みfork quarantineを確認した。`timeout > lease`は構築時拒否に固定し、fork evidenceとquarantineの不一致はrestart時に破損として拒否した |
| decision | route/lease/evidenceをSQLite state、選択/遷移をMoonBit policy、HTTPを交換可能I/Oへ分離する。HTTP到達や未認証bytesだけでcheat判定しない |
| lock | `peer-checkpoint-transport.node-test.ts` 7 tests、Node package合計21 tests、`just test-node-audit-runtime`。Quint抽象への実装refinement testでありHTTP stack自体のmodel checkではない |

| 項目 | 内容 |
| --- | --- |
| source | resource契約はoutbox high-water mark到達時にcheckpoint sealをfail-closedにする |
| implementation observation | capacityをruntime validationだけに置くと、時間的modelがbackpressureなしのseal列を許す可能性が残る |
| model question | 未ACK outboxが容量1の間に次epochをsealできるか。network安定後のlatest finalityを壊さないか |
| machine result | 正常設定は55,849 generated / 11,340 distinct statesで安全性・活性とも反例なし。capacity gate除去設定は`OutboxWithinCapacity`違反を検出した |
| decision | capacity checkを`sealNextCheckpoint`のload-bearing guardとしてQuintへ固定する |
| lock | `checkpointBrokenBackpressure`を含む7 broken moduleと`just formal-check` |

| 項目 | 内容 |
| --- | --- |
| source | Quintの`availableOutbox`は未ACK checkpointだけを含み、ACK後はcapacity 1でも次epochをsealできる |
| implementation observation | MoonBit local store、Node SQLite、Cloudflare SQLiteはacknowledged tombstoneを保持し、その総row数をcapacityへ数えていた |
| model question | epoch 1をACKした後、証跡を削除せずepoch 2をseal・配送できるか |
| machine result | capacity 1のITF replayがepoch 2 sealで`concurrent_write`を再現した。未ACK countへ修正後、11 stateをMoonBit + SQLiteへ完走し、WorkersでもACK済み2 rowを保持したままhead epoch 1へ進んだ |
| decision | `outbox_entry_count = pending + in_flight`とし、acknowledged履歴のretention上限を配送capacityから分離する |
| lock | `just quint-mbt`、MoonBit/Node capacity reuse回帰test、Cloudflare direct ACK 2世代integration test |

| 項目 | 内容 |
| --- | --- |
| source | Quint `WitnessQuorum`はvalid roster responseだけをdistinct approvalへ加え、producer認証済みquorum以外でreceiverを進めない |
| implementation observation | modelの抽象`response.valid`と実Ed25519の具体的なrefusal codeの対応はmodel checkとunit testの間で明示されていなかった |
| model question | validなintruder、不正なroster署名、正直なW1/W2/W3を同じ順序で処理したとき、accepted setとreceiver gateは一致するか |
| machine result | 12 stateのITF replayで順に`unknown_witness`、`invalid_witness_signature`、2回の`under_quorum`、3承認成功を得て、Quintのaccepted roster/status/receiver射影と一致した |
| decision | Quintの`valid roster response`を「exact statementに対するprovision済みkeyの署名検証成功」へ具体化する。network、expiry、rate limitはこの射影外としてWorkers testへ残す |
| lock | `WitnessQuorumMbt.qnt`、`quint-witness-mbt.ts`、`just quint-witness-mbt`を`formal-check`へ組み込む |

## 12. 受入テスト

production adapterは最低限、次を自動検査する。

1. frontier中のeventが一つ欠けるとclosure/sealできない。
2. seal commit前のcrashでは何も進まず、commit後のcrashではcheckpointとoutboxを復元できる。
3. 最初のN回をdropしても、network回復後に同じcheckpointがACKされる。
4. epoch 2を先に送信しても、retryはepoch 1を飢餓させない。
5. authority commit後にACKを失っても、再送へhistorical `Duplicate` ACKを返す。
6. same-epoch fork、wrong parent、gap、foreign boundaryでheadが変わらない。
7. gap batchの最後だけ不正でもprefixをcommitしない。
8. timeout、partition、under-quorumだけではcheat確定にならない。
9. outbox満杯時にhead/watermarkだけが進まず、ACK後はtombstoneを保持したまま容量を再利用できる。
10. prune/restart後も必要なduplicate、appeal、fork evidenceを復元できる。
11. 未provision receiverとsource outboxに存在しない自己整合jobでauthority stateが変わらない。
12. producer署名改ざん、非roster witness、duplicate witness、under-quorumでsource/receiver stateが変わらない。
13. collectionのforeign/invalid応答は承認数を増やさず、deadline expiryはcheatにせずsealを拒否する。
14. 同一送信元がclient指定bucketを変えてもrate limitを回避できず、別送信元の正当quorumは進行する。
15. peer clientはproducer statement/signatureまたは注入signerの公開鍵がrosterと一致しない場合、
    approvalをnetworkへ送らない。
16. quorumに必要なpeer approvalを並列fanoutし、収集待ちでrender/inputを停止しない。
17. source resolutionの新規writerはv2だけを生成し、v1はexclusive cutoff以後拒否する。v2の未知鍵、
    欠落履歴、別scope/unit/subject/digestへのretargetではauthority/player-local stateが変わらない。

回帰入口:

```sh
just formal-check
just prove-audit-core
just test-audit-layered
just test-audit-runtime
just test-node-audit-runtime
just check-node-audit-runtime
moon test
```

DB fault injection、checkpoint outbox配送、通常ACK、authority commit後のACK lossとhistorical
`Duplicate`回復、実暗号producer/witness認証のfail-closed回帰はCloudflare workerd testへ追加済み。
per-source fixed-window rate limitと別source progressはlocal workerdで検査し、remoteでは単一egressの
429と`Retry-After`後の並列quorumを全mode・3 hintで100/100確認した。複数回drop、partition、実時間lease expiry、
異なるremote source間の公平性、NAT/botnetを含むglobal fair queueは引き続き受入テストが必要である。
