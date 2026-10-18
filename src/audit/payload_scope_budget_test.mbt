///|
test "payload scope registration admits empty and partly occupied pools" {
  assert_true(@audit.player_local_payload_scope_registration_allowed(0, 1))
  assert_true(@audit.player_local_payload_scope_registration_allowed(0, 2))
  assert_true(@audit.player_local_payload_scope_registration_allowed(1, 2))
}

///|
test "payload scope registration refuses full and overfull metadata pools" {
  assert_false(@audit.player_local_payload_scope_registration_allowed(1, 1))
  assert_false(@audit.player_local_payload_scope_registration_allowed(2, 1))
  assert_false(@audit.player_local_payload_scope_registration_allowed(2, 2))
}

///|
test "payload scope registration refuses negative counts and nonpositive caps" {
  assert_false(@audit.player_local_payload_scope_registration_allowed(-1, 1))
  assert_false(@audit.player_local_payload_scope_registration_allowed(0, 0))
  assert_false(@audit.player_local_payload_scope_registration_allowed(0, -1))
  assert_false(@audit.player_local_payload_scope_registration_allowed(-2, -1))
}

///|
test "payload scope registration handles Int limits without incrementing" {
  assert_true(
    @audit.player_local_payload_scope_registration_allowed(0, 2147483647),
  )
  assert_true(
    @audit.player_local_payload_scope_registration_allowed(
      2147483646, 2147483647,
    ),
  )
  assert_false(
    @audit.player_local_payload_scope_registration_allowed(
      2147483647, 2147483647,
    ),
  )
  assert_false(
    @audit.player_local_payload_scope_registration_allowed(
      -2147483648, 2147483647,
    ),
  )
  assert_false(
    @audit.player_local_payload_scope_registration_allowed(0, -2147483648),
  )
}
