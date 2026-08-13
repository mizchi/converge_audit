// Dual-reader migration from legacy source signatures to key-bound auth.
//
// Historical v1 messages remain readable only before an explicit cutoff.
// Every new writer emits v2. V2 admission requires both retained key history
// and exact purpose/scope/unit/subject/digest binding.
module keyAuthenticationMigration {
  type AuthVersion = LegacyV1 | KeyBoundV2
  type MigrationTime = BeforeCutoff | AtOrAfterCutoff

  type State = {
    now: MigrationTime,
    writes: int,
    accepts: int,
    lastWriterUsedKeyBound: bool,
    lastAcceptedLegacyBeforeCutoff: bool,
    lastAcceptedKeyBoundValid: bool,
  }

  const writerUsesKeyBound: bool
  const enforceLegacyCutoff: bool
  const enforceKeyBoundHistory: bool
  const enforceKeyBoundBinding: bool

  var state: State

  action init = {
    state' = {
      now: BeforeCutoff,
      writes: 0,
      accepts: 0,
      lastWriterUsedKeyBound: true,
      lastAcceptedLegacyBeforeCutoff: true,
      lastAcceptedKeyBoundValid: true,
    }
  }

  action advanceToCutoff: bool = all {
    state.now == BeforeCutoff,
    state' = { ...state, now: AtOrAfterCutoff },
  }

  action write: bool = {
    val version = if (writerUsesKeyBound) KeyBoundV2 else LegacyV1
    all {
      state.writes < 1,
      state' = {
        ...state,
        writes: state.writes + 1,
        lastWriterUsedKeyBound: version == KeyBoundV2,
      },
    }
  }

  action receive(
    version: AuthVersion,
    historyAvailable: bool,
    exactBinding: bool,
  ): bool = {
    val legacyBeforeCutoff = state.now == BeforeCutoff
    val keyBoundValid = historyAvailable and exactBinding
    all {
      state.accepts < 1,
      version == LegacyV1
        implies (not(enforceLegacyCutoff) or legacyBeforeCutoff),
      version == KeyBoundV2
        implies (not(enforceKeyBoundHistory) or historyAvailable),
      version == KeyBoundV2
        implies (not(enforceKeyBoundBinding) or exactBinding),
      state' = {
        ...state,
        accepts: state.accepts + 1,
        lastAcceptedLegacyBeforeCutoff:
          version != LegacyV1 or legacyBeforeCutoff,
        lastAcceptedKeyBoundValid:
          version != KeyBoundV2 or keyBoundValid,
      },
    }
  }

  action receiveSome = {
    nondet version = Set(LegacyV1, KeyBoundV2).oneOf()
    nondet historyAvailable = Set(true, false).oneOf()
    nondet exactBinding = Set(true, false).oneOf()
    receive(version, historyAvailable, exactBinding)
  }

  action step = any {
    advanceToCutoff,
    write,
    receiveSome,
  }

  val typeOk = and {
    state.writes >= 0 and state.writes <= 1,
    state.accepts >= 0 and state.accepts <= 1,
  }

  val newWriterNeverEmitsLegacy = state.lastWriterUsedKeyBound

  val acceptedLegacyPredatesCutoff =
    state.lastAcceptedLegacyBeforeCutoff

  val acceptedKeyBoundHasHistoryAndExactBinding =
    state.lastAcceptedKeyBoundValid
}
