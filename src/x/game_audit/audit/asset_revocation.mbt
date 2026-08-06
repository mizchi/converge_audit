///|
/// Fail-closed transfer/listing boundary for a linear asset lineage. Storage can
/// answer `open_revocations` with an indexed count or EXISTS query instead of
/// rewriting every descendant ownership record.
pub fn asset_lineage_use_allowed(
  creation_verified~ : Bool,
  current_head_verified~ : Bool,
  open_revocations~ : Int,
) -> Bool where {
  proof_ensure: result => {
    asset_lineage_use_allowed_post(
      creation_verified, current_head_verified, open_revocations, result,
    )
  },
} {
  let result = creation_verified &&
    current_head_verified &&
    open_revocations == 0
  proof_assert asset_lineage_use_allowed_post(
    creation_verified, current_head_verified, open_revocations, result,
  )
  result
}

///|
/// Compare-and-set boundary for a revoke or appeal decision. The storage layer
/// resolves `ancestor_in_lineage` from the origin receipt or transfer index.
pub fn asset_lineage_decision_allowed(
  asset_exists~ : Bool,
  ancestor_in_lineage~ : Bool,
  expected_decision_matches~ : Bool,
  revision_advances~ : Bool,
  decision_changes_status~ : Bool,
) -> Bool where {
  proof_ensure: result => {
    asset_lineage_decision_allowed_post(
      asset_exists, ancestor_in_lineage, expected_decision_matches, revision_advances,
      decision_changes_status, result,
    )
  },
} {
  let result = asset_exists &&
    ancestor_in_lineage &&
    expected_decision_matches &&
    revision_advances &&
    decision_changes_status
  proof_assert asset_lineage_decision_allowed_post(
    asset_exists, ancestor_in_lineage, expected_decision_matches, revision_advances,
    decision_changes_status, result,
  )
  result
}

///|
/// Aggregate fail-closed contract for admitting one bounded historical slice.
/// Cryptographic verification and hash recomputation happen in the inventory
/// layer; this proof-visible predicate fixes the required trust boundaries.
pub fn asset_lineage_slice_allowed(
  has_transfers~ : Bool,
  within_limit~ : Bool,
  origin_matches~ : Bool,
  anchor_matches~ : Bool,
  parent_chain_matches~ : Bool,
  every_transfer_authenticated~ : Bool,
  current_record_matches~ : Bool,
) -> Bool where {
  proof_ensure: result => {
    asset_lineage_slice_allowed_post(
      has_transfers, within_limit, origin_matches, anchor_matches, parent_chain_matches,
      every_transfer_authenticated, current_record_matches, result,
    )
  },
} {
  let result = has_transfers &&
    within_limit &&
    origin_matches &&
    anchor_matches &&
    parent_chain_matches &&
    every_transfer_authenticated &&
    current_record_matches
  proof_assert asset_lineage_slice_allowed_post(
    has_transfers, within_limit, origin_matches, anchor_matches, parent_chain_matches,
    every_transfer_authenticated, current_record_matches, result,
  )
  result
}
