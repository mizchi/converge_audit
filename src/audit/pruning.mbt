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
