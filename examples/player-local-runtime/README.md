# Player-local runtime host contract

Node/mobile SQLiteとbrowser IndexedDBが共有するstorage-neutral DTO、非同期対応
`PlayerLocalAuditStorage` interface、純粋validator、MoonBit checkpoint policy wrapperを置く。
ゲーム規則や特定DB APIは含めない。

`key-lifecycle.ts`は`key_id/version`、purpose/scope、公開鍵、有効期間、effective revocationを持つ
storage-neutralな履歴とkey-bound canonical signatureを提供する。履歴はprovisioning時に一度だけ検査・
index化し、authorityの署名検証hot pathはexact key lookupをO(1)で行う。rotation/revocation semanticsと
production custodyの限界は[鍵ライフサイクル契約](../../docs/key-lifecycle-ja.md)に定める。
`crypto-backend.ts`はhost I/O用の非同期SHA-256/Ed25519 contract、標準WebCrypto adapter、
experimental/productionのfail-closed admissionを提供する。同期MoonBit adapterとは同じvector suiteで比較し、
key lifecycleの純粋preflightを同期・非同期検証で共有する。
`digest-verification-plan.ts`はMoonBitが生成したbounded canonical statement列を解釈せず、client/server共通の
WebCrypto backendで並列hashする。domain framingやgame predicateはこのhost層へ再実装しない。

物理adapterは未認証network payloadからwrite-setを組み立てず、
`MoonBitCheckpointPolicy.prepareWriteSet`が返したDTOをCAS付きtransactionで適用する。
`conformance.node.ts`は同じrestart、fault rollback、stale revision、ACK容量再利用testを
Node SQLiteとIndexedDBの両方へ適用する。

現在のadapter:

- `examples/node-audit-runtime`: Node 24 `node:sqlite`
- `examples/cf-game-audit/web/src/audit/player-local-indexeddb.ts`: browser IndexedDB

Node SQLiteとIndexedDBでは、ACK済みの連続prefixだけを削除するdurable retention anchor、
appeal floor、protected epoch、equivocation pin、4点fault rollbackまで実装済みである。
認証済みfork/challenge/appeal参照はdurable evidence holdとして`active`から`resolved`へ遷移し、
active holdは呼出側のprune requestに依存せず対象epochを保護する。resolved証跡はcheckpointと
同じprefix transactionで削除する。配置・解決時にはrevisionを進めてstale pruneを失効させる。
`evidence-hold-wire.ts`はsource ID、hold IDと同値なmessage ID、boundary、checkpoint/reference、decisionに
加えて、sourceごとの連続sequenceと直前message digestをdomain-separated canonical statementへ束縛し、
暗号方式に依存しないauthenticator interfaceを公開する。検証済みのhold配置・解決と次のhash-chain cursorは
一つのrevision CAS transactionで保存するため、途中障害で片方だけが残らない。同一sequence/digestの再送は
`no_change`、gap、異なる直前digest、同一sequenceの別messageはfail-closedになる。sourceのgenesis digestは
最初のmessage受理時に呼出側設定と照合し、最初のcommit後はdurable cursorから再開する。
`evidence-inbox-polling.ts`はsource/cursorに束縛されたstorage-neutralなPOST/page DTOと件数上限decoderを持つ。
browser参照pollerは1 pageあたり最大128 messages / 1 MiB、request timeout、受信deadlineを設定でき、
HTTP/timeout/期限/byte超過/page超過ではDBを変更しない。page途中の不正messageでは、それ以前に個別署名と
hash-chainを通過したprefixだけがmessage単位transactionで残り、そのdurable cursorから再開する。実HTTP
loopbackでもPOST cursorと署名済みpageの往復を検査する。

poll transportはsource別のdurable jobとして、endpoint、genesis digest、deadline、next poll、連続失敗数、
単調attempt token、`scheduled`/`in_flight`/`expired`/`escalated`を保存する。claim leaseはdeadlineでcapし、
completionはattempt tokenとlease expiryの両方をCASするため、restart後に別workerが再claimした古い応答は
状態を上書きできない。成功は失敗数をresetし、失敗はMoonBitのdeadline-capped指数backoffで再scheduleする。
期限切れ・escalationは取得jobだけを停止し、active holdをdismissしない。

mobile SQLite、暗号化at-rest、ゲーム固有のappeal/case裁定、階層Merkle proofのpruningは未実装である。
