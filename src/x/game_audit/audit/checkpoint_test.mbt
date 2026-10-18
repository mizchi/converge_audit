///|
fn votes(items : Array[Bool]) -> FixedArray[Bool] {
  FixedArray::from_array(items[:])
}

///|
test "quorum attests but does not finalize without authority" {
  let decision = @audit.decide_checkpoint(
    votes([true, true, true]),
    3,
    challenged=false,
    authority=@audit.AuthorityVerdict::NoVerdict,
    replay_matches=false,
  )
  debug_inspect(decision, content="Attested")
  assert_false(
    @audit.market_accepts(decision, item_included=true, rejected_ancestor=false),
  )
}

///|
test "authority replay finalizes when a participant signature is missing" {
  let decision = @audit.decide_checkpoint(
    votes([true, true, false]),
    3,
    challenged=false,
    authority=@audit.AuthorityVerdict::Accept,
    replay_matches=true,
  )
  debug_inspect(decision, content="Finalized")
  assert_true(
    @audit.market_accepts(decision, item_included=true, rejected_ancestor=false),
  )
}

///|
test "challenge requires matching replay before finalization" {
  let challenged = @audit.decide_checkpoint(
    votes([true, true, true]),
    3,
    challenged=true,
    authority=@audit.AuthorityVerdict::Accept,
    replay_matches=false,
  )
  debug_inspect(challenged, content="Challenged")
  let replayed = @audit.decide_checkpoint(
    votes([true, true, true]),
    3,
    challenged=true,
    authority=@audit.AuthorityVerdict::Accept,
    replay_matches=true,
  )
  debug_inspect(replayed, content="Finalized")
}

///|
test "rejected ancestry quarantines an otherwise finalized item" {
  assert_false(
    @audit.market_accepts(
      @audit.CheckpointDecision::Finalized,
      item_included=true,
      rejected_ancestor=true,
    ),
  )
}

///|
test "checkpoint decision is deterministic for identical evidence" {
  let evidence = votes([true, false, true, true])
  let left = @audit.decide_checkpoint(
    evidence,
    3,
    challenged=false,
    authority=@audit.AuthorityVerdict::Accept,
    replay_matches=false,
  )
  let right = @audit.decide_checkpoint(
    evidence,
    3,
    challenged=false,
    authority=@audit.AuthorityVerdict::Accept,
    replay_matches=false,
  )
  assert_eq(left, right)
  debug_inspect(left, content="Finalized")
}

///|
test "authority rejection rejects the checkpoint" {
  let decision = @audit.decide_checkpoint(
    votes([true, true, true]),
    3,
    challenged=false,
    authority=@audit.AuthorityVerdict::Reject,
    replay_matches=true,
  )
  debug_inspect(decision, content="Rejected")
}

///|
test "zero or out-of-range threshold never creates a participant quorum" {
  let empty = votes([])
  assert_eq(
    @audit.decide_checkpoint(
      empty,
      0,
      challenged=false,
      authority=@audit.AuthorityVerdict::NoVerdict,
      replay_matches=false,
    ),
    @audit.CheckpointDecision::Pending,
  )
  assert_eq(
    @audit.decide_checkpoint(
      votes([true]),
      2,
      challenged=false,
      authority=@audit.AuthorityVerdict::Accept,
      replay_matches=false,
    ),
    @audit.CheckpointDecision::Pending,
  )
  assert_eq(
    @audit.decide_checkpoint(
      empty,
      0,
      challenged=false,
      authority=@audit.AuthorityVerdict::Accept,
      replay_matches=true,
    ),
    @audit.CheckpointDecision::Finalized,
  )
}
