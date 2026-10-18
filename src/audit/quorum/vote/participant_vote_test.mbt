///|
test "participant vote merge is idempotent" {
  let states = [
    @vote.ParticipantVote::NoVote,
    @vote.ParticipantVote::ApproveVote,
    @vote.ParticipantVote::ChallengeVote,
    @vote.ParticipantVote::EquivocatedVote,
  ]
  for state in states {
    assert_eq(@vote.merge_participant_votes(state, state), state)
  }
}

///|
test "participant vote merge is commutative and associative" {
  let states = [
    @vote.ParticipantVote::NoVote,
    @vote.ParticipantVote::ApproveVote,
    @vote.ParticipantVote::ChallengeVote,
    @vote.ParticipantVote::EquivocatedVote,
  ]
  for left in states {
    for right in states {
      assert_eq(
        @vote.merge_participant_votes(left, right),
        @vote.merge_participant_votes(right, left),
      )
      for third in states {
        assert_eq(
          @vote.merge_participant_votes(
            @vote.merge_participant_votes(left, right),
            third,
          ),
          @vote.merge_participant_votes(
            left,
            @vote.merge_participant_votes(right, third),
          ),
        )
      }
    }
  }
}

///|
test "approve and challenge equivocation fails closed" {
  let merged = @vote.merge_participant_votes(
    @vote.ParticipantVote::ApproveVote,
    @vote.ParticipantVote::ChallengeVote,
  )
  assert_eq(merged, @vote.ParticipantVote::EquivocatedVote)
  assert_false(merged.is_approval())
  assert_true(merged.is_challenge())
}

///|
test "only a clean approval counts toward quorum" {
  assert_false(@vote.ParticipantVote::NoVote.is_approval())
  assert_true(@vote.ParticipantVote::ApproveVote.is_approval())
  assert_false(@vote.ParticipantVote::ChallengeVote.is_approval())
  assert_false(@vote.ParticipantVote::EquivocatedVote.is_approval())
  assert_false(@vote.ParticipantVote::NoVote.is_challenge())
  assert_false(@vote.ParticipantVote::ApproveVote.is_challenge())
  assert_true(@vote.ParticipantVote::ChallengeVote.is_challenge())
  assert_true(@vote.ParticipantVote::EquivocatedVote.is_challenge())
}
