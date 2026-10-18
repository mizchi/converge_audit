///|
test "unsettled encounter abort is permitted with or without a commitment" {
  assert_true(
    @audit.encounter_termination_allowed(false, false, false, false, 4, 5),
  )
  assert_true(
    @audit.encounter_termination_allowed(false, false, false, true, 4, 5),
  )
  assert_true(
    @audit.encounter_termination_allowed(false, false, false, true, 0, 0),
  )
  assert_false(
    @audit.encounter_termination_allowed(true, false, false, false, 4, 5),
  )
}

///|
test "new encounter expiration requires an absent commitment and elapsed deadline" {
  assert_false(
    @audit.encounter_termination_allowed(false, false, true, false, 4, 5),
  )
  assert_true(
    @audit.encounter_termination_allowed(false, false, true, false, 5, 5),
  )
  assert_true(
    @audit.encounter_termination_allowed(false, false, true, false, 6, 5),
  )
  assert_false(
    @audit.encounter_termination_allowed(false, false, true, true, 5, 5),
  )
  assert_false(
    @audit.encounter_termination_allowed(false, false, true, true, 6, 5),
  )
}

///|
test "already terminated encounters permit idempotent reads but settled conflicts fail" {
  assert_true(
    @audit.encounter_termination_allowed(false, true, true, true, 4, 5),
  )
  assert_true(
    @audit.encounter_termination_allowed(false, true, true, false, 4, 5),
  )
  assert_true(
    @audit.encounter_termination_allowed(false, true, false, true, 4, 5),
  )
  assert_false(
    @audit.encounter_termination_allowed(true, true, true, true, 6, 5),
  )
  assert_false(
    @audit.encounter_termination_allowed(true, true, false, false, 6, 5),
  )
}

///|
test "termination state combinations preserve settlement and expiration precedence" {
  for settled in [false, true] {
    for terminated in [false, true] {
      for expire in [false, true] {
        for committed in [false, true] {
          for now in [4, 5] {
            let expected = if settled {
              false
            } else if terminated {
              true
            } else if expire {
              !committed && now == 5
            } else {
              true
            }
            assert_eq(
              @audit.encounter_termination_allowed(
                settled, terminated, expire, committed, now, 5,
              ),
              expected,
            )
          }
        }
      }
    }
  }
}

///|
test "invalid termination clocks cannot be bypassed by aborts or terminal reads" {
  for (now, deadline) in [(-1, 5), (0, -1), (-2, -1)] {
    for terminated in [false, true] {
      for expire in [false, true] {
        for committed in [false, true] {
          assert_false(
            @audit.encounter_termination_allowed(
              false, terminated, expire, committed, now, deadline,
            ),
          )
        }
      }
    }
  }
}

///|
test "terminal cleanup waits for retention and refuses unresolved references" {
  assert_true(@audit.encounter_terminal_cleanup_allowed(true, 10, 10, false))
  assert_true(@audit.encounter_terminal_cleanup_allowed(true, 11, 10, false))
  assert_true(@audit.encounter_terminal_cleanup_allowed(true, 0, 0, false))
  assert_false(@audit.encounter_terminal_cleanup_allowed(true, 9, 10, false))
  assert_false(@audit.encounter_terminal_cleanup_allowed(false, 10, 10, false))
  assert_false(@audit.encounter_terminal_cleanup_allowed(true, 10, 10, true))
}

///|
test "terminal cleanup refuses negative clock values" {
  assert_false(@audit.encounter_terminal_cleanup_allowed(true, -1, 10, false))
  assert_false(@audit.encounter_terminal_cleanup_allowed(true, 10, -1, false))
  assert_false(@audit.encounter_terminal_cleanup_allowed(true, -1, -2, false))
}

///|
test "termination and terminal cleanup compare Int limits without arithmetic" {
  assert_true(
    @audit.encounter_termination_allowed(
      false, false, true, false, 2147483647, 2147483647,
    ),
  )
  assert_false(
    @audit.encounter_termination_allowed(
      false, false, true, false, 2147483646, 2147483647,
    ),
  )
  assert_false(
    @audit.encounter_termination_allowed(
      false, true, false, true, -2147483648, 2147483647,
    ),
  )
  assert_false(
    @audit.encounter_termination_allowed(
      false, true, false, true, 2147483647, -2147483648,
    ),
  )
  assert_true(
    @audit.encounter_terminal_cleanup_allowed(
      true, 2147483647, 2147483647, false,
    ),
  )
  assert_false(
    @audit.encounter_terminal_cleanup_allowed(
      true, 2147483646, 2147483647, false,
    ),
  )
  assert_false(
    @audit.encounter_terminal_cleanup_allowed(
      true, -2147483648, 2147483647, false,
    ),
  )
  assert_false(
    @audit.encounter_terminal_cleanup_allowed(
      true, 2147483647, -2147483648, false,
    ),
  )
}
