module evidenceResolutionRelayTests {
  import evidenceResolutionRelay(
    enforcePollAuthentication = true,
    persistBeforePublish = true,
    persistRetrySchedule = true,
    enforceAttemptFence = true,
  ).* from "./EvidenceResolutionRelay"

  run crashAfterPublishRetriesTheDurableEnvelope =
    init
      .then(claim)
      .then(acceptPoll(true))
      .then(publish)
      .then(expireLease)
      .then(claim)
      .then(acknowledgePublish(true))
      .expect(state.cursorAdvanced and not(state.pendingEnvelope))

  run failedPollWaitsForDurableBackoff =
    init
      .then(claim)
      .then(failAttempt)
      .expect(state.retryScheduled and not(state.due))
      .then(retryTimer)
      .then(claim)
      .expect(state.currentAttempt == 2)

  run unauthenticatedPollIsRejected =
    init
      .then(claim)
      .then(acceptPoll(false).fail())
}
