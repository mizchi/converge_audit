///|
/// One-step eligibility gate for player-local evidence pruning. Concrete
/// stores call this repeatedly from the durable anchor and therefore can only
/// remove an acknowledged, unprotected, contiguous checkpoint prefix.
pub fn player_local_checkpoint_prunable(
  candidate_epoch : Int,
  retention_anchor_epoch : Int,
  retain_from_epoch : Int,
  all_outbox_acknowledged : Bool,
  unresolved_reference : Bool,
) -> Bool {
  candidate_epoch >= 0 &&
  retention_anchor_epoch >= -1 &&
  candidate_epoch == retention_anchor_epoch + 1 &&
  candidate_epoch < retain_from_epoch &&
  all_outbox_acknowledged &&
  !unresolved_reference
}

///|
/// Admission gate applied after the host parses a prospective durable hold.
/// Authentication is deliberately an input so concrete signature schemes can
/// be replaced without changing the storage contract.
pub fn player_local_evidence_hold_admission_allowed(
  boundary_matches : Bool,
  checkpoint_matches : Bool,
  authentication_succeeded : Bool,
) -> Bool {
  boundary_matches && checkpoint_matches && authentication_succeeded
}

///|
/// A resolution may release pruning only when it is authenticated and exactly
/// bound to the still-active durable hold.
pub fn player_local_evidence_hold_resolution_allowed(
  boundary_matches : Bool,
  epoch_matches : Bool,
  checkpoint_matches : Bool,
  reference_matches : Bool,
  active : Bool,
  authentication_succeeded : Bool,
) -> Bool {
  boundary_matches &&
  epoch_matches &&
  checkpoint_matches &&
  reference_matches &&
  active &&
  authentication_succeeded
}

///|
/// Admission boundary for promoting one authenticated player-local hold to a
/// durable lineage case. Opening a case is evidence bookkeeping only; it does
/// not authorize an asset status transition.
pub fn evidence_lineage_case_admission_allowed(
  active_hold : Bool,
  boundary_matches : Bool,
  checkpoint_matches : Bool,
  reference_matches : Bool,
  ancestor_matches : Bool,
  authentication_succeeded : Bool,
) -> Bool {
  active_hold &&
  boundary_matches &&
  checkpoint_matches &&
  reference_matches &&
  ancestor_matches &&
  authentication_succeeded
}

///|
/// A lineage certificate may resolve a case only when it names the still-open
/// case and exactly the same asset/ancestor. Certificate authentication remains
/// a separate replaceable adapter fact.
pub fn evidence_lineage_case_decision_allowed(
  case_open : Bool,
  asset_matches : Bool,
  ancestor_matches : Bool,
  certificate_authenticated : Bool,
) -> Bool {
  case_open && asset_matches && ancestor_matches && certificate_authenticated
}

///|
/// Dismissal closes an investigation without changing asset eligibility. The
/// adapter verifies the signed certificate and its bounded acceptance time.
pub fn evidence_lineage_case_dismissal_allowed(
  case_open : Bool,
  case_id_matches : Bool,
  certificate_authenticated : Bool,
  certificate_time_valid : Bool,
) -> Bool {
  case_open &&
  case_id_matches &&
  certificate_authenticated &&
  certificate_time_valid
}

///|
/// Publishing a player-local resolution is a separate authenticated source
/// transition after the arbiter has resolved the exact case.
pub fn evidence_case_source_resolution_allowed(
  case_resolved : Bool,
  resolution_matches : Bool,
  source_authenticated : Bool,
  cursor_matches : Bool,
) -> Bool {
  case_resolved && resolution_matches && source_authenticated && cursor_matches
}
