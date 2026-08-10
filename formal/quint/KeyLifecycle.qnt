// Historical verification-key lifecycle for signed checkpoints.
//
// Signature bytes are abstracted to the exact declared/actual key relation.
// The model checks rotation history, issuance-time validity, and an effective
// revocation boundary independently from wall-clock verification time.
module keyLifecycle {
  type KeyVersion = KeyV1 | KeyV2
  type Checkpoint =
    | OldCheckpoint
    | CurrentCheckpoint
    | SubstitutedCheckpoint
    | ExpiredCheckpoint
    | CompromisedCheckpoint
  type Time = T0 | T1 | T2 | T3

  type State = {
    now: Time,
    currentKey: KeyVersion,
    verificationKeys: Set[KeyVersion],
    revokedKeys: Set[KeyVersion],
    revokedFrom: KeyVersion -> Time,
    accepted: Set[Checkpoint],
    lastAcceptedExactBinding: bool,
    lastAcceptedIssuanceValid: bool,
    lastAcceptedBeforeRevocation: bool,
  }

  const enforceExactKeyBinding: bool
  const enforceIssuanceValidity: bool
  const enforceEffectiveRevocation: bool
  const retainHistoricalKeys: bool

  pure val Keys = Set(KeyV1, KeyV2)
  pure val Checkpoints = Set(
    OldCheckpoint,
    CurrentCheckpoint,
    SubstitutedCheckpoint,
    ExpiredCheckpoint,
    CompromisedCheckpoint
  )
  pure val Times = Set(T0, T1, T2, T3)

  pure def timeValue(time: Time): int =
    if (time == T0) 0
    else if (time == T1) 1
    else if (time == T2) 2
    else 3

  pure def declaredKey(checkpoint: Checkpoint): KeyVersion =
    if (checkpoint == CurrentCheckpoint) KeyV2 else KeyV1

  pure def actualSigningKey(checkpoint: Checkpoint): KeyVersion =
    if (checkpoint == SubstitutedCheckpoint) KeyV2
    else if (checkpoint == CurrentCheckpoint) KeyV2
    else KeyV1

  pure def issuedAt(checkpoint: Checkpoint): Time =
    if (checkpoint == OldCheckpoint) T0
    else if (checkpoint == SubstitutedCheckpoint) T0
    else if (checkpoint == CompromisedCheckpoint) T1
    else T2

  pure def keyValidFrom(key: KeyVersion): int =
    if (key == KeyV1) 0 else 2

  pure def keyValidUntil(key: KeyVersion): int =
    if (key == KeyV1) 2 else 4

  var state: State

  action init = {
    state' = {
      now: T0,
      currentKey: KeyV1,
      verificationKeys: Set(KeyV1),
      revokedKeys: Set(),
      revokedFrom: Keys.mapBy(_ => T3),
      accepted: Set(),
      lastAcceptedExactBinding: true,
      lastAcceptedIssuanceValid: true,
      lastAcceptedBeforeRevocation: true,
    }
  }

  def exactKeyBinding(checkpoint: Checkpoint): bool =
    declaredKey(checkpoint) == actualSigningKey(checkpoint)

  def issuanceValid(checkpoint: Checkpoint): bool = {
    val key = declaredKey(checkpoint)
    val issued = timeValue(issuedAt(checkpoint))
    and {
      issued >= keyValidFrom(key),
      issued < keyValidUntil(key),
      issued <= timeValue(state.now),
    }
  }

  def beforeEffectiveRevocation(checkpoint: Checkpoint): bool = {
    val key = declaredKey(checkpoint)
    not(key.in(state.revokedKeys)) or
      timeValue(issuedAt(checkpoint)) < timeValue(state.revokedFrom.get(key))
  }

  /// Routine rotation keeps the old verification record while selecting V2
  /// for new signatures. The broken retention configuration drops V1.
  action rotate: bool = all {
    state.currentKey == KeyV1,
    state.now == T0,
    state' = {
      ...state,
      now: T2,
      currentKey: KeyV2,
      verificationKeys:
        if (retainHistoricalKeys) Set(KeyV1, KeyV2) else Set(KeyV2),
    },
  }

  /// An incident may choose an effective revocation time earlier than its
  /// publication. Here V1 is invalid from T1 while its T0 checkpoint remains
  /// historically valid.
  action revokeOldKey: bool = all {
    state.currentKey == KeyV2,
    state.accepted.size() == 0,
    KeyV1.in(state.verificationKeys),
    state' = {
      ...state,
      revokedKeys: state.revokedKeys.union(Set(KeyV1)),
      revokedFrom: state.revokedFrom.set(KeyV1, T1),
    },
  }

  action verify(checkpoint: Checkpoint): bool = {
    val exact = exactKeyBinding(checkpoint)
    val timely = issuanceValid(checkpoint)
    val beforeRevocation = beforeEffectiveRevocation(checkpoint)
    all {
      checkpoint.in(Checkpoints),
      declaredKey(checkpoint).in(state.verificationKeys),
      not(enforceExactKeyBinding) or exact,
      not(enforceIssuanceValidity) or timely,
      not(enforceEffectiveRevocation) or beforeRevocation,
      state' = {
        ...state,
        accepted: state.accepted.union(Set(checkpoint)),
        lastAcceptedExactBinding: exact,
        lastAcceptedIssuanceValid: timely,
        lastAcceptedBeforeRevocation: beforeRevocation,
      },
    }
  }

  action verifySome = {
    nondet checkpoint = Checkpoints.oneOf()
    verify(checkpoint)
  }

  action step = any {
    rotate,
    revokeOldKey,
    verifySome,
  }

  val typeOk = and {
    state.now.in(Times),
    state.currentKey.in(Keys),
    state.verificationKeys.subseteq(Keys),
    state.revokedKeys.subseteq(Keys),
    state.revokedFrom.keys() == Keys,
    state.accepted.subseteq(Checkpoints),
  }

  val acceptedCheckpointHasExactKeyBinding =
    state.lastAcceptedExactBinding

  val acceptedCheckpointWasIssuedInKeyWindow =
    state.lastAcceptedIssuanceValid

  val acceptedCheckpointPredatesEffectiveRevocation =
    state.lastAcceptedBeforeRevocation

  val safety = and {
    typeOk,
    acceptedCheckpointHasExactKeyBinding,
    acceptedCheckpointWasIssuedInKeyWindow,
    acceptedCheckpointPredatesEffectiveRevocation,
  }
}
