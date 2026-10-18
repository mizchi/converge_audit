///|
test "bulk payload reservation admits only within both remaining budgets" {
  assert_true(
    @audit.player_local_payload_reservation_allowed(10, 2, 5, 1, 3, 2, 20, 5, 2),
  )
  assert_false(
    @audit.player_local_payload_reservation_allowed(10, 2, 5, 1, 4, 2, 20, 5, 2),
  )
  assert_false(
    @audit.player_local_payload_reservation_allowed(10, 2, 5, 1, 3, 3, 20, 5, 2),
  )
}

///|
test "bulk payload reservation rejects every negative field and empty demand" {
  let valid = [4, 1, 2, 1, 2, 1, 10, 4, 1]
  for index in 0..<valid.length() {
    let invalid = valid.copy()
    invalid[index] = -1
    assert_false(
      @audit.player_local_payload_reservation_allowed(
        invalid[0],
        invalid[1],
        invalid[2],
        invalid[3],
        invalid[4],
        invalid[5],
        invalid[6],
        invalid[7],
        invalid[8],
      ),
    )
  }
  for index in [4, 5] {
    let invalid = valid.copy()
    invalid[index] = 0
    assert_false(
      @audit.player_local_payload_reservation_allowed(
        invalid[0],
        invalid[1],
        invalid[2],
        invalid[3],
        invalid[4],
        invalid[5],
        invalid[6],
        invalid[7],
        invalid[8],
      ),
    )
  }
}

///|
test "overcommitted used or reserved counters cannot create more reservations" {
  assert_false(
    @audit.player_local_payload_reservation_allowed(9, 0, 0, 0, 1, 1, 10, 2, 2),
  )
  assert_false(
    @audit.player_local_payload_reservation_allowed(0, 3, 0, 0, 1, 1, 10, 2, 0),
  )
  assert_false(
    @audit.player_local_payload_reservation_allowed(4, 0, 5, 0, 1, 1, 10, 2, 2),
  )
  assert_false(
    @audit.player_local_payload_reservation_allowed(0, 1, 0, 2, 1, 1, 10, 2, 0),
  )
}

///|
test "bulk payload reservation preserves control headroom" {
  assert_true(
    @audit.player_local_payload_reservation_allowed(0, 0, 0, 0, 1, 1, 1, 1, 0),
  )
  assert_false(
    @audit.player_local_payload_reservation_allowed(0, 0, 0, 0, 1, 1, 1, 1, 1),
  )
  assert_false(
    @audit.player_local_payload_reservation_allowed(0, 0, 0, 0, 1, 1, 1, 1, 2),
  )
}

///|
test "bulk byte reservations avoid overflow near the maximum Int" {
  assert_true(
    @audit.player_local_payload_reservation_allowed(
      2147483645, 0, 1, 0, 1, 1, 2147483647, 1, 0,
    ),
  )
  assert_true(
    @audit.player_local_payload_reservation_allowed(
      0, 0, 0, 0, 2147483647, 1, 2147483647, 1, 0,
    ),
  )
  assert_false(
    @audit.player_local_payload_reservation_allowed(
      2147483645, 0, 1, 0, 2, 1, 2147483647, 1, 0,
    ),
  )
  assert_false(
    @audit.player_local_payload_reservation_allowed(
      2147483645, 0, 1, 0, 1, 1, 2147483647, 1, 1,
    ),
  )
  assert_false(
    @audit.player_local_payload_reservation_allowed(
      1, 0, 2147483647, 0, 1, 1, 2147483647, 1, 0,
    ),
  )
  assert_false(
    @audit.player_local_payload_reservation_allowed(
      -2147483648, 0, 0, 0, 1, 1, 2147483647, 1, 0,
    ),
  )
}

///|
test "bulk item reservations avoid overflow near the maximum Int" {
  assert_true(
    @audit.player_local_payload_reservation_allowed(
      0, 2147483645, 0, 1, 1, 1, 1, 2147483647, 0,
    ),
  )
  assert_true(
    @audit.player_local_payload_reservation_allowed(
      0, 0, 0, 0, 1, 2147483647, 1, 2147483647, 0,
    ),
  )
  assert_false(
    @audit.player_local_payload_reservation_allowed(
      0, 2147483645, 0, 1, 1, 2, 1, 2147483647, 0,
    ),
  )
  assert_false(
    @audit.player_local_payload_reservation_allowed(
      0, 1, 0, 2147483647, 1, 1, 1, 2147483647, 0,
    ),
  )
  assert_false(
    @audit.player_local_payload_reservation_allowed(
      0, -2147483648, 0, 0, 1, 1, 1, 2147483647, 0,
    ),
  )
}

///|
test "small bulk reservations agree with an independent additive budget model" {
  for used_bytes in 0..<=4 {
    for reserved_bytes in 0..<=3 {
      for incoming_bytes in 0..<=4 {
        for used_items in 0..<=2 {
          for reserved_items in 0..<=2 {
            for incoming_items in 0..<=2 {
              let expected = incoming_bytes > 0 &&
                incoming_items > 0 &&
                used_bytes + reserved_bytes + incoming_bytes + 1 <= 6 &&
                used_items + reserved_items + incoming_items <= 3
              assert_eq(
                @audit.player_local_payload_reservation_allowed(
                  used_bytes, used_items, reserved_bytes, reserved_items, incoming_bytes,
                  incoming_items, 6, 3, 1,
                ),
                expected,
              )
            }
          }
        }
      }
    }
  }
}
