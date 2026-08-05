# Checkpoint delivery / witness quorum Quint model

このディレクトリは、ゲーム固有の戦闘規則ではなく、local-firstな監査ログをpeerから
権威サーバーへ確定させる時間的protocolのsource of truthである。

MoonBit/Why3が純粋な受理predicateを担当し、Quint/TLCは配送順、再送、crash、packet loss、
partitionをまたぐ状態遷移を担当する。実adapterが満たすtransaction/API契約は
[persistence / transport実装契約](../../docs/game-audit-implementation-contract-ja.md)に定める。

QuintはTLAの意味論を持つtyped specification languageである。完全な有限状態探索と
fairness付きlivenessには`quint verify --backend=tlc`を使う。既定のApalache backendは
bounded/inductive safetyへ選択的に使い、TLCのliveness gateとは区別する。

- [Quint repository](https://github.com/quint-co/quint)
- [Quint: Model Checkers](https://quint.sh/docs/model-checkers)
- [Quint: Checking Properties](https://quint.sh/docs/checking-properties)

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

checkpoint配送のlivenessは次の条件付き性質である。

```text
eventually always(unpartitioned and all nodes up)
  => eventually(authority head = latest epoch)
```

これは無条件の配送保証ではない。gossip、配送、seal、restart、heal、最古の未ACK checkpoint
再送が、繰り返し可能なら永久には飢餓しないというfairnessを置く。witness収集も、未採用の
正直なapprovalの送信と配送がfairならeventually readyになる、という条件付きである。

## Red module

`quint-counterexamples`はload-bearingな制約を一つずつ外した7 moduleが、構文errorではなく
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

## 実行結果

2026-08-05、Quint 0.32.0、TLC 2.19で確認した。

| 構成 | generated states | distinct states | depth |
| --- | ---: | ---: | ---: |
| checkpoint safety | 55,849 | 11,340 | 24 |
| checkpoint liveness | 55,849 | 11,340 | 24 |
| witness safety | 336,897 | 30,720 | 18 |
| witness liveness | 212,993 | 19,456 | 18 |

正常4構成は反例なし、Red 7構成はすべて期待した反例を出した。これは有限model checkingの
結果であり、任意peer数・任意epoch数・任意roster数の数学的証明やproduction transport
実装の検証を意味しない。authority process/storageのcrash recoveryも現在の範囲外である。

## Apalache smoke

Quint既定のApalache backendは、witness safety最大5 stepsで反例なし、producer署名gateを
外した最大8 stepsで期待した反例を出した。一方、最大18 stepsは約2分間完了せず中断し、
終了時にZ3 `UNKNOWN`となった。短いbounded smokeには使うが、完全有限探索やlivenessの
代替とはしない。

## 実行

```sh
just formal-check

# 個別実行
just quint-check
just quint-counterexamples
just quint-apalache-smoke
```

`quint-check`はtypecheck後、正常4構成をTLC backendで検査する。
`quint-counterexamples`はRed 7構成を検査する。`quint-apalache-smoke`はbounded checkで、
authoritativeな`formal-check`には含めない。

## 移行記録

2026-08-05に旧TLA+ sourceからQuintへ移植した際、正常4構成のgenerated states、distinct
states、depthがすべて一致し、Red 7構成も同じ反例分類になった。二重管理を避ける方針により、
手書き`.tla`/`.cfg`とTLA+専用recipeは削除した。QuintがTLC実行時に生成するTLA+は一時artifactで
あり、sourceとして管理しない。
