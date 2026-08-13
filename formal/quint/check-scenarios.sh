#!/usr/bin/env sh
set -eu

quint typecheck formal/quint/CheckpointDeliveryTests.qnt
quint typecheck formal/quint/WitnessQuorumTests.qnt
quint typecheck formal/quint/AssetOwnershipTests.qnt
quint typecheck formal/quint/LineageAppealTests.qnt
quint typecheck formal/quint/EvidenceLineageCaseTests.qnt
quint typecheck formal/quint/KeyLifecycleTests.qnt
quint typecheck formal/quint/ObserverSigningStoreTests.qnt

quint test formal/quint/CheckpointDeliveryTests.qnt \
  --main=checkpointDeliveryTests \
  --match='^(authorityFinalizesTwoEpochs|durableOutboxSurvivesCrash|fullOutboxBlocksNextSeal)$' \
  --verbosity=1

quint test formal/quint/WitnessQuorumTests.qnt \
  --main=witnessQuorumTests \
  --match='^(threeDistinctApprovalsAdvanceReceiver|intruderDoesNotCountTowardQuorum|expiryDoesNotAdvanceReceiver)$' \
  --verbosity=1

quint test formal/quint/AssetOwnershipTests.qnt \
  --main=assetOwnershipTests \
  --match='^(transferListCancelTransfer|activeListingBlocksTransfer|recipientMustAcceptTransfer|canceledListingCannotReplay|canceledOwnerCanRelistWithFreshNonce|ancestorRevocationQuarantinesDescendantListing|appealRecomputesButDoesNotReactivateListing|appealDoesNotPermitQuarantinedNonceReplay|oneAppealDoesNotClearAnotherRevokedAncestor|revokedLineageBlocksTransfer|appealRestoresTransfer|unprovenHistoricalTransferCannotBeRevoked|authenticatedSliceEnablesHistoricalRevocation|wrongParentSliceIsRejected)$' \
  --verbosity=1

quint test formal/quint/LineageAppealTests.qnt \
  --main=lineageAppealTests \
  --match='^(provisionalRevokeAppealFinalized|expiredAppealIsRejected|wrongDecisionAppealIsRejected|oneAppealDoesNotClearAnotherRevocation|exactDuplicateIsIdempotent|conflictingDecisionIdIsRejected)$' \
  --verbosity=1

quint test formal/quint/EvidenceLineageCaseTests.qnt \
  --main=evidenceLineageCaseTests \
  --match='^(authenticatedHoldOpensWithoutRevoking|exactCertificateDecidesAndRevokes|exactDismissalClosesWithoutRevoking|exactSourceResolutionResolvesDismissedHold|unauthenticatedSourceResolutionIsRejected|retargetedSourceResolutionIsRejected|staleSourceCursorIsRejected|unauthenticatedDismissalIsRejected|retargetedDismissalIsRejected|unauthenticatedHoldIsRejected|retargetedDecisionIsRejected|exactDuplicateIsIdempotent)$' \
  --verbosity=1

quint test formal/quint/KeyLifecycleTests.qnt \
  --main=keyLifecycleTests \
  --match='^(oldCheckpointVerifiesAfterRotation|oldCheckpointBeforeRevocationStillVerifies|compromisedCheckpointAtRevocationBoundaryIsRejected|substitutedKeyVersionIsRejected|expiredSigningTimeIsRejected|currentKeyCheckpointIsAccepted)$' \
  --verbosity=1

quint test formal/quint/ObserverSigningStoreTests.qnt \
  --main=observerSigningStoreTests \
  --match='^(exactRetryIsIdempotent|conflictingDigestIsRejected|signerFailureKeepsReservationAcrossCrash)$' \
  --verbosity=1

quint test formal/quint/KeyLifecycleTests.qnt \
  --main=keyLifecycleHistoryRetentionTests \
  --match='^droppingOldKeyMakesHistoricalVerificationUnavailable$' \
  --verbosity=1
