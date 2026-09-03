# Project Agents Guide

ユーザーには日本語で答える。

TDD（探索 → Red → Green → Refactoring）で開発し、関心の分離、状態とロジックの分離、
公開contractの厳密さを優先する。

このリポジトリはMoonBit module `mizchi/converge_audit` であり、`mizchi/converge` に依存する。

- root package `mizchi/converge_audit`: converge Eventの敵対環境向け認証adapter
- `mizchi/converge_audit/audit/*`: ゲーム非依存のcheckpoint監査contract
- `mizchi/converge_audit/x/game_audit/*`: 実験的なゲーム固有policy
- `mizchi/converge_audit/prdt/*`: PRDT流のreplicated domain object（純粋domain reducer + 複製finalization protocol）。MMO sample、simulator、JS bridgeを含む

`src/audit` から `src/x/game_audit` への依存を禁止する。
`src/prdt` から `src/audit` と `src/x/game_audit` への依存を禁止する（root の `Hasher`/`Signer`/`Verifier` trait のみ共有）。

最終確認では `moon info && moon fmt`、`moon check --target all`、`moon test` を実行する。
証明を変更した場合は `just prove`、protocolを変更した場合は `just formal-check` も実行する。
