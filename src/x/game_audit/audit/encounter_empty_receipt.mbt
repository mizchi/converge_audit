///|
/// Retire an old-generation settled receipt only after retention and hold
/// checks succeed. `assetless_receipt` means the receipt exists with empty
/// items, empty admittedAssets, and no archiveCustody. `index_matches` means
/// the latest inventory checkpoint contains the same ticket/receipt member
/// under the receipt's owner and unit. The host supplies these facts from one
/// authoritative snapshot and performs retirement atomically.
pub fn encounter_empty_receipt_retire_allowed(
  settled : Bool,
  assetless_receipt : Bool,
  retention_released : Bool,
  hold_clear : Bool,
  old_generation : Bool,
  index_matches : Bool,
) -> Bool where {
  proof_ensure: result => {
    encounter_empty_receipt_retire_allowed_post(
      settled, assetless_receipt, retention_released, hold_clear, old_generation,
      index_matches, result,
    )
  },
} {
  settled &&
  assetless_receipt &&
  retention_released &&
  hold_clear &&
  old_generation &&
  index_matches
}
