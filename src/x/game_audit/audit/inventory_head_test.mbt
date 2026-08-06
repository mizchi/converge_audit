///|
test "inventory head advances iff every monotonic binding holds" {
  for mask in 0..<64 {
    let creation_eligible = (mask & 1) != 0
    let proof_verified = (mask & 2) != 0
    let manifest_matches = (mask & 4) != 0
    let parent_matches = (mask & 8) != 0
    let epoch_advances = (mask & 16) != 0
    let owner_version_consistent = (mask & 32) != 0
    assert_eq(
      inventory_head_advance_allowed(
        creation_eligible~,
        proof_verified~,
        manifest_matches~,
        parent_matches~,
        epoch_advances~,
        owner_version_consistent~,
      ),
      mask == 63,
    )
  }
}

///|
test "multi-asset checkpoint commits iff every shared and per-asset binding holds" {
  for mask in 0..<1024 {
    let has_assets = (mask & 1) != 0
    let within_limit = (mask & 2) != 0
    let assets_canonical = (mask & 4) != 0
    let checkpoint_verified = (mask & 8) != 0
    let manifest_matches = (mask & 16) != 0
    let common_parent_epoch = (mask & 32) != 0
    let every_creation_eligible = (mask & 64) != 0
    let every_lineage_clean = (mask & 128) != 0
    let every_proof_verified = (mask & 256) != 0
    let every_head_version_matches = (mask & 512) != 0
    assert_eq(
      multi_asset_inventory_checkpoint_allowed(
        has_assets~,
        within_limit~,
        assets_canonical~,
        checkpoint_verified~,
        manifest_matches~,
        common_parent_epoch~,
        every_creation_eligible~,
        every_lineage_clean~,
        every_proof_verified~,
        every_head_version_matches~,
      ),
      mask == 1023,
    )
  }
}
