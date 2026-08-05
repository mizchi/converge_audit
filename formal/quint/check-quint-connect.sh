#!/usr/bin/env sh
set -eu

quint typecheck formal/quint/AssetOwnershipModels.qnt

moon test \
  -p mizchi/converge_audit/x/game_audit/quint_asset_driver \
  --deny-warn

moon run \
  --target native \
  src/x/game_audit/quint_asset_driver/cmd \
  -- formal/quint/AssetOwnershipModels.qnt

audit_connect_log="$(mktemp "${TMPDIR:-/tmp}/converge-audit-quint-connect.XXXXXX")"
trap 'rm -f -- "$audit_connect_log"' EXIT HUP INT TERM

if moon run \
  --target native \
  src/x/game_audit/quint_asset_driver/cmd \
  -- formal/quint/AssetOwnershipModels.qnt --broken-revocation \
  >"$audit_connect_log" 2>&1; then
  echo "broken revocation driver unexpectedly matched the Quint model" >&2
  exit 1
fi

if ! grep -q 'StateDiverged' "$audit_connect_log"; then
  echo "broken revocation driver failed without reporting state divergence" >&2
  cat "$audit_connect_log" >&2
  exit 1
fi

echo "Quint Connect negative control detected revocation state divergence"
