///|
test "encounter commitment requires a fresh slot strictly before release" {
  assert_true(@audit.encounter_commit_allowed(true, 0, 1))
  assert_true(@audit.encounter_commit_allowed(true, 9, 10))
  assert_false(@audit.encounter_commit_allowed(false, 9, 10))
  assert_false(@audit.encounter_commit_allowed(true, 10, 10))
  assert_false(@audit.encounter_commit_allowed(true, 11, 10))
}

///|
test "encounter commitment refuses negative clock values" {
  assert_false(@audit.encounter_commit_allowed(true, -1, 10))
  assert_false(@audit.encounter_commit_allowed(true, 0, -1))
  assert_false(@audit.encounter_commit_allowed(true, -2, -1))
}

///|
test "encounter reveal opens at release after a strictly earlier commitment" {
  assert_true(@audit.encounter_reveal_allowed(0, 1, 1))
  assert_true(@audit.encounter_reveal_allowed(9, 10, 10))
  assert_true(@audit.encounter_reveal_allowed(9, 10, 11))
  assert_false(@audit.encounter_reveal_allowed(9, 10, 9))
  assert_false(@audit.encounter_reveal_allowed(10, 10, 10))
  assert_false(@audit.encounter_reveal_allowed(11, 10, 12))
}

///|
test "encounter reveal refuses negative commitment and clock values" {
  assert_false(@audit.encounter_reveal_allowed(-1, 10, 10))
  assert_false(@audit.encounter_reveal_allowed(-2, -1, 0))
  assert_false(@audit.encounter_reveal_allowed(0, 1, -1))
  assert_false(@audit.encounter_reveal_allowed(0, -1, 1))
}

///|
test "encounter consumption requires revealed unused verified matching evidence" {
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
    (true, false, true, true, true),
    (true, true, false, false, false),
    (true, true, false, true, false),
    (true, true, true, false, false),
    (true, true, true, true, false),
  ]
  for (revealed, consumed, replay_verified, root_matches, expected) in cases {
    assert_eq(
      @audit.encounter_consume_allowed(
        revealed, consumed, replay_verified, root_matches,
      ),
      expected,
    )
  }
}

///|
test "encounter retention release requires settlement deadline and no hold" {
  assert_true(@audit.encounter_retention_release_allowed(true, 10, 10, false))
  assert_true(@audit.encounter_retention_release_allowed(true, 10, 11, false))
  assert_true(@audit.encounter_retention_release_allowed(true, 0, 0, false))
  assert_false(@audit.encounter_retention_release_allowed(true, 10, 9, false))
  assert_false(@audit.encounter_retention_release_allowed(false, 10, 10, false))
  assert_false(@audit.encounter_retention_release_allowed(true, 10, 10, true))
}

///|
test "encounter retention release refuses negative clock values" {
  assert_false(@audit.encounter_retention_release_allowed(true, -1, 10, false))
  assert_false(@audit.encounter_retention_release_allowed(true, 0, -1, false))
  assert_false(@audit.encounter_retention_release_allowed(true, -2, -1, false))
}

///|
test "encounter chronology compares Int boundary clocks without arithmetic overflow" {
  assert_true(@audit.encounter_commit_allowed(true, 2147483646, 2147483647))
  assert_false(@audit.encounter_commit_allowed(true, 2147483647, 2147483647))
  assert_false(@audit.encounter_commit_allowed(true, -2147483648, 2147483647))
  assert_true(
    @audit.encounter_reveal_allowed(2147483646, 2147483647, 2147483647),
  )
  assert_false(@audit.encounter_reveal_allowed(-2147483648, 0, 2147483647))
  assert_true(
    @audit.encounter_retention_release_allowed(
      true, 2147483647, 2147483647, false,
    ),
  )
  assert_false(
    @audit.encounter_retention_release_allowed(
      true, 2147483647, 2147483646, false,
    ),
  )
  assert_false(
    @audit.encounter_retention_release_allowed(
      true, -2147483648, 2147483647, false,
    ),
  )
}
