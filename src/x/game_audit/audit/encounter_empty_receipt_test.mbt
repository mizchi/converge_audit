///|
test "empty receipt retirement requires the latest matching inventory member" {
  assert_true(
    @audit.encounter_empty_receipt_retire_allowed(
      true, true, true, true, true, true,
    ),
  )
  assert_false(
    @audit.encounter_empty_receipt_retire_allowed(
      true, true, true, true, true, false,
    ),
  )
}

///|
test "empty receipt retirement preserves settlement asset retention hold and generation guards" {
  assert_false(
    @audit.encounter_empty_receipt_retire_allowed(
      false, true, true, true, true, true,
    ),
  )
  assert_false(
    @audit.encounter_empty_receipt_retire_allowed(
      true, false, true, true, true, true,
    ),
  )
  assert_false(
    @audit.encounter_empty_receipt_retire_allowed(
      true, true, false, true, true, true,
    ),
  )
  assert_false(
    @audit.encounter_empty_receipt_retire_allowed(
      true, true, true, false, true, true,
    ),
  )
  assert_false(
    @audit.encounter_empty_receipt_retire_allowed(
      true, true, true, true, false, true,
    ),
  )
}

///|
test "empty receipt retirement admits exactly one of all sixty four fact combinations" {
  for mask in 0..<64 {
    assert_eq(
      @audit.encounter_empty_receipt_retire_allowed(
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
