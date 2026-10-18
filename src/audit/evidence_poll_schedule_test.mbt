///|
test "evidence poll claim requires due work before deadline" {
  inspect(
    @audit.player_local_evidence_poll_claim_allowed(100, 500, 100, true),
    content="true",
  )
  inspect(
    @audit.player_local_evidence_poll_claim_allowed(99, 500, 100, true),
    content="false",
  )
  inspect(
    @audit.player_local_evidence_poll_claim_allowed(100, 500, 100, false),
    content="false",
  )
  inspect(
    @audit.player_local_evidence_poll_claim_allowed(500, 500, 100, true),
    content="false",
  )
}

///|
test "evidence poll lease and backoff are capped" {
  inspect(
    @audit.player_local_evidence_poll_lease_expiry(100, 500, 100),
    content="200",
  )
  inspect(
    @audit.player_local_evidence_poll_lease_expiry(450, 500, 100),
    content="500",
  )
  inspect(
    @audit.player_local_evidence_poll_lease_expiry(500, 500, 100),
    content="-1",
  )
  inspect(
    @audit.player_local_evidence_poll_backoff_delay(0, 100, 800),
    content="100",
  )
  inspect(
    @audit.player_local_evidence_poll_backoff_delay(1, 100, 800),
    content="200",
  )
  inspect(
    @audit.player_local_evidence_poll_backoff_delay(2, 100, 800),
    content="400",
  )
  inspect(
    @audit.player_local_evidence_poll_backoff_delay(20, 100, 800),
    content="800",
  )
  inspect(
    @audit.player_local_evidence_poll_next_retry_at(450, 500, 2, 100, 800),
    content="500",
  )
}
