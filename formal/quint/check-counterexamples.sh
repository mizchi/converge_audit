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
    --verbosity=2 >"$log_file" 2>&1; then
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
quint typecheck formal/quint/LineageAppeal.qnt
quint typecheck formal/quint/LineageAppealModels.qnt
quint typecheck formal/quint/EvidenceLineageCase.qnt
quint typecheck formal/quint/EvidenceLineageCaseModels.qnt

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
check_expected_failure \
  formal/quint/AssetOwnershipModels.qnt \
  assetOwnershipBrokenLineageParent \
  invariant \
  registeredSliceRequiresExactBoundary \
  "$audit_quint_tmp/asset-lineage-parent.log"
check_expected_failure \
  formal/quint/LineageAppealModels.qnt \
  lineageAppealBrokenAuthentication \
  invariant \
  acceptedDecisionsAreAuthenticated \
  "$audit_quint_tmp/lineage-appeal-authentication.log"
check_expected_failure \
  formal/quint/LineageAppealModels.qnt \
  lineageAppealBrokenCertificateTime \
  invariant \
  acceptedCertificatesWereTimely \
  "$audit_quint_tmp/lineage-appeal-certificate-time.log"
check_expected_failure \
  formal/quint/LineageAppealModels.qnt \
  lineageAppealBrokenRevision \
  invariant \
  decisionRevisionMatchesHistory \
  "$audit_quint_tmp/lineage-appeal-revision.log"
check_expected_failure \
  formal/quint/LineageAppealModels.qnt \
  lineageAppealBrokenTarget \
  invariant \
  finalizedAppealHasExactTarget \
  "$audit_quint_tmp/lineage-appeal-target.log"
check_expected_failure \
  formal/quint/LineageAppealModels.qnt \
  lineageAppealBrokenDeadline \
  invariant \
  finalizedAppealHadOpenWindow \
  "$audit_quint_tmp/lineage-appeal-deadline.log"
check_expected_failure \
  formal/quint/EvidenceLineageCaseModels.qnt \
  evidenceLineageCaseBrokenHoldAuthentication \
  invariant \
  acceptedCasesRequireAuthenticatedActiveExactHolds \
  "$audit_quint_tmp/evidence-case-hold-authentication.log"
check_expected_failure \
  formal/quint/EvidenceLineageCaseModels.qnt \
  evidenceLineageCaseBrokenHoldBinding \
  invariant \
  acceptedCasesRequireAuthenticatedActiveExactHolds \
  "$audit_quint_tmp/evidence-case-hold-binding.log"
check_expected_failure \
  formal/quint/EvidenceLineageCaseModels.qnt \
  evidenceLineageCaseBrokenOpenMutation \
  invariant \
  caseOpeningNeverChangesAsset \
  "$audit_quint_tmp/evidence-case-open-mutation.log"
check_expected_failure \
  formal/quint/EvidenceLineageCaseModels.qnt \
  evidenceLineageCaseBrokenCertificateAuthentication \
  invariant \
  assetMutationRequiresAuthenticatedExactCertificate \
  "$audit_quint_tmp/evidence-case-certificate-authentication.log"
check_expected_failure \
  formal/quint/EvidenceLineageCaseModels.qnt \
  evidenceLineageCaseBrokenDecisionBinding \
  invariant \
  assetMutationRequiresAuthenticatedExactCertificate \
  "$audit_quint_tmp/evidence-case-decision-binding.log"
check_expected_failure \
  formal/quint/EvidenceLineageCaseModels.qnt \
  evidenceLineageCaseBrokenDismissalAuthentication \
  invariant \
  dismissedCasesRequireAuthenticatedExactCertificate \
  "$audit_quint_tmp/evidence-case-dismissal-authentication.log"
check_expected_failure \
  formal/quint/EvidenceLineageCaseModels.qnt \
  evidenceLineageCaseBrokenDismissalBinding \
  invariant \
  dismissedCasesRequireAuthenticatedExactCertificate \
  "$audit_quint_tmp/evidence-case-dismissal-binding.log"
check_expected_failure \
  formal/quint/EvidenceLineageCaseModels.qnt \
  evidenceLineageCaseBrokenDismissalMutation \
  invariant \
  onlyUpheldDecisionMutatesAsset \
  "$audit_quint_tmp/evidence-case-dismissal-mutation.log"
