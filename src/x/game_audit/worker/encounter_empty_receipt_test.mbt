///|
test "worker empty receipt retirement bridge preserves all sixty four combinations" {
  for mask in 0..<64 {
    assert_eq(
      @worker.audit_encounter_empty_receipt_retire_allowed(
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
