///|
test "observer signs only a new valid plan-slot target" {
  assert_eq(
    @audit.classify_open_world_observer_signing(
      target_valid=true,
      previous_observation_present=false,
      previous_digest_matches=false,
    ),
    @audit.OpenWorldObserverSigningDecision::SignNewObservation,
  )
}

///|
test "same observer registration is an idempotent retry" {
  assert_eq(
    @audit.classify_open_world_observer_signing(
      target_valid=true,
      previous_observation_present=true,
      previous_digest_matches=true,
    ),
    @audit.OpenWorldObserverSigningDecision::ReuseExistingObservation,
  )
}

///|
test "conflicting digest for one plan-slot is never signed" {
  assert_eq(
    @audit.classify_open_world_observer_signing(
      target_valid=true,
      previous_observation_present=true,
      previous_digest_matches=false,
    ),
    @audit.OpenWorldObserverSigningDecision::RejectConflictingObservation,
  )
}

///|
test "invalid observer signing target fails closed" {
  for previous_present in [false, true] {
    for previous_matches in [false, true] {
      assert_eq(
        @audit.classify_open_world_observer_signing(
          target_valid=false,
          previous_observation_present=previous_present,
          previous_digest_matches=previous_matches,
        ),
        @audit.OpenWorldObserverSigningDecision::RejectInvalidObservation,
      )
    }
  }
}
