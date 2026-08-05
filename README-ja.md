# mizchi/bft

[`mizchi/converge`](https://github.com/mizchi/converge) のイベントを敵対環境で認証し、
検証可能なcheckpoint監査を構築するためのMoonBit companion libraryです。

このライブラリはCRDTのmerge規則を変更しません。converge eventを配送前に認証する層と、
ゲーム非依存のcheckpoint、Merkle/AuthMap、quorum、durable outbox、ACK、再送契約を提供します。

```text
application policy / deterministic replay
                  │
                  ▼
mizchi/bft/audit ───── checkpoint・証拠・quorum・配送・runtime
                  │
                  ▼
mizchi/bft ─────────── converge Eventの認証adapter
                  │
                  ▼
mizchi/converge ────── CRDT・local-first同期
```

## パッケージ

| package | 責務 |
| --- | --- |
| `mizchi/bft` | 署名付きconverge event、roster拘束、equivocation検出、因果配送 |
| `mizchi/bft/audit` | checkpoint cadence/retention、finality見積り、head分類 |
| `mizchi/bft/audit/merkle` | immutable Merkle treeとinclusion proof |
| `mizchi/bft/audit/authmap` | deterministic authenticated mapとmembership/non-membership proof |
| `mizchi/bft/audit/layered` | watermark駆動のevent→micro→macro checkpoint |
| `mizchi/bft/audit/quorum` | domain-separatedな認証済みvote収集 |
| `mizchi/bft/audit/runtime` | atomic seal/outbox/ACKとpeer retry契約 |
| `mizchi/bft/x/game_audit/*` | PvE/PvP/open-world/inventory/marketplaceの実験policy |

汎用層が保証するのは履歴と証拠の認証・収束・配送条件です。人間が入力したこと、
aimbotやwallhackの不在、Sybil耐性、ゲーム操作の合法性は保証しません。これらはゲームごとの
deterministic replay kernelとdeployment policyが判断します。

## 開発

```sh
just check-all
just test
just prove
just tla-check
just tla-counterexamples
```

TLA+はcheckpoint配送とwitness quorumのinterleavingを検査し、MoonBit proofは純粋なpolicy、
head、seal、vote mergeの不変条件を検査します。文献・設計・実装契約は
[docs/README.md](docs/README.md)を参照してください。

## License

Apache-2.0
