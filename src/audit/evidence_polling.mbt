///|
/// Admission guard for one bounded page received from an external evidence
/// source. Transport parsing computes these primitive facts; storage mutation
/// remains message-atomic through the evidence inbox contract.
pub fn player_local_evidence_inbox_page_allowed(
  received_at_ms : Int,
  deadline_at_ms : Int,
  message_count : Int,
  max_messages : Int,
  response_bytes : Int,
  max_response_bytes : Int,
  source_matches : Bool,
  cursor_matches : Bool,
) -> Bool {
  received_at_ms >= 0 &&
  deadline_at_ms > received_at_ms &&
  message_count >= 0 &&
  max_messages > 0 &&
  message_count <= max_messages &&
  response_bytes >= 0 &&
  max_response_bytes > 0 &&
  response_bytes <= max_response_bytes &&
  source_matches &&
  cursor_matches
}
