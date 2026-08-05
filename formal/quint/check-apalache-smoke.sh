#!/usr/bin/env sh
set -eu

quint typecheck formal/quint/WitnessQuorum.qnt

# Apalache is bounded here. This is a smoke check, not a replacement for the
# complete finite-state TLC safety/liveness runs in check.sh.
quint verify formal/quint/WitnessQuorum.qnt \
  --main=witnessSafety \
  --invariant=safety \
  --max-steps=5 \
  --verbosity=1

audit_quint_tmp="$(mktemp -d "${TMPDIR:-/tmp}/bft-quint-apalache.XXXXXX")"
trap 'rm -rf -- "$audit_quint_tmp"' EXIT HUP INT TERM
log_file="$audit_quint_tmp/broken-producer.log"

if quint verify formal/quint/WitnessQuorum.qnt \
  --main=witnessBrokenProducer \
  --invariant=readyRequiresAuthenticatedDistinctRosterQuorum \
  --max-steps=8 \
  --verbosity=1 >"$log_file" 2>&1; then
  echo "expected Apalache to reject the broken producer gate" >&2
  exit 1
fi

if ! grep -F "[violation] Found an issue" "$log_file" >/dev/null \
  || ! grep -F "error: found a counterexample" "$log_file" >/dev/null; then
  echo "Apalache rejected the broken producer gate for an unexpected reason" >&2
  sed -n '1,220p' "$log_file" >&2
  exit 1
fi

echo "detected expected bounded counterexample: witnessBrokenProducer"
