///|
test "player-local pruning accepts only the next acknowledged expired epoch" {
  inspect(
    player_local_checkpoint_prunable(0, -1, 1, true, false),
    content="true",
  )
  inspect(
    player_local_checkpoint_prunable(1, -1, 2, true, false),
    content="false",
  )
  inspect(
    player_local_checkpoint_prunable(0, -1, 1, false, false),
    content="false",
  )
  inspect(
    player_local_checkpoint_prunable(0, -1, 1, true, true),
    content="false",
  )
}

///|
test "evidence hold admission requires authentication and exact bindings" {
  inspect(
    player_local_evidence_hold_admission_allowed(true, true, true),
    content="true",
  )
  inspect(
    player_local_evidence_hold_admission_allowed(true, true, false),
    content="false",
  )
  inspect(
    player_local_evidence_hold_admission_allowed(false, true, true),
    content="false",
  )
}

///|
test "evidence hold resolution requires an active exactly bound hold" {
  inspect(
    player_local_evidence_hold_resolution_allowed(
      true, true, true, true, true, true,
    ),
    content="true",
  )
  inspect(
    player_local_evidence_hold_resolution_allowed(
      true, true, true, true, false, true,
    ),
    content="false",
  )
  inspect(
    player_local_evidence_hold_resolution_allowed(
      true, true, true, true, true, false,
    ),
    content="false",
  )
}
