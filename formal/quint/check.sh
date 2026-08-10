#!/usr/bin/env sh
set -eu

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

quint verify formal/quint/CheckpointDeliveryModels.qnt \
  --backend=tlc \
  --main=checkpointSafety \
  --invariants \
    configIsValid \
    typeOk \
    checkpointCompleteness \
    checkpointAgreement \
    headLogsAreExactChains \
    acceptedEventsSurviveCrash \
    noLostSealedCheckpoint \
    outboxWithinCapacity \
    authorityAcceptsOnlyCreatedCheckpoints \
  --verbosity=1

quint verify formal/quint/CheckpointDeliveryModels.qnt \
  --backend=tlc \
  --main=checkpointSafety \
  --invariants \
    configIsValid \
    typeOk \
    checkpointCompleteness \
    checkpointAgreement \
    headLogsAreExactChains \
    acceptedEventsSurviveCrash \
    noLostSealedCheckpoint \
    outboxWithinCapacity \
    authorityAcceptsOnlyCreatedCheckpoints \
  --temporal=stableNetworkLeadsToFinality \
  --verbosity=1

quint verify formal/quint/WitnessQuorumModels.qnt \
  --backend=tlc \
  --main=witnessSafety \
  --invariants \
    configIsValid \
    typeOk \
    readyRequiresAuthenticatedDistinctRosterQuorum \
    receiverRequiresReadyCollection \
    timeoutNeverMarksInvalid \
    expiredCollectionNeverAdvances \
  --verbosity=1

quint verify formal/quint/WitnessQuorumModels.qnt \
  --backend=tlc \
  --main=witnessLiveness \
  --invariants \
    configIsValid \
    typeOk \
    readyRequiresAuthenticatedDistinctRosterQuorum \
    receiverRequiresReadyCollection \
    timeoutNeverMarksInvalid \
    expiredCollectionNeverAdvances \
  --temporal=allHonestApprovalsEventuallyReady \
  --verbosity=1

quint verify formal/quint/AssetOwnershipModels.qnt \
  --backend=tlc \
  --main=assetOwnershipSafety \
  --invariants \
    typeOk \
    ownerVersionAdvancesExactlyOnce \
    transferRequiresDualAuthentication \
    transferRequiresCleanLineage \
    activeListingMatchesCurrentOwnerHead \
    lineageFlagMatchesRevocations \
    activeListingRequiresCleanLineage \
    verifiedAncestorsRespectRetentionBoundary \
    registeredSliceRequiresExactBoundary \
  --verbosity=1

quint verify formal/quint/LineageAppealModels.qnt \
  --backend=tlc \
  --main=lineageAppealSafety \
  --invariants \
    typeOk \
    lineageFlagMatchesIndependentHeads \
    lifecycleMatchesStatus \
    acceptedDecisionsAreAuthenticated \
    acceptedCertificatesWereTimely \
    decisionRevisionMatchesHistory \
    finalizedAppealHasExactTarget \
    finalizedAppealHadOpenWindow \
  --verbosity=1

quint verify formal/quint/EvidenceLineageCaseModels.qnt \
  --backend=tlc \
  --main=evidenceLineageCaseSafety \
  --invariants \
    typeOk \
    acceptedCasesRequireAuthenticatedActiveExactHolds \
    caseOpeningNeverChangesAsset \
    assetMutationRequiresAuthenticatedExactCertificate \
    dismissedCasesRequireAuthenticatedExactCertificate \
    onlyUpheldDecisionMutatesAsset \
    caseCloseNeverAutomaticallyResolvesHold \
    resolvedHoldsRequireAuthenticatedExactSourceCursor \
    decidedCasesMatchDecisionCount \
    dismissedCasesMatchDismissalCount \
    resolvedHoldsMatchResolutionCount \
  --verbosity=1
