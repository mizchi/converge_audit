# Checkpoint delivery / witness quorum / asset ownership Quint model

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

- `CheckpointDelivery.qnt` / `WitnessQuorum.qnt` / `AssetOwnership.qnt`: protocol本体とproperty
- `*Models.qnt`: 正常構成とRed構成
- `*Tests.qnt`: 代表的な正常・guard scenario
- `CheckpointDeliveryMbt.qnt` / `WitnessQuorumMbt.qnt`: 実装へ再生する決定的なMBT trace
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
新nonceなら同じowner headでも再出品できる。
暗号primitive、HTTP decode、SQLite migrationはMoonBit/Workers testの責務に残す。

asset settlementのclaim ledgerは次のとおりである。

| claim | source of truth | 検査artifact | status |
| --- | --- | --- | --- |
| transferごとにowner versionが正確に1進む | `AssetOwnership.transfer` | `ownerVersionAdvancesExactlyOnce` + broken-version反例 | verified（有限model） |
| owner変更にはsender/recipient両認証が要る | `AssetOwnership.transfer` | `transferRequiresDualAuthentication` + broken-recipient反例 | verified（有限model） |
| active listing中はownerを変更しない | `AssetOwnership.transfer/list` | `activeListingMatchesCurrentOwnerHead` + broken-listing反例 | verified（有限model） |
| cancel後はtransferと新nonceでの再出品が可能、旧nonceのreplayは不可 | `AssetOwnership.cancel/list` | `transferListCancelTransfer` / `canceledListingCannotReplay` / `canceledOwnerCanRelistWithFreshNonce` | scenario verified |
| Ed25519、wire binding、永続化migrationが上記抽象に従う | Workers API/SQLite contract | owner-auth unit test + workerd integration test | regression tested（refinement proofではない） |

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
- asset owner versionはtransferごとに正確に1進む。
- asset transferは送信者と受信者の両方が認証されなければ成立しない。
- active listingは常に現在のowner headと一致し、出品中のowner変更を許さない。

checkpoint配送のlivenessは次の条件付き性質である。

```text
eventually always(unpartitioned and all nodes up)
  => eventually(authority head = latest epoch)
```

これは無条件の配送保証ではない。gossip、配送、seal、restart、heal、最古の未ACK checkpoint
再送が、繰り返し可能なら永久には飢餓しないというfairnessを置く。witness収集も、未採用の
正直なapprovalの送信と配送がfairならeventually readyになる、という条件付きである。

## Red module

`quint-counterexamples`はload-bearingな制約を一つずつ外した10 moduleが、構文errorではなく
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

## 実行結果

2026-08-05、Quint 0.32.0、TLC 2.19で確認した。

| 構成 | generated states | distinct states | depth |
| --- | ---: | ---: | ---: |
| checkpoint safety | 55,849 | 11,340 | 24 |
| checkpoint liveness | 55,849 | 11,340 | 24 |
| witness safety | 336,897 | 30,720 | 18 |
| witness liveness | 212,993 | 19,456 | 18 |

正常5構成は反例なし、Red 10構成はすべて期待した反例を出した。これは有限model checkingの
結果であり、任意peer数・任意epoch数・任意roster数の数学的証明やproduction transport
実装の検証を意味しない。authority process/storageのcrash recoveryも現在の範囲外である。

加えて、正常到達性とguardを示す11件の`run` scenarioが通過し、capacity 0、quorum 0、
rosterを超えるquorumの3構成を設定契約違反として拒否する。

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
just quint-check
just quint-counterexamples
just quint-apalache-smoke
just quint-docs
```

`quint-check`はtypecheck後、正常5構成をTLC backendと名前付きinvariantで検査する。
`quint-scenarios`は11件の実行可能な代表traceを検査する。`quint-config-contracts`は無効な
定数構成3件を拒否する。
`quint-mbt`はcheckpoint ITF traceをMoonBit policy + Node SQLiteへ再生し、
`quint-witness-mbt`はwitness ITF traceを実暗号MoonBit認証gateへ再生する。
`quint-counterexamples`はRed 10構成を検査する。`quint-apalache-smoke`はbounded checkで、
authoritativeな`formal-check`には含めない。

## 移行記録

2026-08-05に旧TLA+ sourceからQuintへ移植した際、正常4構成のgenerated states、distinct
states、depthがすべて一致し、Red 7構成も同じ反例分類になった。二重管理を避ける方針により、
手書き`.tla`/`.cfg`とTLA+専用recipeは削除した。QuintがTLC実行時に生成するTLA+は一時artifactで
あり、sourceとして管理しない。
