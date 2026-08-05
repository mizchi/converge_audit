# Quintモデルの読み方と変更手順

このガイドは、モデルが何を保証するかを説明する`README.md`とは分けて、Quintコードを
どの順番で読み、どのように安全に変更するかを説明する。

## ファイル構成

| ファイル | 役割 |
| --- | --- |
| `CheckpointDelivery.qnt` | checkpoint配送protocolの型、状態、action、property |
| `CheckpointDeliveryModels.qnt` | 正常構成とload-bearingな制約を外したRed構成 |
| `CheckpointDeliveryTests.qnt` | 正常確定、crash recovery、backpressureの実行可能scenario |
| `CheckpointDeliveryMbt.qnt` | MoonBit + SQLiteへ再生する決定的なITF trace driver |
| `WitnessQuorum.qnt` | witness quorumの型、状態、action、property |
| `WitnessQuorumModels.qnt` | safety/liveness構成とproducer/rosterのRed構成 |
| `WitnessQuorumTests.qnt` | quorum、intruder、expiryの実行可能scenario |
| `WitnessQuorumMbt.qnt` | 実Ed25519 MoonBit認証gateへ再生する決定的なITF trace driver |
| `ConfigContracts.qnt` | 許可しない定数構成 |
| `check*.sh` | scenario、正常検証、Red反例、設定契約をCIへ接続するscript |

## 読む順番

1. sum typeとrecordから有限モデルの境界を確認する。
2. `State`でdurable state、volatile state、network、authority stateを区別する。
3. 引数を取るactionで個別のprotocol操作とguardを読む。
4. `sendSome*`、`deliverSome*`などのwrapperと`step`で非決定性を読む。
5. 個別の`val` invariantで禁止状態を確認する。
6. `fairness`と`temporal` propertyで条件付き進行保証を確認する。
7. `*Models.qnt`で正常構成とRed構成の差分を確認する。
8. `*Tests.qnt`を、期待する代表traceの実行可能ドキュメントとして読む。
9. `CheckpointDeliveryMbt.qnt`とNode replayerで、選んだtraceの実装射影を確認する。

## Quintの定義種別

| 種別 | このモデルでの用途 |
| --- | --- |
| `pure val` / `pure def` | stateを読まない有限集合、変換、設定契約 |
| `val` / `def` | 現在のstateから導出する値とinvariant |
| `action` | 現在stateから次stateへの関係 |
| `run` | actionを順番に実行する代表scenario |
| `temporal` | fairnessを前提にしたliveness |

`state' = value`は命令的代入ではなく、次stateが満たす関係である。同じ`all`内の右辺は
すべて現在stateを読む。順番に更新する場合はscenarioと同じく`.then(...)`でactionを
合成する。

## parameterized actionとnondet wrapper

`sendEvent(peer, receiver, event)`のようなactionは、scenarioから具体的な引数で呼び出せる。
一方、model checkerの`step`はあらゆる引数を探索する必要があるため、`sendSomeEvent`が
`oneOf()`で引数を選んでから呼び出す。

`sendSomeOldestCheckpoint`と`deliverSomeHonestResponse`は`step`の直接branchではない。
それぞれ`sendSomeCheckpoint`と`deliverSomeResponse`の意味的な部分関係であり、進行させたい
対象をfairnessで正確に指定するために存在する。

## fairnessの判断

| 分類 | action | 理由 |
| --- | --- | --- |
| strong | gossip、network delivery、oldest retry | partition等で有効・無効を繰り返しても永久に飢餓させない |
| weak | seal、restart、heal、receiver advance | 連続して有効なら実行する。断続的な有効化までは保証しない |

fairnessはproductionのscheduler実装そのものではない。「配送可能な状態が十分に戻る」という
環境仮定である。新しいfairnessを追加するときは、対応する実装上のretry、queue、deadline
契約を同時に説明する。

## 設定契約

`assume`は定数に対する宣言的な契約である。ただし、このrepositoryで使うQuint 0.32.0の
import/flatten/TLC経路では`assume`だけでは無効構成がTLCの検査対象にならなかった。このため
同じ条件を`configIsValid`として公開し、正常検証では名前付きinvariant、無効構成では
`check-config-contracts.sh`の拒否対象として明示的に検査する。

## propertyを追加するとき

探索、Red、Green、Refactoringの順に進める。

1. 許可・禁止・eventually・reachableのどれを主張するか文章で決める。
2. safetyなら名前付き`val`、livenessなら`temporal`として追加する。
3. 正常到達性を示す`run`、または制約を外したRed moduleを先に追加する。
4. `check.sh`の`--invariants`へ名前を追加する。
5. Redが意図した反例または失敗理由であることを確認する。
6. Green後に`just formal-check`で正常、scenario、設定拒否、Red反例をまとめて確認する。
7. storage/transport上の意味が変わる場合はMBT traceかreplayerの射影を追加する。
8. model boundaryやdomain上の意味が変わる場合は`README.md`も更新する。

## 実行

```sh
just quint-scenarios
just quint-config-contracts
just quint-mbt
just quint-witness-mbt
just quint-check
just quint-counterexamples
just formal-check

# docstringからAPI/property referenceを表示
just quint-docs
```

`.fail()`はactionが無効であることを検査するrun operatorであり、成功しても次stateを作らない。
そのため、状態に対する`.expect(...)`は`.fail()`より前に置く。
