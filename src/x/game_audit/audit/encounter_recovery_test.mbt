///|
test "recovery release requires forfeiture elapsed retention clear holds and no assets" {
  assert_true(@audit.encounter_recovery_release_allowed(true, true, true, true))
  assert_false(
    @audit.encounter_recovery_release_allowed(false, true, true, true),
  )
  assert_false(
    @audit.encounter_recovery_release_allowed(true, false, true, true),
  )
  assert_false(
    @audit.encounter_recovery_release_allowed(true, true, false, true),
  )
  assert_false(
    @audit.encounter_recovery_release_allowed(true, true, true, false),
  )
}

///|
test "released recovery still needs owner abandonment and an old generation to forget" {
  assert_true(@audit.encounter_recovery_release_allowed(true, true, true, true))
  assert_true(
    @audit.encounter_recovery_forget_allowed(true, true, true, true, true, true),
  )
  assert_false(
    @audit.encounter_recovery_forget_allowed(
      true, true, true, true, false, true,
    ),
  )
  assert_false(
    @audit.encounter_recovery_forget_allowed(
      true, true, true, true, true, false,
    ),
  )
  assert_false(
    @audit.encounter_recovery_forget_allowed(
      true, true, true, false, true, true,
    ),
  )
}

///|
test "recovery release admits exactly one of all sixteen fact combinations" {
  for mask in 0..<16 {
    assert_eq(
      @audit.encounter_recovery_release_allowed(
        (mask & 1) != 0,
        (mask & 2) != 0,
        (mask & 4) != 0,
        (mask & 8) != 0,
      ),
      mask == 15,
    )
  }
}

///|
test "recovery forget admits exactly one of all sixty four fact combinations" {
  for mask in 0..<64 {
    assert_eq(
      @audit.encounter_recovery_forget_allowed(
        (mask & 1) != 0,
        (mask & 2) != 0,
        (mask & 4) != 0,
        (mask & 8) != 0,
        (mask & 16) != 0,
        (mask & 32) != 0,
      ),
      mask == 63,
    )
  }
}
