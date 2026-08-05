# Project Agents Guide

ユーザーには日本語で答える。

TDD（探索 → Red → Green → Refactoring）で開発し、関心の分離、状態とロジックの分離、
公開contractの厳密さを優先する。

このリポジトリはMoonBit module `mizchi/bft` であり、`mizchi/converge` に依存する。

- root package `mizchi/bft`: converge Eventの認証adapter
- `mizchi/bft/audit/*`: ゲーム非依存のcheckpoint監査contract
- `mizchi/bft/x/game_audit/*`: 実験的なゲーム固有policy

`src/audit` から `src/x/game_audit` への依存を禁止する。

最終確認では `moon info && moon fmt`、`moon check --target all`、`moon test` を実行する。
証明を変更した場合は `just prove`、protocolを変更した場合は `just tla-check` と
`just tla-counterexamples` も実行する。
