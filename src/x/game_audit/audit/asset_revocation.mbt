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
