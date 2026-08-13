///|
/// Test/benchmark-only seed-backed fixture bridge. Production code must import
/// `x/game_audit/worker`, whose linked exports exclude every function here.
pub fn audit_experimental_sign_checkpoint_delivery_approval(
  witness_seed_hex : String,
  witness_id : String,
  statement_digest : String,
) -> String {
  @worker.audit_experimental_sign_checkpoint_delivery_approval(
    witness_seed_hex, witness_id, statement_digest,
  )
}

///|
pub fn audit_benchmark_make_checkpoint_delivery_authentication(
  producer_seed_hex : String,
  producer_id : String,
  witness_seed_hexes : Array[String],
  witness_ids : Array[String],
  required_approvals : Int,
  approval_count : Int,
  protocol_version : Int,
  purpose : String,
  manifest_digest : String,
  scope_id : String,
  unit_id : String,
  destination_id : String,
  epoch : Int,
  previous_checkpoint : String,
  checkpoint_digest : String,
  canonical_envelope : String,
) -> String {
  @worker.audit_benchmark_make_checkpoint_delivery_authentication(
    producer_seed_hex, producer_id, witness_seed_hexes, witness_ids, required_approvals,
    approval_count, protocol_version, purpose, manifest_digest, scope_id, unit_id,
    destination_id, epoch, previous_checkpoint, checkpoint_digest, canonical_envelope,
  )
}

///|
pub fn audit_benchmark_make_anchor_envelope(
  authority_seed_hex : String,
  log_session_id : String,
  observer_id : String,
  epoch : Int,
  previous_digest : String,
) -> String {
  @worker.audit_benchmark_make_anchor_envelope(
    authority_seed_hex, log_session_id, observer_id, epoch, previous_digest,
  )
}

///|
pub fn audit_benchmark_make_pve_replay_bundle(
  authority_seed_hex : String,
  player_seed_hex : String,
  session_id : String,
) -> String {
  @worker.audit_benchmark_make_pve_replay_bundle(
    authority_seed_hex, player_seed_hex, session_id,
  )
}

///|
pub fn audit_benchmark_make_pvp_replay_bundle(
  referee_seed_hex : String,
  participant_seed_hex : String,
  session_id : String,
) -> String {
  @worker.audit_benchmark_make_pvp_replay_bundle(
    referee_seed_hex, participant_seed_hex, session_id,
  )
}

///|
pub fn audit_benchmark_make_open_world_pve_replay_bundle(
  authority_seed_hex : String,
  participant_seed_hex : String,
  world_id : String,
  encounter_session_id : String,
) -> String {
  @worker.audit_benchmark_make_open_world_pve_replay_bundle(
    authority_seed_hex, participant_seed_hex, world_id, encounter_session_id,
  )
}

///|
pub fn audit_benchmark_make_open_world_multi_asset_pve_replay_bundle(
  authority_seed_hex : String,
  participant_seed_hex : String,
  world_id : String,
  encounter_session_id : String,
  asset_count : Int,
) -> String {
  @worker.audit_benchmark_make_open_world_multi_asset_pve_replay_bundle(
    authority_seed_hex, participant_seed_hex, world_id, encounter_session_id, asset_count,
  )
}

///|
pub fn audit_benchmark_make_open_world_missing_slot_conflict_bundle(
  authority_seed_hex : String,
  participant_seed_hex : String,
  world_id : String,
  encounter_session_id : String,
  source : String,
) -> String {
  @worker.audit_benchmark_make_open_world_missing_slot_conflict_bundle(
    authority_seed_hex, participant_seed_hex, world_id, encounter_session_id, source,
  )
}

///|
pub fn audit_benchmark_make_open_world_missing_slot_proof(
  registered_count : Int,
  registration_index : Int,
) -> String {
  @worker.audit_benchmark_make_open_world_missing_slot_proof(
    registered_count, registration_index,
  )
}

///|
pub fn audit_benchmark_make_inventory_listing_proof_bundle(
  authority_seed_hex : String,
  participant_seed_hex : String,
  session_id : String,
  previous_checkpoint_digest : String,
  epoch : Int,
  asset_id : String,
  initial_owner_id : String,
  current_owner_id : String,
  item_type : String,
  quantity : Int,
  source_event_digest : String,
  output_index : Int,
  version : Int,
) -> String {
  @worker.audit_benchmark_make_inventory_listing_proof_bundle(
    authority_seed_hex, participant_seed_hex, session_id, previous_checkpoint_digest,
    epoch, asset_id, initial_owner_id, current_owner_id, item_type, quantity, source_event_digest,
    output_index, version,
  )
}

///|
pub fn audit_benchmark_make_inventory_lineage_proof_bundle(
  authority_seed_hex : String,
  participant_seed_hex : String,
  session_id : String,
  previous_checkpoint_digest : String,
  epoch : Int,
  asset_id : String,
  initial_owner_id : String,
  current_owner_id : String,
  item_type : String,
  quantity : Int,
  source_event_digest : String,
  output_index : Int,
  version : Int,
) -> String {
  @worker.audit_benchmark_make_inventory_lineage_proof_bundle(
    authority_seed_hex, participant_seed_hex, session_id, previous_checkpoint_digest,
    epoch, asset_id, initial_owner_id, current_owner_id, item_type, quantity, source_event_digest,
    output_index, version,
  )
}

///|
pub fn audit_benchmark_make_inventory_checkpoint_proof_bundle(
  authority_seed_hex : String,
  participant_seed_hex : String,
  session_id : String,
  previous_checkpoint_digest : String,
  epoch : Int,
  asset_ids : Array[String],
  quantities : Array[Int],
  source_event_digests : Array[String],
  output_indices : Array[Int],
  initial_owner_ids : Array[String],
  current_owner_ids : Array[String],
  item_type : String,
) -> String {
  @worker.audit_benchmark_make_inventory_checkpoint_proof_bundle(
    authority_seed_hex, participant_seed_hex, session_id, previous_checkpoint_digest,
    epoch, asset_ids, quantities, source_event_digests, output_indices, initial_owner_ids,
    current_owner_ids, item_type,
  )
}
