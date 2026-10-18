///|
test "worker termination bridge preserves expiry abort and repeated-read guards" {
  assert_true(
    @worker.audit_encounter_termination_allowed(false, false, false, true, 0, 1),
  )
  assert_false(
    @worker.audit_encounter_termination_allowed(false, false, true, false, 0, 1),
  )
  assert_true(
    @worker.audit_encounter_termination_allowed(false, false, true, false, 1, 1),
  )
  assert_false(
    @worker.audit_encounter_termination_allowed(false, false, true, true, 1, 1),
  )
  assert_true(
    @worker.audit_encounter_termination_allowed(false, true, true, true, 0, 1),
  )
  assert_false(
    @worker.audit_encounter_termination_allowed(true, true, false, false, 1, 1),
  )
  assert_false(
    @worker.audit_encounter_termination_allowed(
      false, true, false, false, -1, 1,
    ),
  )
}

///|
test "worker terminal cleanup bridge preserves clock ordering and unresolved holds" {
  assert_true(
    @worker.audit_encounter_terminal_cleanup_allowed(true, 1, 1, false),
  )
  assert_true(
    @worker.audit_encounter_terminal_cleanup_allowed(true, 1, 0, false),
  )
  assert_false(
    @worker.audit_encounter_terminal_cleanup_allowed(true, 0, 1, false),
  )
  assert_false(
    @worker.audit_encounter_terminal_cleanup_allowed(false, 1, 1, false),
  )
  assert_false(
    @worker.audit_encounter_terminal_cleanup_allowed(true, 1, 1, true),
  )
  assert_false(
    @worker.audit_encounter_terminal_cleanup_allowed(true, -1, 1, false),
  )
}
