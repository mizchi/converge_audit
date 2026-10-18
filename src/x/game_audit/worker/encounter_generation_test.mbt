///|
test "worker generation roll bridge preserves every required fact" {
  assert_true(
    @worker.audit_encounter_generation_roll_allowed(true, true, true, true),
  )
  assert_false(
    @worker.audit_encounter_generation_roll_allowed(false, true, true, true),
  )
  assert_false(
    @worker.audit_encounter_generation_roll_allowed(true, false, true, true),
  )
  assert_false(
    @worker.audit_encounter_generation_roll_allowed(true, true, false, true),
  )
  assert_false(
    @worker.audit_encounter_generation_roll_allowed(true, true, true, false),
  )
}
