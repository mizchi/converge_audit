module keyLifecycleTests {
  import keyLifecycle(
    enforceExactKeyBinding = true,
    enforceIssuanceValidity = true,
    enforceEffectiveRevocation = true,
    retainHistoricalKeys = true
  ).* from "./KeyLifecycle"

  run oldCheckpointVerifiesAfterRotation =
    init
      .then(rotate)
      .then(verify(OldCheckpoint))
      .expect(OldCheckpoint.in(state.accepted))

  run oldCheckpointBeforeRevocationStillVerifies =
    init
      .then(rotate)
      .then(revokeOldKey)
      .then(verify(OldCheckpoint))
      .expect(OldCheckpoint.in(state.accepted))

  run compromisedCheckpointAtRevocationBoundaryIsRejected =
    init
      .then(rotate)
      .then(revokeOldKey)
      .then(verify(CompromisedCheckpoint).fail())

  run substitutedKeyVersionIsRejected =
    init.then(verify(SubstitutedCheckpoint).fail())

  run expiredSigningTimeIsRejected =
    init
      .then(rotate)
      .then(verify(ExpiredCheckpoint).fail())

  run currentKeyCheckpointIsAccepted =
    init
      .then(rotate)
      .then(verify(CurrentCheckpoint))
      .expect(CurrentCheckpoint.in(state.accepted))
}

module keyLifecycleHistoryRetentionTests {
  import keyLifecycle(
    enforceExactKeyBinding = true,
    enforceIssuanceValidity = true,
    enforceEffectiveRevocation = true,
    retainHistoricalKeys = false
  ).* from "./KeyLifecycle"

  run droppingOldKeyMakesHistoricalVerificationUnavailable =
    init
      .then(rotate)
      .then(verify(OldCheckpoint).fail())
}
