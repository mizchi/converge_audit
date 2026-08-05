#!/usr/bin/env sh
set -eu

check_invalid_config() {
  main="$1"
  log_file="$2"

  if quint verify formal/quint/ConfigContracts.qnt \
    --backend=tlc \
    --main="$main" \
    --invariant=configIsValid \
    --verbosity=3 >"$log_file" 2>&1; then
    echo "expected Quint/TLC to reject invalid configuration: $main" >&2
    return 1
  fi

  if ! grep -F "The invariant of q_inv is equal to FALSE" "$log_file" >/dev/null; then
    echo "Quint/TLC rejected $main for an unexpected reason" >&2
    sed -n '1,160p' "$log_file" >&2
    return 1
  fi

  echo "rejected invalid configuration: $main"
}

quint typecheck formal/quint/ConfigContracts.qnt

audit_quint_tmp="$(mktemp -d "${TMPDIR:-/tmp}/bft-quint-contracts.XXXXXX")"
trap 'rm -rf -- "$audit_quint_tmp"' EXIT HUP INT TERM

check_invalid_config checkpointInvalidCapacity "$audit_quint_tmp/capacity.log"
check_invalid_config witnessInvalidQuorumLow "$audit_quint_tmp/quorum-low.log"
check_invalid_config witnessInvalidQuorumHigh "$audit_quint_tmp/quorum-high.log"
