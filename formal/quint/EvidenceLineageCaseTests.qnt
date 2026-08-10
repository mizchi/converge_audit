module evidenceLineageCaseTests {
  import evidenceLineageCase(
    enforceHoldAuthentication = true,
    enforceHoldBinding = true,
    enforceCertificateAuthentication = true,
    enforceDecisionBinding = true,
    enforceDismissalAuthentication = true,
    enforceDismissalBinding = true,
    mutateAssetOnCaseOpen = false,
    mutateAssetOnDismissal = false
  ).* from "./EvidenceLineageCase"

  run authenticatedHoldOpensWithoutRevoking =
    init
      .then(openCase(C1, true, true, true))
      .expect(and {
        state.caseStatus.get(C1) == Open,
        state.assetStatus == Eligible,
        state.decisionCount == 0,
      })

  run exactCertificateDecidesAndRevokes =
    init
      .then(openCase(C1, true, true, true))
      .then(decideCase(C1, true, true))
      .expect(and {
        state.caseStatus.get(C1) == Decided,
        state.assetStatus == Revoked,
        state.decisionCount == 1,
      })

  run exactDismissalClosesWithoutRevoking =
    init
      .then(openCase(C1, true, true, true))
      .then(dismissCase(C1, true, true))
      .expect(and {
        state.caseStatus.get(C1) == Dismissed,
        state.assetStatus == Eligible,
        state.dismissalCount == 1,
        state.assetMutationCount == 0,
      })

  run unauthenticatedDismissalIsRejected =
    init
      .then(openCase(C1, true, true, true))
      .then(dismissCase(C1, false, true).fail())

  run retargetedDismissalIsRejected =
    init
      .then(openCase(C1, true, true, true))
      .then(dismissCase(C1, true, false).fail())

  run unauthenticatedHoldIsRejected =
    init.then(openCase(C1, true, false, true).fail())

  run retargetedDecisionIsRejected =
    init
      .then(openCase(C1, true, true, true))
      .then(decideCase(C1, true, false).fail())

  run exactDuplicateIsIdempotent =
    init
      .then(openCase(C1, true, true, true))
      .then(duplicate(C1))
      .expect(and {
        state.caseStatus.get(C1) == Open,
        state.assetStatus == Eligible,
      })
}
