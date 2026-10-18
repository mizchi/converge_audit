///|
test "payload admission accepts an exact fit after reserving control bytes" {
  assert_true(
    @audit.player_local_payload_admission_allowed(6, 1, 4, 12, 3, 4, 2),
  )
  assert_false(
    @audit.player_local_payload_admission_allowed(6, 1, 5, 12, 3, 8, 2),
  )
  assert_true(
    @audit.player_local_payload_admission_allowed(0, 0, 1, 1, 1, 1, 0),
  )
}

///|
test "full item slots and individually oversized payloads are refused" {
  assert_false(
    @audit.player_local_payload_admission_allowed(0, 3, 1, 100, 3, 10, 0),
  )
  assert_false(
    @audit.player_local_payload_admission_allowed(0, 4, 1, 100, 3, 10, 0),
  )
  assert_false(
    @audit.player_local_payload_admission_allowed(0, 0, 11, 100, 3, 10, 0),
  )
}

///|
test "every negative budget field and zero incoming payload are refused" {
  let valid = [4, 1, 2, 10, 4, 3, 1]
  for index in 0..<valid.length() {
    let invalid = valid.copy()
    invalid[index] = -1
    assert_false(
      @audit.player_local_payload_admission_allowed(
        invalid[0],
        invalid[1],
        invalid[2],
        invalid[3],
        invalid[4],
        invalid[5],
        invalid[6],
      ),
    )
  }
  for index in [2, 3, 4, 5] {
    let invalid = valid.copy()
    invalid[index] = 0
    assert_false(
      @audit.player_local_payload_admission_allowed(
        invalid[0],
        invalid[1],
        invalid[2],
        invalid[3],
        invalid[4],
        invalid[5],
        invalid[6],
      ),
    )
  }
}

///|
test "control reserve cannot be consumed by queued payloads" {
  assert_false(
    @audit.player_local_payload_admission_allowed(0, 0, 1, 10, 2, 10, 11),
  )
  assert_false(
    @audit.player_local_payload_admission_allowed(0, 0, 1, 10, 2, 10, 10),
  )
  assert_false(
    @audit.player_local_payload_admission_allowed(9, 0, 1, 10, 2, 10, 2),
  )
  assert_false(
    @audit.player_local_payload_admission_allowed(8, 0, 1, 10, 2, 10, 2),
  )
}

///|
test "admission avoids overflow near the maximum Int" {
  assert_true(
    @audit.player_local_payload_admission_allowed(
      2147483646, 2147483646, 1, 2147483647, 2147483647, 1, 0,
    ),
  )
  assert_true(
    @audit.player_local_payload_admission_allowed(
      0, 0, 2147483647, 2147483647, 1, 2147483647, 0,
    ),
  )
  assert_false(
    @audit.player_local_payload_admission_allowed(
      2147483646, 0, 2, 2147483647, 1, 2, 0,
    ),
  )
  assert_false(
    @audit.player_local_payload_admission_allowed(
      2147483646, 0, 1, 2147483647, 1, 1, 1,
    ),
  )
  assert_false(
    @audit.player_local_payload_admission_allowed(
      0, 0, 2147483647, 2147483647, 1, 2147483647, 1,
    ),
  )
  assert_false(
    @audit.player_local_payload_admission_allowed(
      -2147483648, 0, 1, 2147483647, 1, 1, 2147483647,
    ),
  )
}

///|
test "small payload admissions agree with the arithmetic capacity model" {
  for current_bytes in 0..<=10 {
    for current_items in 0..<=5 {
      for incoming_bytes in 0..<=7 {
        let expected = incoming_bytes > 0 &&
          incoming_bytes <= 4 &&
          current_items < 3 &&
          current_bytes + incoming_bytes + 2 <= 8
        assert_eq(
          @audit.player_local_payload_admission_allowed(
            current_bytes, current_items, incoming_bytes, 8, 3, 4, 2,
          ),
          expected,
        )
      }
    }
  }
}

///|
test "payload pruning requires finality and closed retention in addition to ACK" {
  assert_false(@audit.player_local_payload_prunable(true, false, false, false))
  assert_false(@audit.player_local_payload_prunable(true, false, true, false))
  assert_false(@audit.player_local_payload_prunable(true, true, false, false))
  assert_false(@audit.player_local_payload_prunable(false, true, true, false))
  assert_false(@audit.player_local_payload_prunable(true, true, true, true))
  assert_true(@audit.player_local_payload_prunable(true, true, true, false))
}

///|
test "payload prune gate covers all acknowledgement finality retention hold combinations" {
  for acknowledged in [false, true] {
    for finalized in [false, true] {
      for retention_closed in [false, true] {
        for unresolved in [false, true] {
          let required_facts = [acknowledged, finalized, retention_closed]
          let expected = required_facts.filter(fn(fact) { fact }).length() == 3 &&
            !unresolved
          assert_eq(
            @audit.player_local_payload_prunable(
              acknowledged, finalized, retention_closed, unresolved,
            ),
            expected,
          )
        }
      }
    }
  }
}
