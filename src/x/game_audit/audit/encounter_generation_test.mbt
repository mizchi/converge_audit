///|
test "generation roll requires matching expected generation and advance capacity" {
  assert_true(@audit.encounter_generation_roll_allowed(true, true, true, true))
  assert_false(
    @audit.encounter_generation_roll_allowed(false, true, true, true),
  )
  assert_false(
    @audit.encounter_generation_roll_allowed(true, false, true, true),
  )
}

///|
test "generation roll refuses remaining terminal records or unreleased archives" {
  assert_false(
    @audit.encounter_generation_roll_allowed(true, true, false, true),
  )
  assert_false(
    @audit.encounter_generation_roll_allowed(true, true, true, false),
  )
  assert_false(
    @audit.encounter_generation_roll_allowed(true, true, false, false),
  )
}

///|
test "generation roll admits exactly one of all sixteen fact combinations" {
  let cases = [
    (false, false, false, false, false),
    (false, false, false, true, false),
    (false, false, true, false, false),
    (false, false, true, true, false),
    (false, true, false, false, false),
    (false, true, false, true, false),
    (false, true, true, false, false),
    (false, true, true, true, false),
    (true, false, false, false, false),
    (true, false, false, true, false),
    (true, false, true, false, false),
    (true, false, true, true, false),
    (true, true, false, false, false),
    (true, true, false, true, false),
    (true, true, true, false, false),
    (true, true, true, true, true),
  ]
  for
    (expected_matches, can_advance, terminal_retired, archive_released, expected
    ) in cases {
    assert_eq(
      @audit.encounter_generation_roll_allowed(
        expected_matches, can_advance, terminal_retired, archive_released,
      ),
      expected,
    )
  }
}
