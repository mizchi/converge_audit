#!/usr/bin/env sh
set -eu

quint typecheck formal/quint/CheckpointDeliveryMbt.qnt

audit_quint_tmp="$(mktemp -d "${TMPDIR:-/tmp}/converge-audit-quint-mbt.XXXXXX")"
trap 'rm -rf -- "$audit_quint_tmp"' EXIT HUP INT TERM

quint run formal/quint/CheckpointDeliveryMbt.qnt \
  --main=checkpointDeliveryMbt \
  --max-samples=1 \
  --n-traces=1 \
  --max-steps=10 \
  --out-itf="$audit_quint_tmp/trace_{seq}.itf.json" \
  --mbt \
  --seed=0x4254 \
  --invariant=true \
  --verbosity=1

pnpm --dir examples/node-audit-runtime run test:quint-mbt "$audit_quint_tmp"
