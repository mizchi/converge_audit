# MoonBit JS共有検証アーキテクチャ

更新日: 2026-08-11

## 結論

clientとserverは、同じMoonBit packageから生成したJavaScriptでcanonical化、純粋predicate、
state transition、verification plan生成を共有する。TypeScriptはWebCrypto、HTTP、D1、Durable
Objects、IndexedDBなどのhost adapterに限定する。

同じコードを共有してもclientの判定結果は信用しない。clientはpredictionと送信前preflightのために
実行し、serverは受信した認証済みinputから同じMoonBitロジックを独立に再実行する。

## Source of truth

| 対象 | Source of truth | 実行場所 |
| --- | --- | --- |
| canonical statement、field順、domain tag、roster順 | MoonBit serializer | client + server |
| roster、quorum、version、parent、ownershipなどのpredicate | MoonBit implementation / proof | client + server |
| protocolの状態遷移 | MoonBit + Quint | client + server / model checker |
| SHA-256、Ed25519の具体実行 | host WebCrypto adapter | client + server |
| DB transaction、network、key handle | TypeScript host adapter | 環境ごと |
| 実装多様性による相互運用確認 | test-only TypeScript reference | testのみ |

runtime TypeScriptへMoonBitと同じ意味論を再実装しない。独立実装はproductionの第二source of truthにせず、
canonical vectorとbroken-backendを検出するdifferential testへ閉じ込める。

## Verification plan

MoonBitは暗号処理そのものではなく、hostが実行するbounded planを生成する。

```text
MoonBit decode + semantic validation
  -> DigestVerificationPlan
       kind
       check_index
       canonical_statement
       expected_digest
  -> TypeScript WebCrypto executor
  -> digest/signature result
  -> state mutation gate
```

現在のdigest plan JSON contractは次である。

```json
{
  "hash_check_count": 1,
  "hash_checks": [{
    "kind": "replay_witness_session_manifest",
    "check_index": 0,
    "canonical_statement": "...",
    "expected_digest": "lower-hex SHA-256"
  }]
}
```

executorは件数、連続index、文字列budget、digest wire formを検査し、独立WebCrypto backendで
全checkを並列実行する。statementの意味は解釈しない。意味論はplanを発行したMoonBit verifierが所有する。

署名検証も既存の`DigestSignatureAuthenticationCheck`が同じ形を使う。今後hash/signature planを
一つのbounded DAGへまとめる場合も、host executorにgame語彙を持ち込まない。

## Client / server境界

```text
browser
  MoonBit browser bridge
    canonicalize / preflight / predict
  WebCrypto + IndexedDB + transport
             │ untrusted request
             ▼
Cloudflare Worker
  MoonBit worker bridge
    decode / validate / create plan again
  WebCrypto executor
  Durable Object transaction
```

- serverはclientが返した`ok`、root、planをそのまま受理しない。
- serverはcanonical bundleからplanを再生成する。
- server mutationはMoonBit predicateと標準暗号planの両方が成功した後だけ行う。
- client/serverはserializerを共有するが、鍵、DB transaction、時刻、rate limitは共有しない。
- browserへ1.6 MBの全Worker bridgeを配らず、用途別bridgeをtree-shake可能に保つ。

## Compact proofの委譲境界

共有実装は、中央serverが全ログを保持することを意味しない。inventory checkpointではsession manifest、
origin、lineage、authenticated-map rootを中央で再計算できる。一方、`event_root`と
`asset_delta_root`の全preimageはcompact bundleから省き、認証済み`n-f` replay witnessへ意味論検証を
委譲する。中央は署名とquorumを検証するが、この2 rootを自らreplayしたとは主張しない。

## 現在の移行状態

| 対象 | 状態 | 次の整理 |
| --- | --- | --- |
| replay-witness session manifest | MoonBit serializer + Worker plan + browser bridge + WebCrypto executorへ移行済み | 他planと共通metrics化 |
| checkpoint/attestation署名 | MoonBit canonical transcript + generic TS executor済み | digest/signature plan型の統合を検討 |
| origin / initial lineage root | runtime TSにもcanonical化が残る | MoonBit hash planへ移し、TS実装をtest-only化 |
| lineage transition root | runtime TSにもcanonical化が残る | bounded hash planへ移行 |
| authenticated-map membership | runtime TSにtree再計算が残る | 依存順を持つbounded hash planへ移行 |
| game replay / state transition | MoonBit JS共有済み | game別bridgeを小さく保つ |
| D1 / Durable Objects / IndexedDB | TypeScript adapter | MoonBitへ移さない |

## 移行規則

1. 現在のTS実装をnegative controlとして先に固定する。
2. MoonBitから同じcanonical statementをplanとして公開する。
3. WebCrypto executorとの相互運用testをGreenにする。
4. clientとserverの両bridgeが同じMoonBit serializerを使うことをtestする。
5. runtime TSの意味論を削り、必要な参照実装だけtestへ移す。
6. `moon test`、`just prove`、`just formal-check`、Worker/Playwright testを通す。

## Decision ledger

| 項目 | 内容 |
| --- | --- |
| source | client/serverの意味論重複を減らし、証明対象と実行コードを一致させたい |
| observation | inventory周辺ではTSがMoonBitのframing、roster順、root計算を再実装していた |
| model question | MoonBitを唯一の意味論実装にしても、server独立実行と標準暗号検査を保存できるか |
| machine result | manifest serializerを両bridgeで共有し、MoonBit planを標準WebCrypto executorで検証。test-only TS referenceとも一致 |
| decision | runtimeはMoonBit semantic plan + host crypto/I/O adapter、実装多様性はdifferential testで維持する |
| lock | witness manifest/bridge test、digest plan test、inventory checkpoint semantics/integration test、全形式検査 |
