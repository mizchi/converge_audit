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

///|
test "evidence lineage cases require an authenticated active exact binding" {
  inspect(
    evidence_lineage_case_admission_allowed(true, true, true, true, true, true),
    content="true",
  )
  inspect(
    evidence_lineage_case_admission_allowed(false, true, true, true, true, true),
    content="false",
  )
  inspect(
    evidence_lineage_case_admission_allowed(true, true, true, false, true, true),
    content="false",
  )
  inspect(
    evidence_lineage_case_admission_allowed(true, true, true, true, true, false),
    content="false",
  )
}

///|
test "evidence case decisions require an open exact-bound case and certificate" {
  inspect(
    evidence_lineage_case_decision_allowed(true, true, true, true),
    content="true",
  )
  inspect(
    evidence_lineage_case_decision_allowed(false, true, true, true),
    content="false",
  )
  inspect(
    evidence_lineage_case_decision_allowed(true, true, false, true),
    content="false",
  )
  inspect(
    evidence_lineage_case_decision_allowed(true, true, true, false),
    content="false",
  )
}

///|
test "evidence case dismissal closes only an exact open case" {
  inspect(
    evidence_lineage_case_dismissal_allowed(true, true, true, true),
    content="true",
  )
  inspect(
    evidence_lineage_case_dismissal_allowed(false, true, true, true),
    content="false",
  )
  inspect(
    evidence_lineage_case_dismissal_allowed(true, false, true, true),
    content="false",
  )
  inspect(
    evidence_lineage_case_dismissal_allowed(true, true, false, true),
    content="false",
  )
  inspect(
    evidence_lineage_case_dismissal_allowed(true, true, true, false),
    content="false",
  )
}

///|
test "source resolution requires a resolved exact case and next authenticated cursor" {
  inspect(
    evidence_case_source_resolution_allowed(true, true, true, true),
    content="true",
  )
  inspect(
    evidence_case_source_resolution_allowed(false, true, true, true),
    content="false",
  )
  inspect(
    evidence_case_source_resolution_allowed(true, false, true, true),
    content="false",
  )
  inspect(
    evidence_case_source_resolution_allowed(true, true, false, true),
    content="false",
  )
  inspect(
    evidence_case_source_resolution_allowed(true, true, true, false),
    content="false",
  )
}
