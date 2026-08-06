///|
/// Pure fail-closed policy for replacing a Durable Object's per-asset
/// inventory head. Idempotent reads are handled separately and cannot mutate
/// this head.
pub fn inventory_head_advance_allowed(
  creation_eligible~ : Bool,
  proof_verified~ : Bool,
  manifest_matches~ : Bool,
  parent_matches~ : Bool,
  epoch_advances~ : Bool,
  owner_version_consistent~ : Bool,
) -> Bool where {
  proof_ensure: result => {
    inventory_head_advance_post(
      creation_eligible, proof_verified, manifest_matches, parent_matches, epoch_advances,
      owner_version_consistent, result,
    )
  },
} {
  let result = creation_eligible &&
    proof_verified &&
    manifest_matches &&
    parent_matches &&
    epoch_advances &&
    owner_version_consistent
  proof_assert inventory_head_advance_post(
    creation_eligible, proof_verified, manifest_matches, parent_matches, epoch_advances,
    owner_version_consistent, result,
  )
  result
}

///|
/// Aggregate admission boundary for an atomic inventory checkpoint. The
/// cryptographic verifier and durable adapter derive these facts independently;
/// no prefix may be committed when any shared or per-asset fact is false.
pub fn multi_asset_inventory_checkpoint_allowed(
  has_assets~ : Bool,
  within_limit~ : Bool,
  assets_canonical~ : Bool,
  checkpoint_verified~ : Bool,
  manifest_matches~ : Bool,
  common_parent_epoch~ : Bool,
  every_creation_eligible~ : Bool,
  every_lineage_clean~ : Bool,
  every_proof_verified~ : Bool,
  every_head_version_matches~ : Bool,
) -> Bool where {
  proof_ensure: result => {
    multi_asset_inventory_checkpoint_post(
      has_assets, within_limit, assets_canonical, checkpoint_verified, manifest_matches,
      common_parent_epoch, every_creation_eligible, every_lineage_clean, every_proof_verified,
      every_head_version_matches, result,
    )
  },
} {
  let result = has_assets &&
    within_limit &&
    assets_canonical &&
    checkpoint_verified &&
    manifest_matches &&
    common_parent_epoch &&
    every_creation_eligible &&
    every_lineage_clean &&
    every_proof_verified &&
    every_head_version_matches
  proof_assert multi_asset_inventory_checkpoint_post(
    has_assets, within_limit, assets_canonical, checkpoint_verified, manifest_matches,
    common_parent_epoch, every_creation_eligible, every_lineage_clean, every_proof_verified,
    every_head_version_matches, result,
  )
  result
}
