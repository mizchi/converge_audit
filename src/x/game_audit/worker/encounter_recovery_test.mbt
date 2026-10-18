///|
test "worker recovery release bridge preserves all sixteen fact combinations" {
  for mask in 0..<16 {
    assert_eq(
      @worker.audit_encounter_recovery_release_allowed(
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
test "worker recovery forget bridge preserves all sixty four fact combinations" {
  for mask in 0..<64 {
    assert_eq(
      @worker.audit_encounter_recovery_forget_allowed(
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
