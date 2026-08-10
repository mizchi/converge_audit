# Checkpoint delivery / witness quorum / asset settlement / key lifecycle Quint model

このディレクトリは、ゲーム固有の戦闘規則ではなく、local-firstな監査ログをpeerから
権威サーバーへ確定させる時間的protocolと、検証済みassetのsettlement状態機械のsource of truthである。

MoonBit/Why3が純粋な受理predicateを担当し、Quint/TLCは配送順、再送、crash、packet loss、
partitionをまたぐ状態遷移を担当する。実adapterが満たすtransaction/API契約は
[persistence / transport実装契約](../../docs/game-audit-implementation-contract-ja.md)に定める。

コードの読む順番、nondet wrapper、fairness、property追加手順は
[Quintモデルの読み方と変更手順](./GUIDE-ja.md)に分離している。

QuintはTLAの意味論を持つtyped specification languageである。完全な有限状態探索と
fairness付きlivenessには`quint verify --backend=tlc`を使う。既定のApalache backendは
bounded/inductive safetyへ選択的に使い、TLCのliveness gateとは区別する。

- [Quint repository](https://github.com/quint-co/quint)
- [Quint: Model Checkers](https://quint.sh/docs/model-checkers)
- [Quint: Checking Properties](https://quint.sh/docs/checking-properties)

## Source構成

- `CheckpointDelivery.qnt` / `WitnessQuorum.qnt` / `AssetOwnership.qnt` / `LineageAppeal.qnt` / `EvidenceLineageCase.qnt` / `KeyLifecycle.qnt`: protocol本体とproperty
- `*Models.qnt`: 正常構成とRed構成
- `*Tests.qnt`: 代表的な正常・guard scenario
- `CheckpointDeliveryMbt.qnt` / `WitnessQuorumMbt.qnt`: 実装へ再生する決定的なMBT trace
- `AssetOwnershipModels.qnt`: model checkingに加え、`quint_connect`でMoonBitへ直接再生するrandom trace source
- `ConfigContracts.qnt`: 許可しない定数構成
- `check*.sh`: Quint CLIとCIの接続

## モデル境界

`CheckpointDelivery.qnt`は2 peer、2 epoch、3 event、1 authorityを使う。epoch 1には
別々のpeerが所有する2 event、epoch 2には追加の1 eventがある。

| 実装上の概念 | Quintでの抽象化 |
| --- | --- |
| replica-local event DB | peerごとの単調な`accepted`集合 |
| trusted watermark | epochまでの全期待eventを受信したというseal条件 |
| Merkle checkpoint | epoch、parent digest、認証済みevent集合を持つrecord |
| durable local DB | `durableCheckpoints` |
| at-least-once Queue/outbox | `durableOutbox`、network集合、再送action、容量上限 |
| replica-local peer route lease | crash中の未配送をdurable outbox残留、期限後retryとして縮約 |
| authority checkpoint head | exact-parentなauthority `headLog` |
| process/network障害 | crash/restart、drop、partition/heal action |

Merkle木、hash衝突耐性、署名偽造困難性はモデル化しない。checkpointのevent集合をcanonical
Merkle rootの抽象値として扱い、暗号とtree実装はMoonBit側のtest対象に残す。micro
checkpointも省略し、authorityへ送るmacro sealだけを扱う。

`WitnessQuorum.qnt`はdestination-specificな署名収集を4 roster witness、1 intruder、
3 approval quorumへ縮約する。暗号検証結果を`response.valid`として抽象化し、producer認証、
distinct roster count、deadline expiry、ready collectionからreceiver更新までのgateを扱う。

`AssetOwnership.qnt`は1 asset、3 owner、最大2 transferへ縮約する。署名検証結果はbooleanとして
抽象化し、version 0のorigin headから始まるexact-version transfer、送信者と受信者の二重認証、
active listing中のtransfer禁止、cancel後のtransfer許可、取消済みlisting nonceのreplay拒否を扱う。
origin/transfer versionごとのrevocationとappealも扱い、祖先revoke時はdescendantのactive listingを
quarantineする。appealはclean lineageを再計算するが旧listingを自動復活させず、新nonceなら同じowner
headでも再出品できる。
中間transferはowner versionだけでは裁定対象にせず、originまたは前回の`retainedAnchorVersion`から
current headへ到達する認証済みsliceを`registerLineageSlice`で登録した場合だけ`verifiedAncestors`へ入る。
未登録transferのrevoke、wrong-parent slice、終端不一致は拒否する。
暗号primitive、HTTP decode、SQLite migrationはMoonBit/Workers testの責務に残す。

`LineageAppeal.qnt`は2 ancestor、4 canonical decision ID、3 clock stepへ縮約し、外部certificateの
認証・受理時刻をboolean factとして扱う。per-ancestor revision、decision IDの一意性、
`Finalized -> AppealOpen -> Finalized | Expired`、exact appeal target、deadline、別ancestorのrevokeを
appealで消さないことを検査する。署名bytes、Unix millisecond、arbiter roster parseはWorker/MoonBit側に残す。

`EvidenceLineageCase.qnt`は2 caseと1 assetへ縮約する。active/authenticated/exact-bound holdから
caseを開くactionと、authenticated/exact-bound arbiter certificateでupholdまたはdismissするactionを分ける。
case作成とdismissalはassetを変更せず、decision actionだけが`Eligible -> Revoked`を行う。hold/certificateの
実署名、case reference digest、SQLite CASはWorker/MoonBit側に残す。case close後もplayer-local holdは
未解決のままで、認証済みsourceがexact resolutionをnext cursorへpublishする別actionだけがholdを解決する。

`KeyLifecycle.qnt`は2 key version、5 checkpoint候補、4 clock stepへ縮約する。routine rotationは
旧verification recordを残し、署名時点の有効期間とeffective revocation時刻でadmissionする。
exact key binding、issuance validity、revocation gateを個別に外す3 broken moduleを持つ。
署名bytesとkey history JSON/DBはTypeScript/Workers、同じ純粋admissionはMoonBit/Why3の責務である。

asset settlementのclaim ledgerは次のとおりである。

| claim | source of truth | 検査artifact | status |
| --- | --- | --- | --- |
| transferごとにowner versionが正確に1進む | `AssetOwnership.transfer` | `ownerVersionAdvancesExactlyOnce` + broken-version反例 | verified（有限model） |
| owner変更にはsender/recipient両認証が要る | `AssetOwnership.transfer` | `transferRequiresDualAuthentication` + broken-recipient反例 | verified（有限model） |
| active listing中はownerを変更しない | `AssetOwnership.transfer/list` | `activeListingMatchesCurrentOwnerHead` + broken-listing反例 | verified（有限model） |
| cancel後はtransferと新nonceでの再出品が可能、旧nonceのreplayは不可 | `AssetOwnership.cancel/list` | `transferListCancelTransfer` / `canceledListingCannotReplay` / `canceledOwnerCanRelistWithFreshNonce` | scenario verified |
| 祖先revoke後にdescendant listingをactiveのまま残さない | `AssetOwnership.revokeAncestor` | `activeListingRequiresCleanLineage` + broken-revocation反例 | verified（有限model） |
| 未解決revoke中は新しいdescendant transferを作らない | `AssetOwnership.transfer` | `transferRequiresCleanLineage` + broken-revoked-transfer反例 | verified（有限model） |
| historical transferのrevoke前にexact authenticated sliceを要求する | `AssetOwnership.registerLineageSlice/revokeAncestor` | `registeredSliceRequiresExactBoundary` + broken-lineage-parent反例 + 3 scenario | verified（有限model） |
| appeal後もquarantine済みnonceを自動復活させない | `AssetOwnership.restoreAncestor/list` | `appealRecomputesButDoesNotReactivateListing` / `appealDoesNotPermitQuarantinedNonceReplay` | scenario verified |
| Ed25519、wire binding、永続化migrationが上記抽象に従う | Workers API/SQLite contract | owner-auth unit test + workerd integration test | regression tested（refinement proofではない） |
| lineage decisionは認証済み・期限内・次revisionだけを受理する | `LineageAppeal.revoke/appeal` | 3 invariant + broken authentication/time/revision反例 | verified（有限model） |
| appealはexact revoke targetかつdeadline内だけfinalizeする | `LineageAppeal.appeal/advanceTime` | 2 invariant + broken target/deadline反例 + 2 scenario | verified（有限model） |
| 一つのappealは別ancestorのrevokeを消さず、期限切れは自動restoreしない | ancestor別map + `lineageClean` | independent-revocation/expired scenario | scenario verified |
| caseは認証済みactive holdのexact bindingだけから作る | `EvidenceLineageCase.openCase` | hold invariant + broken authentication/binding反例 | verified（有限model） |
| case作成だけではassetを止めない | `EvidenceLineageCase.openCase/decideCase` | `caseOpeningNeverChangesAsset` + broken auto-mutation反例 | verified（有限model） |
| asset変更はexact caseを指定した認証済みcertificateだけが行う | `EvidenceLineageCase.decideCase` | certificate invariant + broken authentication/binding反例 | verified（有限model） |
| dismissalは認証済みexact caseだけを閉じ、assetを変更しない | `EvidenceLineageCase.dismissCase` | dismissal invariant + broken authentication/binding/mutation反例 | verified（有限model） |
| case closeだけではholdを解決せず、source署名・exact binding・next cursorが必要 | `EvidenceLineageCase.publishSourceResolution` | source resolution invariant + broken authentication/binding/cursor/auto-resolution反例 | verified（有限model） |
| key version substitutionを受理しない | `KeyLifecycle.verify` | exact binding invariant + broken binding反例 | verified（有限model） |
| key validity/revocationは署名時刻へ適用する | `KeyLifecycle.verify` | 2 invariant + broken validity/revocation反例 | verified（有限model） |
| routine rotation後も旧公開鍵historyで過去checkpointを検証できる | `KeyLifecycle.rotate/verify` | rotation/revocation scenario + history deletion negative control | scenario verified |

## 検査する性質

正常moduleは次の安全性を全到達状態で検査する。

- seal済みcheckpointは当該epochの全eventを含む。
- 同epochをsealした正直なpeerは同じdigestへ収束する。
- peerとauthorityのheadはgenesisから連続するexact-parent chainである。
- eventとseal済みcheckpointはcrashで消失しない。
- authorityはpeerが生成していないcheckpointを受理しない。
- 未ACK outboxが容量上限に達したpeerは次のcheckpointをsealしない。
- witness collectionは有効producer署名とdistinct roster quorumなしにreadyにならない。
- receiverはready collectionなしに進まず、expiryはinvalid判定にもreceiver更新にもならない。
- versioned keyで受理したcheckpointはexact key binding、有効な署名時刻、effective revocation前を満たす。
- asset owner versionはtransferごとに正確に1進む。
- asset transferは送信者と受信者の両方が認証されなければ成立しない。
- asset transferは未解決の祖先revocationがない場合だけ成立する。
- active listingは常に現在のowner headと一致し、出品中のowner変更を許さない。
- `lineageClean`は未解決revocation集合が空であることと一致する。
- active listingはclean lineageでのみ存在し、祖先revoke時はquarantineされる。
- verified historical ancestorはretention anchorを越えず、登録sliceは認証・親・終端の全境界に一致する。
- lineage decisionは認証済み・期限内・次revisionであり、appealはexact targetかつdeadline内である。
- expired lineage caseはrevokedのまま残り、別ancestorのappealで解消されない。
- evidence case作成だけではasset状態を変更せず、認証済みexact-bound certificateだけが決着できる。

checkpoint配送のlivenessは次の条件付き性質である。

```text
eventually always(unpartitioned and all nodes up)
  => eventually(authority head = latest epoch)
```

これは無条件の配送保証ではない。gossip、配送、seal、restart、heal、最古の未ACK checkpoint
再送が、繰り返し可能なら永久には飢餓しないというfairnessを置く。witness収集も、未採用の
正直なapprovalの送信と配送がfairならeventually readyになる、という条件付きである。

## Red module

`quint-counterexamples`はload-bearingな制約を一つずつ外した各moduleが、構文errorではなく
期待したmodel counterexampleを出すことを確認する。

| 外す制約 | Quint/TLCが示す反例 |
| --- | --- |
| watermark完備後だけseal | epoch 1から相手peerのeventを欠落できる |
| durable outbox | seal直後のcrashで未送信checkpointを失う |
| authorityのexact-parent | epochを飛び越したheadを受理できる |
| packet loss後のretry | 一度dropしたcheckpointが再送されずfinalizeしない |
| outbox capacity gate | 未ACK checkpointを容量より多くsealできる |
| producer署名gate | producer署名が不正でも3 approvalでreadyになる |
| witness roster gate | intruderをapproval countへ入れられる |
| transferのrecipient署名gate | recipient未承認でもownerを変更できる |
| owner exact-version gate | transfer回数とowner versionが乖離する |
| active listing中のtransfer gate | 出品中にownerが変わりlisting headが陳腐化する |
| ancestor revoke時のquarantine | 祖先が無効でもdescendant listingがactiveのまま残る |
| revoked lineageのtransfer gate | 無効な祖先から新しいowner headを派生できる |
| lineage certificate認証/time/revision gate | 未認証・期限外・stale decisionをheadへ反映できる |
| appeal target/deadline gate | 別revokeまたは期限切れcaseをeligibleへ戻せる |
| evidence hold authentication/binding gate | 未認証holdまたは別assetへretargetしたholdからcaseを作れる |
| case open時の非変更境界 | arbiter判断なしにassetをrevokeできる |
| case certificate authentication/binding gate | 未認証certificateまたは別caseのcertificateでassetを変更できる |
| dismissal authentication/binding/non-mutation gate | 未認証・別caseの棄却、または棄却だけでasset revokeが可能になる |
| source resolution authentication/binding/cursor/non-automatic gate | case closeだけでholdが消える、または未認証・別resolution・stale cursorでholdを解決できる |

## 実行結果

2026-08-05、Quint 0.32.0、TLC 2.19で確認した。

| 構成 | generated states | distinct states | depth |
| --- | ---: | ---: | ---: |
| checkpoint safety | 55,849 | 11,340 | 24 |
| checkpoint liveness | 55,849 | 11,340 | 24 |
| witness safety | 336,897 | 30,720 | 18 |
| witness liveness | 212,993 | 19,456 | 18 |

設定済みの全正常構成は反例なし、全Red構成は期待した反例を出した。これは有限model checkingの
結果であり、任意peer数・任意epoch数・任意roster数の数学的証明やproduction transport
実装の検証を意味しない。authority process/storageのcrash recoveryも現在の範囲外である。

加えて、正常到達性とguardを示す設定済みの全`run` scenarioが通過し、capacity 0、quorum 0、
rosterを超えるquorumの3構成を設定契約違反として拒否する。
lineage appeal正常modelは反例なし、authentication、certificate time、revision、appeal target、deadlineの
5 Red構成はそれぞれ対応invariantの反例を出し、6 scenarioが通過した。
2026-08-10にevidence lineage case正常modelも反例なし、hold authentication/binding、open時auto-mutation、
uphold certificate authentication/binding、dismissal authentication/binding/auto-mutation、source resolution
authentication/binding/cursor/auto-resolutionの12 Red構成は対応invariantの反例を出し、12 scenarioが通過した。

## Model-based testing

`CheckpointDeliveryMbt.qnt`はprotocol本体のactionだけを使い、次の代表traceをITF JSONへ出力する。

```text
event gossip/delivery -> epoch 1 seal -> crash/restart
  -> authority ACK -> epoch 2 seal -> authority ACK
```

outbox capacityは1である。したがって、epoch 1のACKが配送容量を解放しなければepoch 2をseal
できない。Node側replayerは各stateをMoonBitのcheckpoint policyとplayer-local SQLite adapterへ
順番に適用し、accepted event、checkpoint chain、未ACK durable outbox、authority headの射影を
毎step比較する。

このtestにより、Quintと実装で「容量は未ACK entryを数え、acknowledged tombstoneは証跡として
残しても容量を消費しない」という意味を固定する。任意traceのrefinement proofではなく、crash、
再送、ACK、容量再利用を横断する決定的なconformance testである。

`WitnessQuorumMbt.qnt`は、有効なintruder応答、不正なroster witness署名、W1/W2/W3の正直な
distinct approval、receiver advanceを12 stateで通過する。replayerは抽象的な`valid`を実Ed25519
署名へ具体化し、MoonBitの汎用delivery authentication gateが順に`unknown_witness`、
`invalid_witness_signature`、`under_quorum`、3承認成功を返すことを比較する。

witness MBTは認証gateの射影であり、network soup自体やcollection SQLite、deadline、rate limitを
実装へ再生するものではない。それらはWorkers integration testの責務として分離する。

asset ownershipには
[`mizchi/quint_connect`](https://github.com/mizchi/quint-connect-moonbit)を使う。
native MoonBit runnerが`AssetOwnershipModels.qnt`へ`quint run --mbt`を実行し、名前空間付きstate、
`#bigint`、`#set`、nondeterministic pickをdecodeする。`quint_asset_driver`は各actionを
`asset_lineage_use_allowed`、`asset_lineage_decision_allowed`、
`transfer_transition_allowed`へ接続し、全stateのowner/listing/revocation射影を比較する。

固定ITF unit testはactive listingの祖先revokeを含み、健全driverの一致と、quarantineを省いた
破損driverの`StateDiverged`を確認する。CLI integrationはseed `0xa55e7`で32 trace、288 stateを
照合し、同じtrace群で破損driverが失敗することも確認する。これはMoonBitのpure policyと
adapter state machineのconformance testであり、Cloudflare Worker、D1 transaction、HTTP decodeの
refinement proofではない。それらはworkerd integration testで別に検査する。

## Apalache smoke

Quint既定のApalache backendは、witness safety最大5 stepsで反例なし、producer署名gateを
外した最大8 stepsで期待した反例を出した。一方、最大18 stepsは約2分間完了せず中断し、
終了時にZ3 `UNKNOWN`となった。短いbounded smokeには使うが、完全有限探索やlivenessの
代替とはしない。

## 実行

```sh
just formal-check

# 個別実行
just quint-config-contracts
just quint-scenarios
just quint-mbt
just quint-witness-mbt
just quint-connect-mbt
just quint-check
just quint-counterexamples
just quint-apalache-smoke
just quint-docs
```

`quint-check`はtypecheck後、設定済みの全正常構成をTLC backendと名前付きinvariantで検査する。
`quint-scenarios`は設定済みの全実行可能traceを検査する。`quint-config-contracts`は無効な
定数構成を拒否する。
`quint-mbt`はcheckpoint ITF traceをMoonBit policy + Node SQLiteへ再生し、
`quint-witness-mbt`はwitness ITF traceを実暗号MoonBit認証gateへ再生する。
`quint-connect-mbt`は公開`mizchi/quint_connect` packageでasset ownershipのrandom ITF traceを
MoonBit policyへ再生し、正例と破損driverの負例を検査する。
`quint-counterexamples`は設定済みの全Red構成を検査する。`quint-apalache-smoke`はbounded checkで、
authoritativeな`formal-check`には含めない。

## 移行記録

2026-08-05に旧TLA+ sourceからQuintへ移植した際、正常4構成のgenerated states、distinct
states、depthがすべて一致し、Red 7構成も同じ反例分類になった。二重管理を避ける方針により、
手書き`.tla`/`.cfg`とTLA+専用recipeは削除した。QuintがTLC実行時に生成するTLA+は一時artifactで
あり、sourceとして管理しない。
