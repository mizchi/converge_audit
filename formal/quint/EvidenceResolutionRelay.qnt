// Crash-safe source-side relay for authenticated case-resolution notices.
//
// Concrete signatures, HTTP, SQLite, and time are abstracted to booleans. The
// load-bearing ordering is claim -> authenticated poll -> persist exact source
// envelope -> publish -> cursor acknowledgement. A durable retry schedule and
// attempt fence prevent crash recovery from losing or stale-completing work.
module evidenceResolutionRelay {
  type State = {
    due: bool,
    leaseActive: bool,
    currentAttempt: int,
    pollAccepted: bool,
    lastPollAuthenticated: bool,
    pendingEnvelope: bool,
    authorityPublished: bool,
    cursorAdvanced: bool,
    failureOutstanding: bool,
    retryScheduled: bool,
    lastCompletionAttemptExact: bool,
  }

  const enforcePollAuthentication: bool
  const persistBeforePublish: bool
  const persistRetrySchedule: bool
  const enforceAttemptFence: bool
  var state: State

  action init = {
    state' = {
      due: true,
      leaseActive: false,
      currentAttempt: 0,
      pollAccepted: false,
      lastPollAuthenticated: true,
      pendingEnvelope: false,
      authorityPublished: false,
      cursorAdvanced: false,
      failureOutstanding: false,
      retryScheduled: false,
      lastCompletionAttemptExact: true,
    }
  }

  action claim = all {
    state.due,
    not(state.leaseActive),
    not(state.cursorAdvanced),
    state.currentAttempt < 3,
    state' = {
      ...state,
      due: false,
      leaseActive: true,
      currentAttempt: state.currentAttempt + 1,
    },
  }

  action acceptPoll(authenticated: bool): bool = all {
    state.leaseActive,
    not(state.pollAccepted),
    not(enforcePollAuthentication) or authenticated,
    state' = {
      ...state,
      pollAccepted: true,
      lastPollAuthenticated: authenticated,
      pendingEnvelope: persistBeforePublish,
    },
  }

  action publish = all {
    state.leaseActive,
    state.pollAccepted,
    not(state.authorityPublished),
    state' = { ...state, authorityPublished: true },
  }

  action failAttempt = all {
    state.leaseActive,
    not(state.cursorAdvanced),
    state' = {
      ...state,
      leaseActive: false,
      failureOutstanding: true,
      retryScheduled: persistRetrySchedule,
    },
  }

  /// The process may disappear while SQLite retains the lease and pending row.
  /// Lease expiry, not volatile process memory, makes the work claimable again.
  action expireLease = all {
    state.leaseActive,
    not(state.cursorAdvanced),
    state' = { ...state, leaseActive: false, due: true },
  }

  action retryTimer = all {
    state.retryScheduled,
    not(state.leaseActive),
    state' = {
      ...state,
      due: true,
      failureOutstanding: false,
      retryScheduled: false,
    },
  }

  action acknowledgePublish(exactAttempt: bool): bool = all {
    state.leaseActive,
    state.authorityPublished,
    state.pendingEnvelope,
    not(enforceAttemptFence) or exactAttempt,
    state' = {
      ...state,
      leaseActive: false,
      cursorAdvanced: true,
      pendingEnvelope: false,
      lastCompletionAttemptExact: exactAttempt,
    },
  }

  action acceptSomePoll = {
    nondet authenticated = Set(true, false).oneOf()
    acceptPoll(authenticated)
  }

  action acknowledgeSomePublish = {
    nondet exactAttempt = Set(true, false).oneOf()
    acknowledgePublish(exactAttempt)
  }

  action step = any {
    claim,
    acceptSomePoll,
    publish,
    failAttempt,
    expireLease,
    retryTimer,
    acknowledgeSomePublish,
  }

  val typeOk = and {
    state.currentAttempt >= 0,
    state.currentAttempt <= 3,
    state.cursorAdvanced implies state.authorityPublished,
  }

  val acceptedPollRequiresCredential =
    state.pollAccepted implies state.lastPollAuthenticated

  val publishedBeforeCursorAckIsDurable =
    state.authorityPublished and not(state.cursorAdvanced) implies
      state.pendingEnvelope

  val failedAttemptHasDurableRetry =
    state.failureOutstanding implies state.retryScheduled

  val cursorAdvanceUsesCurrentLeaseAttempt =
    state.cursorAdvanced implies state.lastCompletionAttemptExact
}
