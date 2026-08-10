// Authenticated evidence hold -> lineage case -> arbiter decision handoff.
//
// Cryptographic verification and concrete asset/checkpoint lookup are abstracted
// to booleans. Opening a case only records investigation evidence. The economic
// asset state changes exclusively through an authenticated, exact-bound decision.
module evidenceLineageCase {
  type CaseId = C1 | C2
  type CaseStatus = Absent | Open | Decided | Dismissed
  type AssetStatus = Eligible | Revoked

  type State = {
    caseStatus: CaseId -> CaseStatus,
    holdActive: CaseId -> bool,
    holdAuthenticated: CaseId -> bool,
    holdExactlyBound: CaseId -> bool,
    assetStatus: AssetStatus,
    decisionCount: int,
    dismissalCount: int,
    assetMutationCount: int,
    lastCertificateAuthenticated: bool,
    lastDecisionExactlyBound: bool,
    lastDismissalAuthenticated: bool,
    lastDismissalExactlyBound: bool,
  }

  const enforceHoldAuthentication: bool
  const enforceHoldBinding: bool
  const enforceCertificateAuthentication: bool
  const enforceDecisionBinding: bool
  const enforceDismissalAuthentication: bool
  const enforceDismissalBinding: bool
  const mutateAssetOnCaseOpen: bool
  const mutateAssetOnDismissal: bool

  pure val Cases = Set(C1, C2)
  var state: State

  /// Start with no investigation and an economically eligible asset.
  action init = {
    state' = {
      caseStatus: Cases.mapBy(_ => Absent),
      holdActive: Cases.mapBy(_ => false),
      holdAuthenticated: Cases.mapBy(_ => false),
      holdExactlyBound: Cases.mapBy(_ => false),
      assetStatus: Eligible,
      decisionCount: 0,
      dismissalCount: 0,
      assetMutationCount: 0,
      lastCertificateAuthenticated: true,
      lastDecisionExactlyBound: true,
      lastDismissalAuthenticated: true,
      lastDismissalExactlyBound: true,
    }
  }

  /// Promote one active hold. Even upheld-looking evidence is not a verdict.
  action openCase(
    caseId: CaseId,
    active: bool,
    authenticated: bool,
    exactlyBound: bool,
  ): bool = all {
    caseId.in(Cases),
    state.caseStatus.get(caseId) == Absent,
    active,
    not(enforceHoldAuthentication) or authenticated,
    not(enforceHoldBinding) or exactlyBound,
    state' = {
      ...state,
      caseStatus: state.caseStatus.set(caseId, Open),
      holdActive: state.holdActive.set(caseId, active),
      holdAuthenticated: state.holdAuthenticated.set(caseId, authenticated),
      holdExactlyBound: state.holdExactlyBound.set(caseId, exactlyBound),
      assetStatus: if (mutateAssetOnCaseOpen) Revoked else state.assetStatus,
      assetMutationCount:
        state.assetMutationCount + (if (mutateAssetOnCaseOpen) 1 else 0),
    },
  }

  /// Resolve exactly one open case. This is the sole asset mutation action.
  action decideCase(
    caseId: CaseId,
    authenticated: bool,
    exactlyBound: bool,
  ): bool = all {
    caseId.in(Cases),
    state.caseStatus.get(caseId) == Open,
    not(enforceCertificateAuthentication) or authenticated,
    not(enforceDecisionBinding) or exactlyBound,
    state' = {
      ...state,
      caseStatus: state.caseStatus.set(caseId, Decided),
      assetStatus: Revoked,
      decisionCount: state.decisionCount + 1,
      assetMutationCount: state.assetMutationCount + 1,
      lastCertificateAuthenticated: authenticated,
      lastDecisionExactlyBound: exactlyBound,
    },
  }

  /// Dismiss exactly one open case without changing economic asset state.
  action dismissCase(
    caseId: CaseId,
    authenticated: bool,
    exactlyBound: bool,
  ): bool = all {
    caseId.in(Cases),
    state.caseStatus.get(caseId) == Open,
    not(enforceDismissalAuthentication) or authenticated,
    not(enforceDismissalBinding) or exactlyBound,
    state' = {
      ...state,
      caseStatus: state.caseStatus.set(caseId, Dismissed),
      assetStatus: if (mutateAssetOnDismissal) Revoked else state.assetStatus,
      dismissalCount: state.dismissalCount + 1,
      assetMutationCount:
        state.assetMutationCount + (if (mutateAssetOnDismissal) 1 else 0),
      lastDismissalAuthenticated: authenticated,
      lastDismissalExactlyBound: exactlyBound,
    },
  }

  /// An exact case retry is idempotent in either durable state.
  action duplicate(caseId: CaseId): bool = all {
    caseId.in(Cases),
    state.caseStatus.get(caseId) != Absent,
    state' = state,
  }

  action openSome = {
    nondet caseId = Cases.oneOf()
    nondet active = Set(true, false).oneOf()
    nondet authenticated = Set(true, false).oneOf()
    nondet exactlyBound = Set(true, false).oneOf()
    openCase(caseId, active, authenticated, exactlyBound)
  }

  action decideSome = {
    nondet caseId = Cases.oneOf()
    nondet authenticated = Set(true, false).oneOf()
    nondet exactlyBound = Set(true, false).oneOf()
    decideCase(caseId, authenticated, exactlyBound)
  }

  action duplicateSome = {
    nondet caseId = Cases.oneOf()
    duplicate(caseId)
  }

  action dismissSome = {
    nondet caseId = Cases.oneOf()
    nondet authenticated = Set(true, false).oneOf()
    nondet exactlyBound = Set(true, false).oneOf()
    dismissCase(caseId, authenticated, exactlyBound)
  }

  action step = any { openSome, decideSome, dismissSome, duplicateSome }

  val typeOk = and {
    state.caseStatus.keys() == Cases,
    state.holdActive.keys() == Cases,
    state.holdAuthenticated.keys() == Cases,
    state.holdExactlyBound.keys() == Cases,
    state.decisionCount >= 0,
    state.decisionCount <= 2,
    state.dismissalCount >= 0,
    state.dismissalCount <= 2,
    state.assetMutationCount >= 0,
    state.assetMutationCount <= 2,
  }

  val acceptedCasesRequireAuthenticatedActiveExactHolds =
    Cases.forall(caseId =>
      state.caseStatus.get(caseId) != Absent implies and {
        state.holdActive.get(caseId),
        state.holdAuthenticated.get(caseId),
        state.holdExactlyBound.get(caseId),
      })

  val caseOpeningNeverChangesAsset =
    state.decisionCount == 0 implies state.assetStatus == Eligible

  val assetMutationRequiresAuthenticatedExactCertificate =
    state.assetStatus == Revoked implies and {
      state.decisionCount > 0,
      state.lastCertificateAuthenticated,
      state.lastDecisionExactlyBound,
    }

  val dismissedCasesRequireAuthenticatedExactCertificate =
    state.dismissalCount > 0 implies and {
      state.lastDismissalAuthenticated,
      state.lastDismissalExactlyBound,
    }

  val onlyUpheldDecisionMutatesAsset =
    state.assetMutationCount == state.decisionCount

  val decidedCasesMatchDecisionCount =
    state.decisionCount ==
      Cases.filter(caseId => state.caseStatus.get(caseId) == Decided).size()

  val dismissedCasesMatchDismissalCount =
    state.dismissalCount ==
      Cases.filter(caseId => state.caseStatus.get(caseId) == Dismissed).size()
}
