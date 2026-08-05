#!/usr/bin/env sh
set -eu

quint typecheck formal/quint/CheckpointDeliveryTests.qnt
quint typecheck formal/quint/WitnessQuorumTests.qnt
quint typecheck formal/quint/AssetOwnershipTests.qnt

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
  --match='^(transferListCancelTransfer|activeListingBlocksTransfer|recipientMustAcceptTransfer|canceledListingCannotReplay|canceledOwnerCanRelistWithFreshNonce|ancestorRevocationQuarantinesDescendantListing|appealRecomputesButDoesNotReactivateListing|appealDoesNotPermitQuarantinedNonceReplay|oneAppealDoesNotClearAnotherRevokedAncestor|revokedLineageBlocksTransfer|appealRestoresTransfer)$' \
  --verbosity=1
