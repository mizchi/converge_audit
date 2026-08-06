///|
fn inventory_listing_wire_bundle() -> InventoryListingProofBundle raise Error {
  let hasher = @bft.FnvHasher::new()
  let record = @inventory.AssetRecord::{
    asset_id: "asset-1",
    owner_id: "bob",
    item_type: "raid-token",
    quantity: 1,
    origin_source_event: @bft.Digest("loot-event"),
    origin_output_index: 0,
    origin_receipt_digest: @bft.Digest("origin-receipt"),
    version: 1,
    last_event: @bft.Digest("transfer-event"),
    lineage_root: @bft.Digest("lineage-root"),
  }
  let state = @authmap.AuthenticatedMap::new(hasher)
  ignore(state.put(record.asset_id, @inventory.serialize_asset_record(record)))
  let map_proof = match state.proof(record.asset_id) {
    Some(value) => value
    None => fail("expected inventory map proof")
  }
  let checkpoint_digest = @bft.Digest("inventory-checkpoint-1")
  {
    signed_checkpoint: {
      checkpoint: {
        session_id: "inventory-session",
        epoch: 1,
        previous_checkpoint: @bft.Digest("creation-checkpoint"),
        manifest_digest: @bft.Digest("witness-manifest"),
        event_root: @bft.Digest("inventory-events"),
        public_state_root: state.root(),
        asset_delta_root: @bft.Digest("no-new-assets"),
        hidden_state_commitment: None,
      },
      digest: checkpoint_digest,
      signature: @bft.Signature("checkpoint-signature"),
      authority_key: @bft.PublicKey("authority-key"),
    },
    game_manifest_digest: @bft.Digest("canonical-asset-kernel-v1"),
    witnesses: [{ id: "witness-0", key: @bft.PublicKey("witness-key") }],
    max_faults: 0,
    attestations: [
      {
        attestation: {
          checkpoint_digest,
          participant_id: "witness-0",
          purpose: @attestation.AttestationPurpose::ReplayWitness,
          choice: @attestation.AttestationChoice::Approve,
        },
        digest: @bft.Digest("attestation-digest"),
        signature: @bft.Signature("attestation-signature"),
        signer_key: @bft.PublicKey("witness-key"),
      },
    ],
    proof: { record, map_proof },
  }
}

///|
test "inventory listing proof bundle has a canonical versioned round trip" {
  let bundle = inventory_listing_wire_bundle()
  let encoded = encode_inventory_listing_proof_bundle(bundle)
  let decoded = match
    decode_inventory_listing_proof_bundle(
      encoded,
      limits=InventoryListingWireLimits::default(),
    ) {
    Ok(value) => value
    Err(_) => fail("expected inventory listing proof bundle decode")
  }
  assert_eq(encode_inventory_listing_proof_bundle(decoded), encoded)
  assert_eq(decoded, bundle)
}

///|
test "inventory listing wire rejects versions and resource excess" {
  let bundle = inventory_listing_wire_bundle()
  let encoded = encode_inventory_listing_proof_bundle(bundle)
  let defaults = InventoryListingWireLimits::default()
  match
    decode_inventory_listing_proof_bundle(
      replace_canonical_version(encoded, b'\x03'),
      limits=defaults,
    ) {
    Err(InventoryListingWireError::InventoryWireUnsupportedVersion(3)) => ()
    _ => fail("expected inventory listing version refusal")
  }
  match
    decode_inventory_listing_proof_bundle(
      make_noncanonical_version(encoded),
      limits=defaults,
    ) {
    Err(InventoryListingWireError::InventoryWireNonCanonicalEncoding) => ()
    _ => fail("expected noncanonical inventory listing refusal")
  }
  match
    decode_inventory_listing_proof_bundle(encoded, limits={
      ..defaults,
      max_bundle_bytes: encoded.length() - 1,
    }) {
    Err(InventoryListingWireError::InventoryWireInputTooLarge(actual, maximum)) => {
      assert_eq(actual, encoded.length())
      assert_eq(maximum, encoded.length() - 1)
    }
    _ => fail("expected inventory listing byte-budget refusal")
  }
  match
    decode_inventory_listing_proof_bundle(encoded, limits={
      ..defaults,
      max_witnesses: 0,
    }) {
    Err(InventoryListingWireError::InventoryWireWitnessesTooMany(1, 0)) => ()
    _ => fail("expected inventory listing witness-budget refusal")
  }
  match
    decode_inventory_listing_proof_bundle(encoded, limits={
      ..defaults,
      max_attestations: 0,
    }) {
    Err(InventoryListingWireError::InventoryWireAttestationsTooMany(1, 0)) => ()
    _ => fail("expected inventory listing attestation-budget refusal")
  }
  match
    decode_inventory_listing_proof_bundle(encoded, limits={
      ..defaults,
      max_proof_steps: -1,
    }) {
    Err(
      InventoryListingWireError::InventoryWireCodecRefused(
        OpenWorldAuditWireError::WireProofTooLong(0, -1)
      )
    ) => ()
    _ => fail("expected inventory listing proof-budget refusal")
  }
}

///|
fn inventory_lineage_wire_bundle() -> InventoryLineageProofBundle raise Error {
  let transition : @inventory.AssetLineageTransition = {
    asset_id: "asset-1",
    origin_receipt_digest: @bft.Digest("origin-receipt"),
    from_owner: "alice",
    to_owner: "bob",
    expected_version: 0,
    previous_event: @bft.Digest("loot-event"),
    source_event: @bft.Digest("transfer-event"),
    previous_lineage_root: @bft.Digest("origin-root"),
  }
  let sender_binding : @inventory.SignedAssetOwnerKeyBinding = {
    binding: {
      session_id: "inventory-session",
      owner_id: "alice",
      owner_key: @bft.PublicKey("alice-key"),
    },
    digest: @bft.Digest("alice-binding-digest"),
    signature: @bft.Signature("alice-binding-signature"),
    authority_key: @bft.PublicKey("authority-key"),
  }
  let recipient_binding : @inventory.SignedAssetOwnerKeyBinding = {
    binding: {
      session_id: "inventory-session",
      owner_id: "bob",
      owner_key: @bft.PublicKey("bob-key"),
    },
    digest: @bft.Digest("bob-binding-digest"),
    signature: @bft.Signature("bob-binding-signature"),
    authority_key: @bft.PublicKey("authority-key"),
  }
  {
    listing: inventory_listing_wire_bundle(),
    lineage: {
      anchor: {
        asset_id: "asset-1",
        owner_id: "alice",
        version: 0,
        last_event: @bft.Digest("loot-event"),
        lineage_root: @bft.Digest("origin-root"),
        origin_receipt_digest: @bft.Digest("origin-receipt"),
      },
      transfers: [
        {
          signed_transfer: {
            authorization: {
              session_id: "inventory-session",
              transition,
              sender_key: @bft.PublicKey("alice-key"),
              recipient_key: @bft.PublicKey("bob-key"),
            },
            digest: @bft.Digest("transfer-digest"),
            sender_signature: @bft.Signature("sender-signature"),
            recipient_signature: @bft.Signature("recipient-signature"),
          },
          sender_binding,
          recipient_binding,
        },
      ],
    },
  }
}

///|
test "inventory lineage bundle has a canonical bounded round trip" {
  let bundle = inventory_lineage_wire_bundle()
  let encoded = encode_inventory_lineage_proof_bundle(bundle)
  let decoded = match
    decode_inventory_lineage_proof_bundle(
      encoded,
      limits=InventoryLineageWireLimits::default(),
    ) {
    Ok(value) => value
    Err(_) => fail("expected inventory lineage proof bundle decode")
  }
  assert_eq(decoded, bundle)
  assert_eq(encode_inventory_lineage_proof_bundle(decoded), encoded)
}

///|
test "inventory lineage wire rejects unsupported versions and transfer excess" {
  let bundle = inventory_lineage_wire_bundle()
  let encoded = encode_inventory_lineage_proof_bundle(bundle)
  let defaults = InventoryLineageWireLimits::default()
  match
    decode_inventory_lineage_proof_bundle(
      replace_canonical_version(encoded, b'\x03'),
      limits=defaults,
    ) {
    Err(InventoryLineageWireUnsupportedVersion(3)) => ()
    _ => fail("expected inventory lineage version refusal")
  }
  match
    decode_inventory_lineage_proof_bundle(encoded, limits={
      ..defaults,
      max_transfers: 0,
    }) {
    Err(InventoryLineageWireTransfersTooMany(1, 0)) => ()
    _ => fail("expected inventory lineage transfer-budget refusal")
  }
}
