# 中央台帳とarchiveの世代終了

中央の開始権・稼働中戦闘台帳を世代ごとに閉じ、次の世代で継続できるようにした。
1,024戦を確定したあとに世代を終了し、1,025戦目のプレイ、inventory集約、最初のアイテムの市場受理まで実行して検査する。
端末の[16件の未集約レシート上限](./encounter-inventory-checkpoint-ja.md)は維持する。

この変更が制限するのは、稼働中の開始権・戦闘台帳とarchiveの登録枠である。
旧世代のticket・確定レシート・終了証明は別表へ移し、市場や中断復旧から参照する。
後続の[復旧情報の片付け](./encounter-recovery-release-ja.md)では、所有者が解放した中断戦闘だけを削除対象にした。
以下の全出所移管と測定は、その追加前の段階を記録する。精算済みレシートを残す方針は同じである。
その表とinventory索引、解決済みcaseなどの総保存量は累積戦闘数に応じて増える。
中央の全データを一定容量にする実装ではない。

## 終了条件と再利用防止

1. 管理者が終了対象の`expectedGeneration`を指定する。
2. その世代に割り当てた開始権がすべて発行済みであることを確認する。
3. 全戦闘が確定または中断終了し、保持終了が確定済みで、手動holdも未解決caseもないことを確認する。
4. その世代のarchiveにraw資料が残っていないことを確認する。通常の署名付き`archive-release`が先に必要である。
5. 出所のdigestと次の世代番号へ署名する。
6. 同じSQLite transactionで出所を移し、開始権・稼働台帳・archive tombstoneを削除し、世代とarchive下限を進める。

未発行の開始権や保持中の資料が一つでもあれば拒否する。経過時間や容量不足だけでは世代を終了しない。
署名の途中に台帳や開始権が変わった場合も、transaction内で全条件とticket ID・revisionを再確認して拒否する。
DOは既存の`storage.sync()`を経由してから応答する。

開始権の識別子は`(unit, generation, startHead)`になる。
世代番号がない従来の認可・ticket・開始要求は、常に世代0として扱う。
新しい世代では、管理者がその世代を明示して新しい開始権を発行する。
同じ`startHead`を使っても、異なる世代の別の認可であり、queue IDとticket署名のframeも異なる。
世代0の開始権を現在の世代へ自動的に付け替えない。

古い世代の開始要求を再送した場合、同じ所有者の既存の終了済みticketがあればそれを返す。
新しいticketや報酬は発行しない。これは、開始時の応答を失った端末が終了状態を復旧するための読み取りである。
存在しない古い開始権や別所有者のticketは拒否する。
発行処理自身も非同期の署名後に現在の世代を再確認し、古い世代のticketを後から挿入できない。

## 保存先と上限

| 領域 | 扱い |
| --- | --- |
| 現世代の開始権 | 最大1,024件。所有者署名では増やせず、管理者による割り当てが必要 |
| `encounter_tickets_v1` | 現世代の戦闘。世代終了時に別表へ移す |
| `encounter_origins_v1` | 旧世代のticket、commitment、レシートまたは終了証明、保持終了・市場受理状態を保持 |
| authority-privateなseedとreveal | 旧世代の出所表へは保持しない。後から新たなrevealを生成する操作も拒否 |
| 世代metadata | unitごとに現在の世代と直前の署名済み終了証明を一つ保持 |
| archive登録枠 | 初期値128件・raw payload 1 MiB。登録枠は保持終了済みの世代を閉じたときだけ再利用 |
| archive下限 | unitごとに最低世代を保持。削除済みの古い資料を再登録できない |
| inventory | 旧世代の出所も同じページ付き索引から参照。累計件数はJS safe integer以内 |

旧世代の出所表には元の署名が残り、レシートを再発行しない。
新しいseedを生成したりゲームを再生したりせずに、元のitemと現在の市場受理状態を参照する。
終了済み戦闘へのpruneや中断終了証明の復旧も、元のqueue/rootと証明を使って続けられる。
archiveの再取得は世代終了後に404となり、削除済みcustodyに対する操作は再発行しない。
世代を閉じるまでの同じarchive証明・解放証明の再送は従来どおり扱う。

同じ世代終了要求の再送は、直後の世代であれば保存済みの同じ終了証明を返す。
現世代で新たなプレイが始まっていても、再送によってその台帳を消さない。
さらに次の世代まで進んだあとに届く古い終了要求は拒否する。
世代番号はJS safe integerの上限で停止し、wraparoundや番号の再利用をしない。

## archiveとの原子性

現在の世代終了は、中央とarchiveが同じ`EncounterSql`を共有する場合に有効である。
`sharesGenerationStorage`で同じstorageを使用していることを確認する。
実Workerは同じDO SQLiteと`transactionSync`を使い、Node検査は同じDBの`BEGIN`/`COMMIT`を使う。
別DBのarchiveを中央のtransactionで削除しようとした場合は拒否する。
独立archiveとの二段階の世代移管は未実装である。

payloadの削除は従来の保持終了条件で行い、世代終了が消すarchive行は解放済みtombstoneだけである。
削除と同時に下限を進め、保存処理のtransaction内でも下限を再確認する。
古いuploadが暗号処理を待っている間に世代が終わっても、そのuploadが登録枠を復活させることはない。
下限と中央世代が一致しない場合や、出所があるのに世代metadataを失った場合も、0へ戻さず拒否する。
復旧情報の片付けを導入した現実装では、archiveがなく全出所を削除した場合にもunitごとの下限を別表に保持する。

## 管理APIと移行

管理者認証付き`POST /v1/pve/{unit}/encounter-generation`へ次を送る。

```json
{ "expectedGeneration": 0 }
```

成功応答は最大2 KiBの署名付き終了証明で、unit・authority・終了世代・次世代・前証明ID・
出所digest・戦闘数・レシート数・終了時刻を束縛する。
出所digestは順序付きのticket ID、開始権digest、元ticket署名、レシートID、終了証明IDをcommitする。
変更できる市場受理状態やprivateなseedはdigestへ入れない。
この証明だけで全出所のMerkle inclusionを検証する仕組みは提供しない。
一覧から取得した元ticketと元レシートの署名を検証する。

`encounter-configuration`は現在の`generation`も返す。
新世代の`encounter-admissions`には`generation`を指定し、一覧から得た認可を端末がそのまま使用する。
ローカル用の割り当てhelperは最後の引数で世代を指定できる。

```sh
pnpm --dir examples/cf-game-audit dev:assign-start PUBLIC_KEY demo earned-next alice 1
```

従来の開始権表は世代0として新しい複合キーの表へ移す。
世代終了時には旧表の対象unit分も削除し、再起動時に古い認可を復活させない。
archiveの従来行にも世代0を割り当てる。元ticketの署名frameとqueue IDは互換のまま扱う。
世代対応DBをtransactionなしの旧adapter設定で開こうとした場合は拒否する。
旧形式と新形式のサーバーを同じDBへ同時に書き込ませる運用は対応しない。

## 計算量とローカル測定

稼働戦闘数を`k ≤ 1,024`、archive tombstoneを`a ≤ 128`、旧出所数を`N`とする。
世代終了は稼働台帳だけを読み、元のゲームを再生しない。出所digestのhash入力は`O(k)`、署名は1回である。
出所の索引挿入・稼働行の削除・順序付けに`O(k log(N+k) + k log k + a)`、
加えて上限付きのcase照会がかかる。過去の全世代を走査しない。
ただし、移管先の索引が大きくなる費用を含めて定数時間であるとは主張しない。

[測定JSON](../examples/cf-game-audit/benchmarks/encounter-generation-local-2026-10-18.json)は、
実際に確定・保持終了した1,024戦を元に、各サイズを20回・warmup 3回測定した。
各サンプル開始時の旧出所は0件で、解放済みarchiveを最大128件含む。
実Ed25519とインメモリSQLiteによる管理APIの処理を測り、通信・fsync・Worker schedulingは含まない。
case未登録の状態であり、大きな出所索引やcase履歴、本番CPU予算・応答時間を測定したものではない。

| 世代の戦闘数 | p50 | p95 | 終了証明 | 残る出所JSON |
| --- | --- | --- | --- | --- |
| 16 | 0.648 ms | 1.020 ms | 540 bytes | 37,765 bytes |
| 128 | 3.778 ms | 4.999 ms | 542 bytes | 302,917 bytes |
| 1,024 | 44.414 ms | 52.446 ms | 544 bytes | 2,429,876 bytes |

1,024件を閉じる処理は1回に約52 msのCPU時間を使うサンプルがあった。
archiveを毎戦使う運用なら、開始権を128件以下の単位で割り当て、閉じられる時点で世代を終了する方法が考えられる。
上限まで1,024件を埋める必要はない。実際の切替頻度は保持・caseの解決と利用するDB環境で決まる。
JSON量だけでも1,024戦で約2.43 MBが残るため、世代番号だけで総保存量が一定になるわけではない。
これらのbyte数はSQLiteのページ・索引・WALやケースの物理容量を含まない。

## 証明と検査

[`Generations.lean`](../formal/lean/ConvergeAudit/Generations.lean)の27定理と
[`Tests/Generations.lean`](../formal/lean/Tests/Generations.lean)の20例を追加した。

- 世代が履歴全体で単調に増え、古い開始権を任意の将来世代でも発行できない。
- 同一世代でも同じ開始権を二重発行できない。
- source・保留状態・市場判定を保持して、secretだけを除去する。
- 生きたcase、未解放archive、未消費の開始権があれば世代を閉じない。
- 稼働台帳1,024件とarchive 128件の上限を保存する。
- 削除済みarchiveを下限より古い世代から再登録できない。
- 再送は現世代の作業を変えない。

spent headだけを消して世代を進めない壊れたモデルでは、同じ認可を再発行できる例も固定した。
既存`InventoryCompaction.lean`の累計上限は、1世代分の1,024件からJS safe integerへ一般化した。
inventory全体を定数容量にした証明ではない。

MoonBit側には4条件を確認する`encounter_generation_roll_allowed`とpostcondition・5補題を追加した。
実装はworker exportを遅延ロードして使い、JSの世代番号をMoonBitの32-bit `Int`へ狭めない。
SQLite上の集計・世代比較をboolへ変換し、transaction内で再度同じguardを評価する。

モデルは、元ticketとレシートの認証、既存の保持終了・全case集計、hostの永続metadataを仮定する。
暗号の偽造困難性や衝突困難性、SQLite/IndexedDB/WebCryptoのrefinementや物理永続化自体は証明しない。
Quintは既存protocolの回帰検査であり、世代終了専用の分散モデルは追加していない。

Nodeでは実1,025戦、世代を跨ぐIndexedDB復旧、応答消失時と同じ再送、rollback、移行、
metadata喪失、署名改竄、別DBの拒否、署名待ちの発行・uploadと世代終了の競合を検査する。
実Workerでは管理者route、二世代の終了、archive枠の再利用、DO eviction後の出所とinventoryを確認する。
実Chromiumでは通常のcleanup後に世代を閉じ、同じ端末で次世代をプレイして再読込する。

```sh
just test-encounter-generation
just bench-encounter-generation
just prove-lean
just prove
just formal-check
```

## 残る保存量と運用

旧世代の出所、inventory索引、case履歴は現時点で累積戦闘数に比例して残る。
外部cold storageへの移管、非保有資産や報酬なしの戦闘をさらに圧縮する条件、
ownerごとの認証mapによる出所開示、ケース・受理履歴の保持範囲は次の設計対象となる。
世代の自動終了schedulerと管理画面もまだない。保持が閉じない世代を自動的に押し出さない。
未解決caseや未消費の開始権が一つでも残ると、そのunitの世代終了を待つ。
並行世代の受付や保留戦闘の繰越は未対応であり、この条件を満たすまで稼働枠が空かない場合は新規受付を止める。
