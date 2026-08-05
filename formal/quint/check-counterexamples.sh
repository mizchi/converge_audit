#!/usr/bin/env sh
set -eu

check_expected_failure() {
  file="$1"
  main="$2"
  property_kind="$3"
  property="$4"
  log_file="$5"

  if quint verify "$file" \
    --backend=tlc \
    --main="$main" \
    "--$property_kind=$property" \
    --verbosity=1 >"$log_file" 2>&1; then
    echo "expected Quint/TLC to reject $main::$property" >&2
    return 1
  fi

  if ! grep -F "[violation] Found an issue" "$log_file" >/dev/null \
    || ! grep -F "error: found a counterexample" "$log_file" >/dev/null; then
    echo "Quint/TLC rejected $main::$property for an unexpected reason" >&2
    sed -n '1,220p' "$log_file" >&2
    return 1
  fi

  echo "detected expected counterexample: $main::$property"
}

quint typecheck formal/quint/CheckpointDelivery.qnt
quint typecheck formal/quint/CheckpointDeliveryModels.qnt
quint typecheck formal/quint/WitnessQuorum.qnt
quint typecheck formal/quint/WitnessQuorumModels.qnt
quint typecheck formal/quint/AssetOwnership.qnt
quint typecheck formal/quint/AssetOwnershipModels.qnt

audit_quint_tmp="$(mktemp -d "${TMPDIR:-/tmp}/converge-audit-quint.XXXXXX")"
trap 'rm -rf -- "$audit_quint_tmp"' EXIT HUP INT TERM

check_expected_failure \
  formal/quint/CheckpointDeliveryModels.qnt \
  checkpointBrokenCompleteness \
  invariant \
  checkpointCompleteness \
  "$audit_quint_tmp/completeness.log"
check_expected_failure \
  formal/quint/CheckpointDeliveryModels.qnt \
  checkpointBrokenOutbox \
  invariant \
  noLostSealedCheckpoint \
  "$audit_quint_tmp/outbox.log"
check_expected_failure \
  formal/quint/CheckpointDeliveryModels.qnt \
  checkpointBrokenParent \
  invariant \
  headLogsAreExactChains \
  "$audit_quint_tmp/parent.log"
check_expected_failure \
  formal/quint/CheckpointDeliveryModels.qnt \
  checkpointBrokenRetry \
  temporal \
  authorityEventuallyFinalizes \
  "$audit_quint_tmp/retry.log"
check_expected_failure \
  formal/quint/CheckpointDeliveryModels.qnt \
  checkpointBrokenBackpressure \
  invariant \
  outboxWithinCapacity \
  "$audit_quint_tmp/backpressure.log"
check_expected_failure \
  formal/quint/WitnessQuorumModels.qnt \
  witnessBrokenProducer \
  invariant \
  readyRequiresAuthenticatedDistinctRosterQuorum \
  "$audit_quint_tmp/witness-producer.log"
check_expected_failure \
  formal/quint/WitnessQuorumModels.qnt \
  witnessBrokenRoster \
  invariant \
  readyRequiresAuthenticatedDistinctRosterQuorum \
  "$audit_quint_tmp/witness-roster.log"
check_expected_failure \
  formal/quint/AssetOwnershipModels.qnt \
  assetOwnershipBrokenRecipient \
  invariant \
  transferRequiresDualAuthentication \
  "$audit_quint_tmp/asset-recipient.log"
check_expected_failure \
  formal/quint/AssetOwnershipModels.qnt \
  assetOwnershipBrokenVersion \
  invariant \
  ownerVersionAdvancesExactlyOnce \
  "$audit_quint_tmp/asset-version.log"
check_expected_failure \
  formal/quint/AssetOwnershipModels.qnt \
  assetOwnershipBrokenListingGate \
  invariant \
  activeListingMatchesCurrentOwnerHead \
  "$audit_quint_tmp/asset-listing.log"
check_expected_failure \
  formal/quint/AssetOwnershipModels.qnt \
  assetOwnershipBrokenRevocationPropagation \
  invariant \
  activeListingRequiresCleanLineage \
  "$audit_quint_tmp/asset-revocation.log"
check_expected_failure \
  formal/quint/AssetOwnershipModels.qnt \
  assetOwnershipBrokenRevokedTransfer \
  invariant \
  transferRequiresCleanLineage \
  "$audit_quint_tmp/asset-revoked-transfer.log"
