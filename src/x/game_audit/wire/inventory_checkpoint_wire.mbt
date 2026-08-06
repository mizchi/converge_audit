///|
const INVENTORY_CHECKPOINT_WIRE_VERSION : Int = 1

///|
/// One authority checkpoint and replay-witness certificate authenticating a
/// canonical set of inventory records. The signed checkpoint is shared rather
/// than repeated once per asset.
pub(all) struct InventoryCheckpointProofBundle {
  signed_checkpoint : @checkpoint.SignedCheckpoint
  game_manifest_digest : @bft.Digest
  witnesses : Array[@witness_manifest.ReplayWitnessIdentity]
  max_faults : Int
  attestations : Array[@attestation.SignedAttestation]
  proofs : Array[@inventory.InventoryProof]
} derive(Eq, Debug)

///|
pub(all) struct InventoryCheckpointWireLimits {
  max_bundle_bytes : Int
  max_text_bytes : Int
  max_witnesses : Int
  max_attestations : Int
  max_proofs : Int
  max_proof_steps : Int
} derive(Eq, Debug)

///|
pub fn InventoryCheckpointWireLimits::default() -> InventoryCheckpointWireLimits {
  {
    max_bundle_bytes: 1048576,
    max_text_bytes: 4096,
    max_witnesses: 64,
    max_attestations: 64,
    max_proofs: 64,
    max_proof_steps: 64,
  }
}

///|
pub(all) enum InventoryCheckpointWireError {
  InventoryCheckpointWireInputTooLarge(Int, Int)
  InventoryCheckpointWireWitnessesTooMany(Int, Int)
  InventoryCheckpointWireAttestationsTooMany(Int, Int)
  InventoryCheckpointWireMissingProofs
  InventoryCheckpointWireProofsTooMany(Int, Int)
  InventoryCheckpointWireNonCanonicalAssets(Int)
  InventoryCheckpointWireUnsupportedVersion(Int)
  InventoryCheckpointWireNonCanonicalEncoding
  InventoryCheckpointWireMalformedCbor
  InventoryCheckpointWireCodecRefused(OpenWorldAuditWireError)
} derive(Eq, Debug)

///|
fn inventory_checkpoint_codec_limits(
  limits : InventoryCheckpointWireLimits,
) -> OpenWorldAuditWireLimits {
  {
    max_envelope_bytes: limits.max_bundle_bytes,
    max_gap_request_bytes: limits.max_bundle_bytes,
    max_gap_response_bytes: limits.max_bundle_bytes,
    max_text_bytes: limits.max_text_bytes,
    max_proof_steps: limits.max_proof_steps,
    max_gap_response_items: limits.max_witnesses
    .max(limits.max_attestations)
    .max(limits.max_proofs),
  }
}

///|
fn encode_inventory_checkpoint_value(
  bundle : InventoryCheckpointProofBundle,
) -> @cbor.CborValue {
  let witnesses : Array[@cbor.CborValue] = []
  for witness in bundle.witnesses {
    witnesses.push(encode_inventory_witness(witness))
  }
  let attestations : Array[@cbor.CborValue] = []
  for attestation in bundle.attestations {
    attestations.push(encode_inventory_signed_attestation(attestation))
  }
  let proofs : Array[@cbor.CborValue] = []
  for proof in bundle.proofs {
    proofs.push(encode_inventory_proof(proof))
  }
  @cbor.CborValue::Array([
    wire_int(INVENTORY_CHECKPOINT_WIRE_VERSION),
    encode_signed_checkpoint(bundle.signed_checkpoint),
    @cbor.CborValue::Text(bundle.game_manifest_digest.0),
    @cbor.CborValue::Array(witnesses),
    wire_int(bundle.max_faults),
    @cbor.CborValue::Array(attestations),
    @cbor.CborValue::Array(proofs),
  ])
}

///|
pub fn encode_inventory_checkpoint_proof_bundle(
  bundle : InventoryCheckpointProofBundle,
) -> Bytes {
  @cbor.encode(encode_inventory_checkpoint_value(bundle))
}

///|
pub fn decode_inventory_checkpoint_proof_bundle(
  input : Bytes,
  limits~ : InventoryCheckpointWireLimits,
) -> Result[InventoryCheckpointProofBundle, InventoryCheckpointWireError] {
  if input.length() > limits.max_bundle_bytes {
    return Err(
      InventoryCheckpointWireInputTooLarge(
        input.length(),
        limits.max_bundle_bytes,
      ),
    )
  }
  preflight_cbor(input) catch {
    _ => return Err(InventoryCheckpointWireMalformedCbor)
  }
  let value = @cbor.decode(input) catch {
    _ => return Err(InventoryCheckpointWireMalformedCbor)
  }
  if @cbor.encode(value) != input {
    return Err(InventoryCheckpointWireNonCanonicalEncoding)
  }
  let fields = decode_wire_array(value, 7) catch {
    error => return Err(InventoryCheckpointWireCodecRefused(error))
  }
  let version = decode_wire_int(fields[0]) catch {
    error => return Err(InventoryCheckpointWireCodecRefused(error))
  }
  if version != INVENTORY_CHECKPOINT_WIRE_VERSION {
    return Err(InventoryCheckpointWireUnsupportedVersion(version))
  }
  let encoded_witnesses = inventory_wire_items(fields[3]) catch {
    error => return Err(InventoryCheckpointWireCodecRefused(error))
  }
  if encoded_witnesses.length() > limits.max_witnesses {
    return Err(
      InventoryCheckpointWireWitnessesTooMany(
        encoded_witnesses.length(),
        limits.max_witnesses,
      ),
    )
  }
  let encoded_attestations = inventory_wire_items(fields[5]) catch {
    error => return Err(InventoryCheckpointWireCodecRefused(error))
  }
  if encoded_attestations.length() > limits.max_attestations {
    return Err(
      InventoryCheckpointWireAttestationsTooMany(
        encoded_attestations.length(),
        limits.max_attestations,
      ),
    )
  }
  let encoded_proofs = inventory_wire_items(fields[6]) catch {
    error => return Err(InventoryCheckpointWireCodecRefused(error))
  }
  if encoded_proofs.is_empty() {
    return Err(InventoryCheckpointWireMissingProofs)
  }
  if encoded_proofs.length() > limits.max_proofs {
    return Err(
      InventoryCheckpointWireProofsTooMany(
        encoded_proofs.length(),
        limits.max_proofs,
      ),
    )
  }
  let codec_limits = inventory_checkpoint_codec_limits(limits)
  let witnesses : Array[@witness_manifest.ReplayWitnessIdentity] = []
  for encoded in encoded_witnesses {
    let witness = decode_inventory_witness(encoded, codec_limits) catch {
      error => return Err(InventoryCheckpointWireCodecRefused(error))
    }
    witnesses.push(witness)
  }
  let attestations : Array[@attestation.SignedAttestation] = []
  for encoded in encoded_attestations {
    let attestation = decode_inventory_signed_attestation(encoded, codec_limits) catch {
      error => return Err(InventoryCheckpointWireCodecRefused(error))
    }
    attestations.push(attestation)
  }
  let proofs : Array[@inventory.InventoryProof] = []
  let mut previous_asset_id = ""
  for index, encoded in encoded_proofs {
    let proof = decode_inventory_proof(encoded, codec_limits) catch {
      error => return Err(InventoryCheckpointWireCodecRefused(error))
    }
    if index > 0 && proof.record.asset_id <= previous_asset_id {
      return Err(InventoryCheckpointWireNonCanonicalAssets(index))
    }
    previous_asset_id = proof.record.asset_id
    proofs.push(proof)
  }
  let signed_checkpoint = decode_signed_checkpoint(fields[1], codec_limits) catch {
    error => return Err(InventoryCheckpointWireCodecRefused(error))
  }
  let game_manifest_digest = decode_wire_digest(fields[2], codec_limits) catch {
    error => return Err(InventoryCheckpointWireCodecRefused(error))
  }
  let max_faults = decode_wire_int(fields[4]) catch {
    error => return Err(InventoryCheckpointWireCodecRefused(error))
  }
  Ok({
    signed_checkpoint,
    game_manifest_digest,
    witnesses,
    max_faults,
    attestations,
    proofs,
  })
}
