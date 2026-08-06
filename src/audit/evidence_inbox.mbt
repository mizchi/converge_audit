///|
/// One authenticated hash-chain step for an external player-local evidence
/// source. The host computes the binding facts from durable state and the
/// decoded canonical envelope; concrete crypto remains replaceable.
pub fn player_local_evidence_inbox_advance_allowed(
  current_sequence : Int,
  next_sequence : Int,
  previous_digest_matches : Bool,
  message_digest_advances : Bool,
  authentication_succeeded : Bool,
  operation_allowed : Bool,
) -> Bool {
  current_sequence >= -1 &&
  next_sequence == current_sequence + 1 &&
  previous_digest_matches &&
  message_digest_advances &&
  authentication_succeeded &&
  operation_allowed
}
