///|
test "evidence inbox advances only one authenticated allowed hash-chain step" {
  inspect(
    player_local_evidence_inbox_advance_allowed(-1, 0, true, true, true, true),
    content="true",
  )
  inspect(
    player_local_evidence_inbox_advance_allowed(0, 2, true, true, true, true),
    content="false",
  )
  inspect(
    player_local_evidence_inbox_advance_allowed(0, 1, true, true, false, true),
    content="false",
  )
}
