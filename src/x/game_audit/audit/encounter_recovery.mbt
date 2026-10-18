///|
/// Release recovery retention only for forfeited, unsettled recovery without
/// assets, after retention and hold checks succeed. These are trusted facts
/// from the same recovery record; owner abandonment alone cannot release it.
pub fn encounter_recovery_release_allowed(
  forfeited : Bool,
  retention_released : Bool,
  hold_clear : Bool,
  without_assets : Bool,
) -> Bool where {
  proof_ensure: result => {
    encounter_recovery_release_allowed_post(
      forfeited, retention_released, hold_clear, without_assets, result,
    )
  },
} {
  forfeited && retention_released && hold_clear && without_assets
}

///|
/// Forget recovery only after release eligibility, explicit owner abandonment,
/// and a generation advance. An eligible record in the current generation is
/// retained so another view can still read its durable recovery result.
pub fn encounter_recovery_forget_allowed(
  forfeited : Bool,
  retention_released : Bool,
  hold_clear : Bool,
  without_assets : Bool,
  owner_released : Bool,
  old_generation : Bool,
) -> Bool where {
  proof_ensure: result => {
    encounter_recovery_forget_allowed_post(
      forfeited, retention_released, hold_clear, without_assets, owner_released,
      old_generation, result,
    )
  },
} {
  encounter_recovery_release_allowed(
    forfeited, retention_released, hold_clear, without_assets,
  ) &&
  owner_released &&
  old_generation
}
