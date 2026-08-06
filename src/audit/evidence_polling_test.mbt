///|
test "evidence inbox page requires deadline bounds and exact bindings" {
  inspect(
    player_local_evidence_inbox_page_allowed(
      100, 200, 2, 2, 1024, 2048, true, true,
    ),
    content="true",
  )
  inspect(
    player_local_evidence_inbox_page_allowed(
      200, 200, 2, 2, 1024, 2048, true, true,
    ),
    content="false",
  )
  inspect(
    player_local_evidence_inbox_page_allowed(
      100, 200, 3, 2, 1024, 2048, true, true,
    ),
    content="false",
  )
  inspect(
    player_local_evidence_inbox_page_allowed(
      100, 200, 2, 2, 2049, 2048, true, true,
    ),
    content="false",
  )
}
