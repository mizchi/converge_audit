///|
/// Server-owned expectation for one member of an atomic inventory checkpoint.
/// These values come from durable state and are rechecked again inside the
/// storage transaction after cryptographic verification succeeds.
pub(all) struct ExpectedInventoryCheckpointAsset {
  origin : @market.ItemReceipt
  current_owner_id : String
  current_version : Int
  current_checkpoint_digest : @bft.Digest
  current_epoch : Int
  creation_eligible : Bool
  lineage_clean : Bool
} derive(Eq, Debug)

///|
pub(all) enum InventoryCheckpointCentralRefusal {
  InventoryCheckpointWireRefused(@wire.InventoryCheckpointWireError)
  InventoryCheckpointExpectedSessionMismatch
  InventoryCheckpointExpectedAuthorityMismatch
  InventoryCheckpointExpectedCheckpointMismatch
  InventoryCheckpointExpectedGameManifestMismatch
  InventoryCheckpointExpectedAssetCountMismatch(Int, Int)
  InventoryCheckpointExpectedAssetMismatch(Int)
  InventoryCheckpointExpectedHeadsNotShared(Int)
  InventoryCheckpointAssetCreationRevoked(Int)
  InventoryCheckpointAssetLineageRevoked(Int)
  InventoryCheckpointAssetParentMismatch(Int)
  InventoryCheckpointAssetEpochMismatch(Int)
  InventoryCheckpointAssetOriginMismatch(Int)
  InventoryCheckpointAssetProofRefused(Int)
  InventoryCheckpointAssetHeadVersionMismatch(Int)
  InventoryCheckpointAuthenticationRefused(@checkpoint.CheckpointVerification)
  InventoryCheckpointWitnessSessionRefused(String)
  InventoryCheckpointWitnessEvidenceRefused(@attestation.EvidenceAlertKind)
  InventoryCheckpointWitnessCheckpointMismatch
  InventoryCheckpointWitnessAuthorityMismatch
  InventoryCheckpointWitnessQuorumPending(Int, Int)
  InventoryCheckpointWitnessFinalizationMismatch
  InventoryCheckpointAggregatePolicyRefused
} derive(Eq, Debug)

///|
pub(all) enum InventoryCheckpointCentralResult {
  InventoryCheckpointCentralVerified(VerifiedInventoryCheckpoint)
  InventoryCheckpointCentralRefused(InventoryCheckpointCentralRefusal)
} derive(Eq, Debug)

///|
/// Capability minted only after the shared checkpoint certificate and every
/// per-asset membership/head expectation agree.
pub struct VerifiedInventoryCheckpoint {
  session_id : String
  authority_key : @bft.PublicKey
  checkpoint_digest : @bft.Digest
  previous_checkpoint : @bft.Digest
  epoch : Int
  game_manifest_digest : @bft.Digest
  public_state_root : @bft.Digest
  records : Array[@inventory.AssetRecord]
  write_set_digest : @bft.Digest
  approval_count : Int
  required_approvals : Int
} derive(Eq, Debug)

///|
pub fn VerifiedInventoryCheckpoint::session_id(
  self : VerifiedInventoryCheckpoint,
) -> String {
  self.session_id
}

///|
pub fn VerifiedInventoryCheckpoint::authority_key(
  self : VerifiedInventoryCheckpoint,
) -> @bft.PublicKey {
  self.authority_key
}

///|
pub fn VerifiedInventoryCheckpoint::checkpoint_digest(
  self : VerifiedInventoryCheckpoint,
) -> @bft.Digest {
  self.checkpoint_digest
}

///|
pub fn VerifiedInventoryCheckpoint::previous_checkpoint(
  self : VerifiedInventoryCheckpoint,
) -> @bft.Digest {
  self.previous_checkpoint
}

///|
pub fn VerifiedInventoryCheckpoint::epoch(
  self : VerifiedInventoryCheckpoint,
) -> Int {
  self.epoch
}

///|
pub fn VerifiedInventoryCheckpoint::game_manifest_digest(
  self : VerifiedInventoryCheckpoint,
) -> @bft.Digest {
  self.game_manifest_digest
}

///|
pub fn VerifiedInventoryCheckpoint::public_state_root(
  self : VerifiedInventoryCheckpoint,
) -> @bft.Digest {
  self.public_state_root
}

///|
pub fn VerifiedInventoryCheckpoint::asset_count(
  self : VerifiedInventoryCheckpoint,
) -> Int {
  self.records.length()
}

///|
pub fn VerifiedInventoryCheckpoint::records(
  self : VerifiedInventoryCheckpoint,
) -> Array[@inventory.AssetRecord] {
  self.records.copy()
}

///|
pub fn VerifiedInventoryCheckpoint::write_set_digest(
  self : VerifiedInventoryCheckpoint,
) -> @bft.Digest {
  self.write_set_digest
}

///|
pub fn VerifiedInventoryCheckpoint::approval_count(
  self : VerifiedInventoryCheckpoint,
) -> Int {
  self.approval_count
}

///|
pub fn VerifiedInventoryCheckpoint::required_approvals(
  self : VerifiedInventoryCheckpoint,
) -> Int {
  self.required_approvals
}

///|
fn inventory_checkpoint_append_field(
  buffer : StringBuilder,
  value : String,
) -> Unit {
  buffer.write_string(value.length().to_string())
  buffer.write_char(':')
  buffer.write_string(value)
}

///|
fn inventory_checkpoint_write_set_digest(
  hasher : &@bft.Hasher,
  session_id : String,
  checkpoint_digest : @bft.Digest,
  previous_checkpoint : @bft.Digest,
  epoch : Int,
  game_manifest_digest : @bft.Digest,
  expected_assets : Array[ExpectedInventoryCheckpointAsset],
  records : Array[@inventory.AssetRecord],
) -> @bft.Digest {
  let buffer = StringBuilder::new()
  inventory_checkpoint_append_field(buffer, "inventory-checkpoint-write-set-v1")
  inventory_checkpoint_append_field(buffer, session_id)
  inventory_checkpoint_append_field(buffer, checkpoint_digest.0)
  inventory_checkpoint_append_field(buffer, previous_checkpoint.0)
  inventory_checkpoint_append_field(buffer, epoch.to_string())
  inventory_checkpoint_append_field(buffer, game_manifest_digest.0)
  inventory_checkpoint_append_field(buffer, records.length().to_string())
  for index, record in records {
    let expected = expected_assets[index]
    inventory_checkpoint_append_field(buffer, expected.origin.asset_id)
    inventory_checkpoint_append_field(buffer, expected.current_owner_id)
    inventory_checkpoint_append_field(
      buffer,
      expected.current_version.to_string(),
    )
    inventory_checkpoint_append_field(
      buffer,
      expected.current_checkpoint_digest.0,
    )
    inventory_checkpoint_append_field(
      buffer,
      expected.current_epoch.to_string(),
    )
    inventory_checkpoint_append_field(
      buffer,
      @inventory.serialize_asset_record(record),
    )
  }
  hasher.hash_string(buffer.to_string())
}

///|
fn inventory_checkpoint_witnesses(
  bundle : @wire.InventoryCheckpointProofBundle,
) -> Array[@attestation.Participant] {
  let participants : Array[@attestation.Participant] = []
  for witness in bundle.witnesses {
    participants.push({ id: witness.id, key: witness.key })
  }
  participants
}

///|
/// Verify a canonical multi-asset write-set using one signed inventory
/// checkpoint and one replay-witness certificate. The expected asset heads are
/// trusted durable inputs, not fields accepted from the bundle itself.
pub fn verify_inventory_checkpoint_proof_bundle(
  hasher : &@bft.Hasher,
  verifier : &@bft.Verifier,
  bundle_bytes : Bytes,
  expected_session_id~ : String,
  expected_authority_key~ : @bft.PublicKey,
  expected_checkpoint_digest~ : @bft.Digest,
  expected_game_manifest_digest~ : @bft.Digest,
  expected_assets~ : Array[ExpectedInventoryCheckpointAsset],
  limits~ : @wire.InventoryCheckpointWireLimits,
) -> InventoryCheckpointCentralResult {
  let bundle = match
    @wire.decode_inventory_checkpoint_proof_bundle(bundle_bytes, limits~) {
    Ok(value) => value
    Err(reason) =>
      return InventoryCheckpointCentralRefused(
        InventoryCheckpointWireRefused(reason),
      )
  }
  let signed_checkpoint = bundle.signed_checkpoint
  let checkpoint = signed_checkpoint.checkpoint
  if checkpoint.session_id != expected_session_id {
    return InventoryCheckpointCentralRefused(
      InventoryCheckpointExpectedSessionMismatch,
    )
  }
  if signed_checkpoint.authority_key != expected_authority_key {
    return InventoryCheckpointCentralRefused(
      InventoryCheckpointExpectedAuthorityMismatch,
    )
  }
  if signed_checkpoint.digest != expected_checkpoint_digest {
    return InventoryCheckpointCentralRefused(
      InventoryCheckpointExpectedCheckpointMismatch,
    )
  }
  if bundle.game_manifest_digest != expected_game_manifest_digest {
    return InventoryCheckpointCentralRefused(
      InventoryCheckpointExpectedGameManifestMismatch,
    )
  }
  if bundle.proofs.length() != expected_assets.length() {
    return InventoryCheckpointCentralRefused(
      InventoryCheckpointExpectedAssetCountMismatch(
        bundle.proofs.length(),
        expected_assets.length(),
      ),
    )
  }
  let first_expected = expected_assets[0]
  for index, expected in expected_assets {
    let proof = bundle.proofs[index]
    if proof.record.asset_id != expected.origin.asset_id {
      return InventoryCheckpointCentralRefused(
        InventoryCheckpointExpectedAssetMismatch(index),
      )
    }
    if expected.current_checkpoint_digest !=
      first_expected.current_checkpoint_digest ||
      expected.current_epoch != first_expected.current_epoch {
      return InventoryCheckpointCentralRefused(
        InventoryCheckpointExpectedHeadsNotShared(index),
      )
    }
    if !expected.creation_eligible {
      return InventoryCheckpointCentralRefused(
        InventoryCheckpointAssetCreationRevoked(index),
      )
    }
    if !expected.lineage_clean {
      return InventoryCheckpointCentralRefused(
        InventoryCheckpointAssetLineageRevoked(index),
      )
    }
    if checkpoint.previous_checkpoint != expected.current_checkpoint_digest {
      return InventoryCheckpointCentralRefused(
        InventoryCheckpointAssetParentMismatch(index),
      )
    }
    if checkpoint.epoch <= expected.current_epoch {
      return InventoryCheckpointCentralRefused(
        InventoryCheckpointAssetEpochMismatch(index),
      )
    }
    let owner_version_consistent = if proof.record.owner_id ==
      expected.current_owner_id {
      proof.record.version >= expected.current_version
    } else {
      proof.record.version > expected.current_version
    }
    if !owner_version_consistent {
      return InventoryCheckpointCentralRefused(
        InventoryCheckpointAssetHeadVersionMismatch(index),
      )
    }
  }
  let verified = match
    @checkpoint.open_checkpoint(
      hasher, verifier, expected_authority_key, signed_checkpoint,
    ) {
    Opened(value) => value
    Refused(reason) =>
      return InventoryCheckpointCentralRefused(
        InventoryCheckpointAuthenticationRefused(reason),
      )
  }
  for index, expected in expected_assets {
    let proof = bundle.proofs[index]
    if !@inventory.inventory_proof_matches_origin_receipt(
        hasher,
        proof,
        expected.origin,
      ) {
      return InventoryCheckpointCentralRefused(
        InventoryCheckpointAssetOriginMismatch(index),
      )
    }
    if !@inventory.verify_inventory_proof(
        hasher,
        checkpoint.public_state_root,
        proof,
      ) {
      return InventoryCheckpointCentralRefused(
        InventoryCheckpointAssetProofRefused(index),
      )
    }
  }
  let prepared = @checkpoint.prepare_checkpoint(hasher, checkpoint)
  let witnesses = match
    @attestation.ReplayWitnessCollector::new(
      hasher,
      verifier,
      prepared,
      game_manifest_digest=expected_game_manifest_digest,
      referee_key=expected_authority_key,
      witnesses=inventory_checkpoint_witnesses(bundle),
      max_faults=bundle.max_faults,
    ) {
    WitnessCollectorReady(value) => value
    other =>
      return InventoryCheckpointCentralRefused(
        InventoryCheckpointWitnessSessionRefused(
          inventory_witness_build_refusal(other),
        ),
      )
  }
  for signed in bundle.attestations {
    match witnesses.deliver(signed) {
      Accepted | Duplicate => ()
      Rejected(alert) =>
        return InventoryCheckpointCentralRefused(
          InventoryCheckpointWitnessEvidenceRefused(alert.kind),
        )
    }
  }
  let certificate = match witnesses.certify(verified) {
    WitnessCertified(value) => value
    WitnessCheckpointMismatch =>
      return InventoryCheckpointCentralRefused(
        InventoryCheckpointWitnessCheckpointMismatch,
      )
    WitnessRefereeMismatch =>
      return InventoryCheckpointCentralRefused(
        InventoryCheckpointWitnessAuthorityMismatch,
      )
    WitnessQuorumPending(actual, required) =>
      return InventoryCheckpointCentralRefused(
        InventoryCheckpointWitnessQuorumPending(actual, required),
      )
  }
  let finalized = match
    @attestation.finalize_witnessed_checkpoint(verified, certificate) {
    Ready(value) => value
    _ =>
      return InventoryCheckpointCentralRefused(
        InventoryCheckpointWitnessFinalizationMismatch,
      )
  }
  if !@audit.multi_asset_inventory_checkpoint_allowed(
      has_assets=!bundle.proofs.is_empty(),
      within_limit=bundle.proofs.length() <= limits.max_proofs,
      assets_canonical=true,
      checkpoint_verified=true,
      manifest_matches=true,
      common_parent_epoch=true,
      every_creation_eligible=true,
      every_lineage_clean=true,
      every_proof_verified=true,
      every_head_version_matches=true,
    ) {
    return InventoryCheckpointCentralRefused(
      InventoryCheckpointAggregatePolicyRefused,
    )
  }
  let records : Array[@inventory.AssetRecord] = []
  for proof in bundle.proofs {
    records.push(proof.record)
  }
  InventoryCheckpointCentralVerified(VerifiedInventoryCheckpoint::{
    session_id: checkpoint.session_id,
    authority_key: expected_authority_key,
    checkpoint_digest: finalized.digest(),
    previous_checkpoint: checkpoint.previous_checkpoint,
    epoch: checkpoint.epoch,
    game_manifest_digest: expected_game_manifest_digest,
    public_state_root: checkpoint.public_state_root,
    write_set_digest: inventory_checkpoint_write_set_digest(
      hasher,
      checkpoint.session_id,
      finalized.digest(),
      checkpoint.previous_checkpoint,
      checkpoint.epoch,
      expected_game_manifest_digest,
      expected_assets,
      records,
    ),
    records,
    approval_count: certificate.approval_count(),
    required_approvals: certificate.required_approvals(),
  })
}
