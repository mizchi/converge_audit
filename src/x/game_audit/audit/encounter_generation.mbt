///|
/// Advance a generation only when its expected value matches, a successor is
/// available, and all terminal state and archives have been retired. The host
/// supplies these facts from one authoritative snapshot and performs the roll
/// atomically; this pure guard does not release retained evidence itself.
pub fn encounter_generation_roll_allowed(
  expected_matches : Bool,
  can_advance : Bool,
  all_terminal_retired : Bool,
  all_archive_released : Bool,
) -> Bool where {
  proof_ensure: result => {
    encounter_generation_roll_allowed_post(
      expected_matches, can_advance, all_terminal_retired, all_archive_released,
      result,
    )
  },
} {
  expected_matches &&
  can_advance &&
  all_terminal_retired &&
  all_archive_released
}
