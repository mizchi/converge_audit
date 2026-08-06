// External-arbiter lineage decision and appeal-window lifecycle.
//
// Signature algorithms and wall-clock arithmetic are abstracted to verified
// booleans. The model checks exact decision binding, per-ancestor revision,
// expiry, finalization, and isolation between independent revocations.
module lineageAppeal {
  type Ancestor = A1 | A2
  type DecisionId = D1 | D2 | D3 | D4
  type AssetStatus = Eligible | Revoked
  type DecisionLifecycle = Finalized | AppealOpen | Expired
  type Time = T0 | T1 | T2

  type State = {
    now: Time,
    status: Ancestor -> AssetStatus,
    lifecycle: Ancestor -> DecisionLifecycle,
    revision: Ancestor -> int,
    decisionCount: Ancestor -> int,
    lastDecision: Ancestor -> DecisionId,
    appealDeadline: Ancestor -> Time,
    decisionHistory: Set[DecisionId],
    lineageClean: bool,
    appealCount: int,
    lastCertificateAuthenticated: bool,
    lastCertificateTimeValid: bool,
    lastRevisionAdvanced: bool,
    lastAppealTargetMatches: bool,
    lastAppealWindowOpen: bool,
  }

  const enforceAuthentication: bool
  const enforceCertificateTime: bool
  const enforceRevisionAdvance: bool
  const enforceAppealTarget: bool
  const enforceAppealDeadline: bool

  pure val Ancestors = Set(A1, A2)
  pure val Decisions = Set(D1, D2, D3, D4)
  pure val Times = Set(T0, T1, T2)

  pure def timeValue(time: Time): int =
    if (time == T0) 0 else if (time == T1) 1 else 2

  var state: State

  /// Begin with two independent eligible ancestors and no accepted decision.
  action init = {
    state' = {
      now: T0,
      status: Ancestors.mapBy(_ => Eligible),
      lifecycle: Ancestors.mapBy(_ => Finalized),
      revision: Ancestors.mapBy(_ => 0),
      decisionCount: Ancestors.mapBy(_ => 0),
      lastDecision: Ancestors.mapBy(_ => D1),
      appealDeadline: Ancestors.mapBy(_ => T0),
      decisionHistory: Set(),
      lineageClean: true,
      appealCount: 0,
      lastCertificateAuthenticated: true,
      lastCertificateTimeValid: true,
      lastRevisionAdvanced: true,
      lastAppealTargetMatches: true,
      lastAppealWindowOpen: true,
    }
  }

  /// Accept one provisional revocation from an external arbiter. A decision ID
  /// is canonical and globally single-use; exact retries use `duplicate`.
  action revoke(
    ancestor: Ancestor,
    decisionId: DecisionId,
    appealDeadline: Time,
    authenticated: bool,
    certificateTimeValid: bool,
    revisionAdvances: bool,
  ): bool = all {
    ancestor.in(Ancestors),
    decisionId.in(Decisions),
    state.status.get(ancestor) == Eligible,
    state.decisionCount.get(ancestor) == 0,
    not(decisionId.in(state.decisionHistory)),
    timeValue(appealDeadline) > timeValue(state.now),
    not(enforceAuthentication) or authenticated,
    not(enforceCertificateTime) or certificateTimeValid,
    not(enforceRevisionAdvance) or revisionAdvances,
    state' = {
      ...state,
      status: state.status.set(ancestor, Revoked),
      lifecycle: state.lifecycle.set(ancestor, AppealOpen),
      revision: state.revision.set(
        ancestor,
        state.revision.get(ancestor) + (if (revisionAdvances) 1 else 0)
      ),
      decisionCount:
        state.decisionCount.set(ancestor, state.decisionCount.get(ancestor) + 1),
      lastDecision: state.lastDecision.set(ancestor, decisionId),
      appealDeadline: state.appealDeadline.set(ancestor, appealDeadline),
      decisionHistory: state.decisionHistory.union(Set(decisionId)),
      lineageClean: false,
      lastCertificateAuthenticated: authenticated,
      lastCertificateTimeValid: certificateTimeValid,
      lastRevisionAdvanced: revisionAdvances,
    },
  }

  /// Finalize an appeal only against the exact current revoke while its window
  /// is open. Other revoked ancestors are intentionally untouched.
  action appeal(
    ancestor: Ancestor,
    appealOf: DecisionId,
    decisionId: DecisionId,
    authenticated: bool,
    certificateTimeValid: bool,
    revisionAdvances: bool,
  ): bool = {
    val targetMatches = appealOf == state.lastDecision.get(ancestor)
    val windowOpen = and {
      state.lifecycle.get(ancestor) == AppealOpen,
      timeValue(state.now) <= timeValue(state.appealDeadline.get(ancestor)),
    }
    val remainingClean = Ancestors.forall(other =>
      other == ancestor or state.status.get(other) == Eligible)
    all {
      ancestor.in(Ancestors),
      decisionId.in(Decisions),
      state.status.get(ancestor) == Revoked,
      state.decisionCount.get(ancestor) == 1,
      not(decisionId.in(state.decisionHistory)),
      not(enforceAuthentication) or authenticated,
      not(enforceCertificateTime) or certificateTimeValid,
      not(enforceRevisionAdvance) or revisionAdvances,
      not(enforceAppealTarget) or targetMatches,
      not(enforceAppealDeadline) or windowOpen,
      state' = {
        ...state,
        status: state.status.set(ancestor, Eligible),
        lifecycle: state.lifecycle.set(ancestor, Finalized),
        revision: state.revision.set(
          ancestor,
          state.revision.get(ancestor) + (if (revisionAdvances) 1 else 0)
        ),
        decisionCount:
          state.decisionCount.set(ancestor, state.decisionCount.get(ancestor) + 1),
        lastDecision: state.lastDecision.set(ancestor, decisionId),
        decisionHistory: state.decisionHistory.union(Set(decisionId)),
        lineageClean: remainingClean,
        appealCount: state.appealCount + 1,
        lastCertificateAuthenticated: authenticated,
        lastCertificateTimeValid: certificateTimeValid,
        lastRevisionAdvanced: revisionAdvances,
        lastAppealTargetMatches: targetMatches,
        lastAppealWindowOpen: windowOpen,
      },
    }
  }

  /// Advance one bounded clock step and materialize every elapsed provisional
  /// revocation as Expired without restoring asset eligibility.
  action advanceTime(nextTime: Time): bool = all {
    nextTime.in(Times),
    timeValue(nextTime) == timeValue(state.now) + 1,
    state' = {
      ...state,
      now: nextTime,
      lifecycle: Ancestors.mapBy(ancestor =>
        if (state.status.get(ancestor) == Revoked and
          state.lifecycle.get(ancestor) == AppealOpen and
          timeValue(nextTime) > timeValue(state.appealDeadline.get(ancestor)))
          Expired
        else state.lifecycle.get(ancestor)),
    },
  }

  /// An exact canonical retry is observable but has no state effect.
  action duplicate(decisionId: DecisionId): bool = all {
    decisionId.in(state.decisionHistory),
    state' = state,
  }

  action revokeSome = {
    nondet ancestor = Ancestors.oneOf()
    nondet decisionId = Decisions.oneOf()
    nondet deadline = Times.oneOf()
    nondet authenticated = Set(true, false).oneOf()
    nondet certificateTimeValid = Set(true, false).oneOf()
    nondet revisionAdvances = Set(true, false).oneOf()
    revoke(
      ancestor,
      decisionId,
      deadline,
      authenticated,
      certificateTimeValid,
      revisionAdvances,
    )
  }

  action appealSome = {
    nondet ancestor = Ancestors.oneOf()
    nondet appealOf = Decisions.oneOf()
    nondet decisionId = Decisions.oneOf()
    nondet authenticated = Set(true, false).oneOf()
    nondet certificateTimeValid = Set(true, false).oneOf()
    nondet revisionAdvances = Set(true, false).oneOf()
    appeal(
      ancestor,
      appealOf,
      decisionId,
      authenticated,
      certificateTimeValid,
      revisionAdvances,
    )
  }

  action advanceTimeSome = {
    nondet nextTime = Times.oneOf()
    advanceTime(nextTime)
  }

  action duplicateSome = {
    nondet decisionId = Decisions.oneOf()
    duplicate(decisionId)
  }

  action step = any {
    revokeSome,
    appealSome,
    advanceTimeSome,
    duplicateSome,
  }

  val typeOk = and {
    state.now.in(Times),
    state.status.keys() == Ancestors,
    state.lifecycle.keys() == Ancestors,
    state.revision.keys() == Ancestors,
    state.decisionCount.keys() == Ancestors,
    state.lastDecision.keys() == Ancestors,
    state.appealDeadline.keys() == Ancestors,
    state.decisionHistory.subseteq(Decisions),
    state.appealCount >= 0,
    state.appealCount <= 2,
    Ancestors.forall(ancestor => and {
      state.revision.get(ancestor) >= 0,
      state.revision.get(ancestor) <= 2,
      state.decisionCount.get(ancestor) >= 0,
      state.decisionCount.get(ancestor) <= 2,
    }),
  }

  val lineageFlagMatchesIndependentHeads =
    state.lineageClean ==
      Ancestors.forall(ancestor => state.status.get(ancestor) == Eligible)

  val lifecycleMatchesStatus = Ancestors.forall(ancestor =>
    if (state.status.get(ancestor) == Eligible)
      state.lifecycle.get(ancestor) == Finalized
    else or {
      state.lifecycle.get(ancestor) == AppealOpen,
      state.lifecycle.get(ancestor) == Expired,
    })

  val acceptedDecisionsAreAuthenticated =
    state.lastCertificateAuthenticated

  val acceptedCertificatesWereTimely =
    state.lastCertificateTimeValid

  val decisionRevisionMatchesHistory = Ancestors.forall(ancestor =>
    state.revision.get(ancestor) == state.decisionCount.get(ancestor))

  val finalizedAppealHasExactTarget =
    state.appealCount > 0 implies state.lastAppealTargetMatches

  val finalizedAppealHadOpenWindow =
    state.appealCount > 0 implies state.lastAppealWindowOpen

  val safety = and {
    typeOk,
    lineageFlagMatchesIndependentHeads,
    lifecycleMatchesStatus,
    acceptedDecisionsAreAuthenticated,
    acceptedCertificatesWereTimely,
    decisionRevisionMatchesHistory,
    finalizedAppealHasExactTarget,
    finalizedAppealHadOpenWindow,
  }
}
