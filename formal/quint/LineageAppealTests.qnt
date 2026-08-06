module lineageAppealTests {
  import lineageAppeal(
    enforceAuthentication = true,
    enforceCertificateTime = true,
    enforceRevisionAdvance = true,
    enforceAppealTarget = true,
    enforceAppealDeadline = true
  ).* from "./LineageAppeal"

  run provisionalRevokeAppealFinalized =
    init
      .then(revoke(A1, D1, T1, true, true, true))
      .then(appeal(A1, D1, D2, true, true, true))
      .expect(and {
        state.status.get(A1) == Eligible,
        state.lifecycle.get(A1) == Finalized,
        state.revision.get(A1) == 2,
      })

  run expiredAppealIsRejected =
    init
      .then(revoke(A1, D1, T1, true, true, true))
      .then(advanceTime(T1))
      .then(advanceTime(T2))
      .then(appeal(A1, D1, D2, true, true, true).fail())

  run wrongDecisionAppealIsRejected =
    init
      .then(revoke(A1, D1, T2, true, true, true))
      .then(appeal(A1, D3, D2, true, true, true).fail())

  run oneAppealDoesNotClearAnotherRevocation =
    init
      .then(revoke(A1, D1, T2, true, true, true))
      .then(revoke(A2, D2, T2, true, true, true))
      .then(appeal(A1, D1, D3, true, true, true))
      .expect(and {
        state.status.get(A1) == Eligible,
        state.status.get(A2) == Revoked,
        not(state.lineageClean),
      })

  run exactDuplicateIsIdempotent =
    init
      .then(revoke(A1, D1, T2, true, true, true))
      .then(duplicate(D1))
      .expect(and {
        state.revision.get(A1) == 1,
        state.decisionHistory == Set(D1),
      })

  run conflictingDecisionIdIsRejected =
    init
      .then(revoke(A1, D1, T2, true, true, true))
      .then(revoke(A2, D1, T2, true, true, true).fail())
}
