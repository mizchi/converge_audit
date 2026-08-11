# 署名鍵ライフサイクルと過去checkpoint検証契約

更新日: 2026-08-10

## 結論

routine rotation後も、authorityは署名時点で有効だった公開鍵recordを`key_id`と
`key_version`で引き、過去checkpointを検証する。検証時点で旧鍵のcryptoperiodが終了していても、
それだけでは過去署名を無効化しない。revocationは`revoked_at_ms`を有効境界として扱い、
`issued_at_ms >= revoked_at_ms`の署名を拒否する。侵害発覚時は`revoked_at_ms`を過去へ設定できるため、
影響範囲が不明なら鍵の開始時刻まで戻し、その期間のcheckpointを再監査する。

この契約は鍵選択とadmissionを実装・形式化したものである。標準WebCryptoのSHA-256/Ed25519
非同期backend、non-extractable browser signer、IndexedDB `CryptoKey` handle保存に加え、
Workerのcheckpoint配送認証は標準WebCryptoと既存MoonBit verifierの二重検証へ接続済みである。
reference gameのitem精算・transfer・listing・cancelのowner proofも同じ二重検証へ接続済みだが、
reference checkpoint/journalもsealed保存とWorker受理時に標準WebCryptoとの一致を要求する。reference固有の
authority receipt、ownership head、transfer/listing ID、checkpoint receiptも永続化または応答前に両backendの
一致を要求する。open-world lineage proofの保存IDとlineage decision/evidence dismissal certificateも両backendの
一致を要求し、evidence-source proposal/resolution envelopeもmessage/reference/case digestとsource署名を二重検証する。
open-world lineage bundle内部もowner-key bindingとsender/recipient transfer署名を二重検証する。embedded
compact listingとmulti-asset checkpointもauthority checkpointおよび全replay-witness attestationを
状態変更前に二重検証し、origin receipt/initial root、authenticated-map membership/public state root、
lineage transition root、replay-witness session manifestも標準SHA-256で独立再計算する。event/asset-delta
rootの意味論はcompact bundleから中央再計算せず、認証済み`n-f` replay witnessへ委譲する。また同期生成側には
`experimental_crypto`が残る。従ってend-to-endのproduction暗号を接続したという
主張ではなく、production profileのWorkerはfail-closedになる。

## 1. 汎用契約とgame固有policyの境界

汎用部分は次である。

- `key_id`、単調な`key_version`、subject、purpose、scope、scheme、公開鍵を持つ鍵record
- `[valid_from_ms, valid_until_ms)`の署名可能期間と、任意の`revoked_at_ms`
- exact key bindingを署名対象に含むcanonical statement
- provisioning時の履歴検証・index化と、検証hot pathのexact lookup
- 署名時刻でvalidity/revocationを評価するfail-closed admission

game/deploymentごとに決める部分は、subjectを誰へ割り当てるか、world/session scope、各purpose、
cryptoperiod、rotation間隔、revocation判断、過去公開鍵の保持期間、再監査範囲である。

実装の配置は次のとおりである。

| artifact | 責務 |
| --- | --- |
| `src/audit/key_lifecycle` | MoonBitの純粋admission classifierとWhy3 lemma |
| `examples/player-local-runtime/key-lifecycle.ts` | storage/crypto非依存のwire型、canonical statement、履歴compile、署名・検証reference |
| `examples/player-local-runtime/crypto-backend.ts` | 非同期backend contract、標準WebCrypto adapter、production admission gate |
| `formal/quint/KeyLifecycle.qnt` | rotation、履歴保持、effective revocation、admissionの有限状態機械 |
| `examples/cf-game-audit/test/key-lifecycle.test.ts` | 実Ed25519 adapterでのcheckpoint digest bindingとcustody境界test |

## 2. wire contract v1

公開鍵recordのJSON表現は次である。時刻はUnix millisecondsの非負safe integer、
`valid_until_ms`はexclusiveである。

```json
{
  "version": 1,
  "key_id": "checkpoint-producer",
  "key_version": 2,
  "subject_id": "player-1",
  "purpose": "checkpoint-producer",
  "scope_id": "world-1",
  "scheme": "moonbit-ed25519-v1",
  "public_key": "...",
  "valid_from_ms": 100,
  "valid_until_ms": 300,
  "revoked_at_ms": null
}
```

署名authenticationはcamelCaseのhost DTOとして、`purpose`、`scopeId`、`unitId`、`subjectId`、
`keyId`、`keyVersion`、`scheme`、`publicKey`、payloadの`statementDigest`、`issuedAtMs`、
`signature`を持つ。秘密鍵、seed、key handleはwireへ含めない。

署名対象のcanonical statementは、次の配列をJSON encodingしたbytesのdigestである。
field追加時は既存配列を変更せず、新しいdomain/versionを作る。

```text
[
  "converge-audit-key-bound-signature-v1",
  1,
  purpose,
  scope_id,
  unit_id,
  subject_id,
  key_id,
  key_version,
  scheme,
  public_key,
  statement_digest,
  issued_at_ms
]
```

checkpoint配送では`statement_digest`を既存のdestination、protocol、purpose、manifest、scope、
unit、epoch、parent、checkpoint digest、canonical envelopeへ束縛済みのdigestとする。この二段bindingにより、
cross-purpose、cross-scope、cross-unit、key-version substitutionを一つの署名で横断できない。

## 3. rotationと履歴検証

同じ`key_id`は一つのlogical key slotを表し、全versionでsubject、purpose、scopeを変えない。
同じslotのversionは連続して増え、有効期間を重ねない。algorithm migrationでschemeを変えることはできるが、
各authenticationはschemeと公開鍵も署名する。

authorityは設定を読むたびに署名ごと全履歴を走査しない。provisioning時に全recordを検査・copyして
`(key_id, key_version)` indexを作り、検証時はO(1) expected lookup、canonical hash 1回、署名検証1回を行う。
履歴validationは`k` recordに対してgroup/sortを含むO(k log k)で、rotationや設定reload時だけ実行する。

受理条件は次の順にfail-closedで評価する。

1. authentication shapeとcallerが期待するpurpose/scope/unit/subject/payload digestが一致する。
2. exact `(key_id, key_version)` recordが履歴にある。
3. recordとauthenticationのsubject/purpose/scope/scheme/public keyが一致する。
4. `issued_at_ms <= verification_time + clock_skew`である。
5. `valid_from_ms <= issued_at_ms < valid_until_ms`である。
6. revocationがある場合、`issued_at_ms < revoked_at_ms`である。
7. scheme別verifierが存在し、canonical digestの署名が正しい。

現在時刻が`valid_until_ms`を過ぎたことは、条件5の代わりに使わない。これがroutine rotation後の
historical checkpoint検証を維持する。revocation時刻は発表時刻ではなく、運用者が決めた
effective invalidation boundaryである。

## 4. storage migration

production adapterは少なくとも次のmaterialized relationを持つ。

```sql
CREATE TABLE verification_key_versions (
  key_id TEXT NOT NULL,
  key_version INTEGER NOT NULL,
  subject_id TEXT NOT NULL,
  purpose TEXT NOT NULL,
  scope_id TEXT NOT NULL,
  scheme TEXT NOT NULL,
  public_key TEXT NOT NULL,
  valid_from_ms INTEGER NOT NULL,
  valid_until_ms INTEGER NOT NULL,
  revoked_at_ms INTEGER,
  lifecycle_revision INTEGER NOT NULL,
  PRIMARY KEY (key_id, key_version)
);

CREATE TABLE verification_key_lifecycle_events (
  event_digest TEXT PRIMARY KEY,
  key_id TEXT NOT NULL,
  key_version INTEGER NOT NULL,
  lifecycle_revision INTEGER NOT NULL,
  event_kind TEXT NOT NULL,
  canonical_event TEXT NOT NULL,
  committed_at_ms INTEGER NOT NULL,
  UNIQUE (key_id, lifecycle_revision)
);
```

rotationは旧versionの`valid_until_ms`確定、新version追加、revision前進、canonical lifecycle event追加を
一transactionで行う。revocationは`revoked_at_ms`とrevisionをCASし、同じtransactionでappend-only eventを
残す。materialized rowだけを監査履歴なしに更新してはならない。

公開鍵recordは、対象checkpoint、assetの最大寿命、appeal window、retention anchorのうち最長の期間が
終わるまで削除しない。private signing keyはroutine rotation後に破棄できるが、公開verification keyと
保護されたmetadataはhistorical verificationのためarchiveする。NIST SP 800-57 Part 1 Rev.5も、鍵だけでなく
key metadataの保護・回復をkey management対象としている
（[NIST SP 800-57 Part 1 Rev.5](https://csrc.nist.gov/pubs/sp/800/57/pt1/r5/final)）。

既存checkpoint delivery v1からの移行はdual readerで行う。

1. 既存policy内の公開鍵をsynthetic `key_id`/version 1 recordとしてarchiveする。
2. 既存v1署名は元のcanonical statementと旧policyでのみ検証し、署名bytesを書き換えない。
3. rollout後の新規署名はkey-bound v1 authentication（checkpoint protocol上はv2 envelope）だけを生成する。
4. 全writer移行後、v1は新規受理を停止するが、保持期限内のhistorical readは残す。
5. key historyが欠落した旧checkpointは「署名不正」ではなく`verification_key_history_unavailable`として
   central replay/operational recoveryへ送る。

## 5. private-key custody境界

authority Workerのcheckpoint受理pathは公開鍵historyとverifierだけを持ち、player/witness/sourceの
private keyを受け取らない。Worker自身がauthority署名を行うdeploymentでは、秘密値をWranglerの`vars`へ
置かずsecret bindingまたは外部signing serviceを使う。Cloudflareは`vars`を非secret設定、Secretsを暗号化された
bindingとして区別している（[Workers Secrets](https://developers.cloudflare.com/workers/configuration/secrets/)）。
可能ならraw secret文字列より、秘密をWorker codeへ露出しないservice/HSM capabilityを優先する。

player-local referenceのproduction signer objectは`scheme`、`publicKey`、非同期`signDigest`だけを公開し、
秘密鍵は`extractable=false`、usage=`["sign"]`の`CryptoKey`としてIndexedDBへstructured cloneする。
旧runのseedはJWK importでnon-extractable handleへ一方向migrationし、handleのdurable保存と
private/public一致検査が成功した後に旧seedを削除する。実験用の
`experimentalExportDeviceSeedForPersistence`は互換test用に残るがbrowser mainからは呼ばない。

このbrowser pathはprivate `CryptoKey`を`extractable=false`かつusage=`["sign"]`で生成し、
公開鍵だけをraw exportする。WebCryptoの`CryptoKey`はextractableとusagesを明示的に持つ
（[W3C Web Cryptography Level 2](https://www.w3.org/TR/WebCryptoAPI/)）。Cloudflare WorkersのWebCryptoは
標準Ed25519のsign/verify/generate/import/exportをサポートする
（[Cloudflare Workers Web Crypto](https://developers.cloudflare.com/workers/runtime-apis/web-crypto/)）。
ただしnon-extractable software keyは端末自体の侵害を防ぐ証明ではない。可能なplatformではOS keystore、
passkey/secure enclave、または端末外signing capabilityを検討する。

## 6. revocation運用

- routine rotation: 旧鍵の`valid_until_ms`をcutoverへ設定し、新versionを有効化する。cutover前署名は維持する。
- key loss、侵害なし: 新versionへrotationし、旧private keyを停止する。過去署名は維持する。
- compromise時刻が既知: `revoked_at_ms`をその時刻へ設定し、それ以降のcheckpointを再監査する。
- compromise範囲が不明: `revoked_at_ms = valid_from_ms`として全cryptoperiodを疑い、asset/market settlementをholdする。
- metadata/history欠損: fail-openせず、該当checkpointをunverifiableとしてcentral recoveryへ送る。

revocation通知そのものにもauthority署名、revision CAS、append-only event digestが必要である。単一の
mutable environment JSONだけをsource of truthにしない。

## 7. threat modelと非保証

この契約が拒否するのは、別purpose/scope/unit/payloadへのretarget、未知version、recordとは異なる公開鍵、
有効期間外、effective revocation以後、unsupported scheme、不正署名である。

保証しないものは、private keyが盗まれていないこと、client clockの真正性、Sybil耐性、正規鍵を持つplayerの
aimbot、roster管理者の悪意、暗号実装のconstant-time性、端末at-rest暗号、timestamp authorityである。
`issued_at_ms`は単独で信頼せず、checkpoint epoch/authority receipt/server-assigned time windowにも束縛する。

## 8. 形式仕様とのreconciliation ledger

| 項目 | 内容 |
| --- | --- |
| source | Issue #9のkey ID/version、validity、rotation、revocation、custody、過去checkpoint検証要件 |
| expected claim | routine rotation後も旧checkpointを検証でき、key substitutionや失効境界以後の署名は受理しない |
| implementation observation | 旧delivery policyは公開鍵をcurrent設定へ直接埋め、version/history/署名時刻を持たなかった。browser signerはseedを公開propertyに持っていた |
| model question | exact key binding、署名時点validity、effective revocation、旧公開鍵historyのどれが必要か |
| tool | MoonBit proof/Why3、Quint/TLC、Vitest + MoonBit/標準WebCrypto Ed25519 adapter。backend選択は時間遷移を持たない有限predicateなので新しいQuint modelではなくhost regression tableで固定 |
| machine result | MoonBit 5 proof goals、Quint正常model反例なし、3 broken modelでbinding/validity/revocation反例、正常6 + history deletion 1 scenario、同期/非同期共通preflight、WebCrypto/MoonBit共通vector、標準producer/witness署名生成、peer clientのretarget拒否、checkpoint配送・witness ingress・reference owner proof/checkpoint commitment/derived asset identityの標準/MoonBit二重検証、production gate、IndexedDB restart/migration、browser E2Eをtest |
| witness | version bindingを外すとV2署名をV1として受理、validityを外すとV1終了境界の署名を受理、revocationを外すとeffective boundary上の署名を受理。旧recordを削除するとrotation後の正当なV1 checkpointを検証不能 |
| domain wording | 鍵を更新しても過去の正当な戦利品を失効させない。一方、侵害期間に作られたcheckpointは後からmarketplaceで止められる |
| decision | validityはverification timeでなくsigned issuance timeに適用する。revocationはretroactiveに設定可能なeffective boundaryとし、公開鍵historyを証拠保持期間中archiveする |
| lock | `moon test/prove src/audit/key_lifecycle`、`just quint-scenarios`、`just quint-check`、`just quint-counterexamples`、`key-lifecycle.test.ts`、`production-crypto.test.ts`、`device-key-custody.node-test.ts`、Playwright E2E |

checkpoint配送は、MoonBitが生成するcanonical bytesを標準WebCryptoでhash/signature検証した後、既存MoonBit
verifierも同じopaque capabilityへ到達した場合だけwitness collection、source seal、receiver mutationへ進む。
producer/witness署名生成も同じMoonBit serializerと交換可能な非同期signerを使い、生成署名を送信前に自己検証する。
収集中の正当な`under_quorum`にはexact-bound partial capabilityを発行する。inventory listing/checkpoint/lineageの
authority checkpointとreplay-witness attestationも同じ標準/MoonBit二重検証を通す。inventoryのorigin
receipt/initial rootとauthenticated-map membership/public state rootも標準SHA-256で独立再計算する。未解決なのは、
同期生成hashの標準backend化、event/asset-delta rootを担うwitnessの独立性と運用監査、
上記SQL relationのCloudflare/端末DB migration、
authority署名鍵の外部custody、timestamp trust、backend/providerの運用監査である。
browser custodyだけを根拠にIssue #9全体を完了扱いしてはならない。
