#!/usr/bin/env sh
set -eu

quint typecheck formal/quint/WitnessQuorumMbt.qnt

audit_quint_tmp="$(mktemp -d "${TMPDIR:-/tmp}/converge-audit-quint-witness-mbt.XXXXXX")"
trap 'rm -rf -- "$audit_quint_tmp"' EXIT HUP INT TERM

quint run formal/quint/WitnessQuorumMbt.qnt \
  --main=witnessQuorumMbt \
  --max-samples=1 \
  --n-traces=1 \
  --max-steps=11 \
  --out-itf="$audit_quint_tmp/trace_{seq}.itf.json" \
  --mbt \
  --seed=0x4255 \
  --invariant=true \
  --verbosity=1

pnpm --dir examples/cf-game-audit run test:quint-witness-mbt "$audit_quint_tmp"
