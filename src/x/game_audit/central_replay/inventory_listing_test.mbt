///|
priv struct InventoryListingCentralFixture {
  session_id : String
  authority_key : @bft.PublicKey
  checkpoint_digest : @bft.Digest
  origin : @market.ItemReceipt
  bundle : @wire.InventoryListingProofBundle
}

///|
fn inventory_listing_central_fixture() -> InventoryListingCentralFixture raise Error {
  let hasher = @bft.FnvHasher::new()
  let authority = @bft.MockSigner::new("inventory-authority")
  let origin = @market.ItemReceipt::{
    asset_id: "asset-1",
    recipient_id: "alice",
    item_type: "raid-token",
    quantity: 1,
    source_event: @bft.Digest("loot-event"),
    output_index: 0,
  }
  let anchor = @inventory.origin_asset_lineage_anchor(hasher, origin)
  let transfer : @inventory.AssetLineageTransition = {
    asset_id: origin.asset_id,
    origin_receipt_digest: anchor.origin_receipt_digest,
    from_owner: "alice",
    to_owner: "bob",
    expected_version: 0,
    previous_event: anchor.last_event,
    source_event: @bft.Digest("transfer-event"),
    previous_lineage_root: anchor.lineage_root,
  }
  let record = @inventory.AssetRecord::{
    asset_id: origin.asset_id,
    owner_id: "bob",
    item_type: origin.item_type,
    quantity: origin.quantity,
    origin_source_event: origin.source_event,
    origin_output_index: origin.output_index,
    origin_receipt_digest: anchor.origin_receipt_digest,
    version: 1,
    last_event: transfer.source_event,
    lineage_root: @inventory.asset_lineage_transition_root(hasher, transfer),
  }
  let state = @authmap.AuthenticatedMap::new(hasher)
  ignore(state.put(record.asset_id, @inventory.serialize_asset_record(record)))
  let map_proof = match state.proof(record.asset_id) {
    Some(value) => value
    None => fail("expected inventory proof")
  }
  let witness_signers : Array[@bft.MockSigner] = []
  let witnesses : Array[@witness_manifest.ReplayWitnessIdentity] = []
  let participants : Array[@attestation.Participant] = []
  for index in 0..<4 {
    let id = "inventory-witness-" + index.to_string()
    let signer = @bft.MockSigner::new(id)
    witness_signers.push(signer)
    witnesses.push({ id, key: signer.public_key() })
    participants.push({ id, key: signer.public_key() })
  }
  let game_manifest_digest = @bft.Digest("canonical-asset-kernel-v1")
  let session_id = "inventory-session"
  let prepared = @checkpoint.prepare_checkpoint(hasher, {
    session_id,
    epoch: 1,
    previous_checkpoint: @bft.Digest("creation-checkpoint"),
    manifest_digest: @attestation.replay_witness_session_manifest(
      hasher,
      game_manifest_digest~,
      referee_key=authority.public_key(),
      witnesses=participants,
      max_faults=1,
    ),
    event_root: @bft.Digest("inventory-events"),
    public_state_root: state.root(),
    asset_delta_root: @bft.Digest("no-new-assets"),
    hidden_state_commitment: None,
  })
  let signed_checkpoint = @checkpoint.sign_prepared_checkpoint(
    authority, prepared,
  )
  let attestations : Array[@attestation.SignedAttestation] = []
  for index in 0..<3 {
    attestations.push(
      @attestation.sign_replay_witness_attestation(
        hasher,
        witness_signers[index],
        prepared,
        witnesses[index].id,
        @attestation.AttestationChoice::Approve,
      ),
    )
  }
  {
    session_id,
    authority_key: authority.public_key(),
    checkpoint_digest: signed_checkpoint.digest,
    origin,
    bundle: {
      signed_checkpoint,
      game_manifest_digest,
      witnesses,
      max_faults: 1,
      attestations,
      proof: { record, map_proof },
    },
  }
}

///|
fn inventory_lineage_central_bundle(
  fixture : InventoryListingCentralFixture,
) -> @wire.InventoryLineageProofBundle {
  let hasher = @bft.FnvHasher::new()
  let authority = @bft.MockSigner::new("inventory-authority")
  let alice = @bft.MockSigner::new("alice-lineage-key")
  let bob = @bft.MockSigner::new("bob-lineage-key")
  let anchor = @inventory.origin_asset_lineage_anchor(hasher, fixture.origin)
  let transition : @inventory.AssetLineageTransition = {
    asset_id: fixture.origin.asset_id,
    origin_receipt_digest: anchor.origin_receipt_digest,
    from_owner: "alice",
    to_owner: "bob",
    expected_version: 0,
    previous_event: anchor.last_event,
    source_event: fixture.bundle.proof.record.last_event,
    previous_lineage_root: anchor.lineage_root,
  }
  let sender_binding = @inventory.sign_asset_owner_key_binding(
    hasher,
    authority,
    {
      session_id: fixture.session_id,
      owner_id: "alice",
      owner_key: alice.public_key(),
    },
  )
  let recipient_binding = @inventory.sign_asset_owner_key_binding(
    hasher,
    authority,
    {
      session_id: fixture.session_id,
      owner_id: "bob",
      owner_key: bob.public_key(),
    },
  )
  {
    listing: fixture.bundle,
    lineage: {
      anchor,
      transfers: [
        {
          signed_transfer: @inventory.sign_asset_lineage_transfer(
            hasher,
            alice,
            bob,
            session_id=fixture.session_id,
            transition~,
          ),
          sender_binding,
          recipient_binding,
        },
      ],
    },
  }
}

///|
fn verify_inventory_lineage_fixture(
  fixture : InventoryListingCentralFixture,
  bundle : @wire.InventoryLineageProofBundle,
) -> InventoryLineageCentralResult {
  verify_inventory_lineage_proof_bundle(
    @bft.FnvHasher::new(),
    @bft.MockVerifier::new(),
    @wire.encode_inventory_lineage_proof_bundle(bundle),
    expected_session_id=fixture.session_id,
    expected_authority_key=fixture.authority_key,
    expected_checkpoint_digest=fixture.checkpoint_digest,
    expected_game_manifest_digest=fixture.bundle.game_manifest_digest,
    expected_origin=fixture.origin,
    expected_seller_id="bob",
    expected_anchor=@inventory.origin_asset_lineage_anchor(
      @bft.FnvHasher::new(),
      fixture.origin,
    ),
    limits=@wire.InventoryLineageWireLimits::default(),
  )
}

///|
test "central lineage proof binds bounded history to current checkpoint" {
  let fixture = inventory_listing_central_fixture()
  let bundle = inventory_lineage_central_bundle(fixture)
  match verify_inventory_lineage_fixture(fixture, bundle) {
    InventoryLineageCentralVerified(verified) => {
      assert_eq(verified.asset_id(), "asset-1")
      assert_eq(verified.current_owner_id(), "bob")
      assert_eq(verified.transfer_count(), 1)
      assert_true(verified.contains_event(@bft.Digest("transfer-event")))
      assert_eq(verified.final_anchor().version, 1)
    }
    _ => fail("expected central historical lineage verification")
  }
}

///|
test "central lineage proof rejects an omitted slice" {
  let fixture = inventory_listing_central_fixture()
  let bundle = inventory_lineage_central_bundle(fixture)
  match
    verify_inventory_lineage_fixture(fixture, {
      ..bundle,
      lineage: { ..bundle.lineage, transfers: [] },
    }) {
    InventoryLineageCentralRefused(
      InventoryLineageVerificationRefused(
        @inventory.AssetLineageRefusal::MissingAssetLineageTransfers
      )
    ) => ()
    _ => fail("central verifier accepted missing lineage evidence")
  }
}

///|
fn verify_inventory_listing_fixture(
  fixture : InventoryListingCentralFixture,
  bundle : @wire.InventoryListingProofBundle,
  seller_id? : String = "bob",
  origin? : @market.ItemReceipt = fixture.origin,
) -> InventoryListingCentralResult {
  verify_inventory_listing_proof_bundle(
    @bft.FnvHasher::new(),
    @bft.MockVerifier::new(),
    @wire.encode_inventory_listing_proof_bundle(bundle),
    expected_session_id=fixture.session_id,
    expected_authority_key=fixture.authority_key,
    expected_checkpoint_digest=fixture.checkpoint_digest,
    expected_game_manifest_digest=bundle.game_manifest_digest,
    expected_origin=origin,
    expected_seller_id=seller_id,
    rejected_ancestor=false,
    limits=@wire.InventoryListingWireLimits::default(),
  )
}

///|
test "central inventory proof accepts only the current owner and exact origin" {
  let fixture = inventory_listing_central_fixture()
  match verify_inventory_listing_fixture(fixture, fixture.bundle) {
    InventoryListingVerified(verified) => {
      assert_eq(verified.asset_id(), "asset-1")
      assert_eq(verified.current_owner_id(), "bob")
      assert_eq(verified.version(), 1)
      assert_eq(verified.epoch(), 1)
      assert_eq(
        verified.previous_checkpoint(),
        @bft.Digest("creation-checkpoint"),
      )
      assert_eq(verified.approval_count(), 3)
      assert_eq(verified.required_approvals(), 3)
    }
    _ => fail("expected current-owner listing verification")
  }
  match
    verify_inventory_listing_fixture(fixture, fixture.bundle, seller_id="alice") {
    InventoryListingRefused(InventoryCurrentOwnerProofRefused) => ()
    _ => fail("stale initial owner was accepted")
  }
  match
    verify_inventory_listing_fixture(fixture, fixture.bundle, origin={
      ..fixture.origin,
      recipient_id: "mallory",
    }) {
    InventoryListingRefused(InventoryOriginMismatch) => ()
    _ => fail("foreign origin receipt was accepted")
  }
}

///|
test "central inventory proof fails closed on stale boundary quorum and tampering" {
  let fixture = inventory_listing_central_fixture()
  assert_eq(
    verify_inventory_listing_proof_bundle(
      @bft.FnvHasher::new(),
      @bft.MockVerifier::new(),
      @wire.encode_inventory_listing_proof_bundle(fixture.bundle),
      expected_session_id=fixture.session_id,
      expected_authority_key=fixture.authority_key,
      expected_checkpoint_digest=@bft.Digest("stale-checkpoint"),
      expected_game_manifest_digest=fixture.bundle.game_manifest_digest,
      expected_origin=fixture.origin,
      expected_seller_id="bob",
      rejected_ancestor=false,
      limits=@wire.InventoryListingWireLimits::default(),
    ),
    InventoryListingCentralResult::InventoryListingRefused(
      InventoryListingCentralRefusal::InventoryExpectedCheckpointMismatch,
    ),
  )
  let attestations = fixture.bundle.attestations
  let under_quorum = @wire.InventoryListingProofBundle::{
    ..fixture.bundle,
    attestations: [attestations[0], attestations[1]],
  }
  assert_eq(
    verify_inventory_listing_fixture(fixture, under_quorum),
    InventoryListingCentralResult::InventoryListingRefused(
      InventoryListingCentralRefusal::InventoryWitnessQuorumPending(2, 3),
    ),
  )
  let proof = fixture.bundle.proof
  let tampered = @wire.InventoryListingProofBundle::{
    ..fixture.bundle,
    proof: { ..proof, record: { ..proof.record, version: 2 } },
  }
  match verify_inventory_listing_fixture(fixture, tampered) {
    InventoryListingRefused(InventoryCurrentOwnerProofRefused) => ()
    _ => fail("tampered inventory version was accepted")
  }
}

///|
priv struct InventoryCheckpointCentralFixture {
  session_id : String
  authority_key : @bft.PublicKey
  checkpoint_digest : @bft.Digest
  game_manifest_digest : @bft.Digest
  expected_assets : Array[ExpectedInventoryCheckpointAsset]
  bundle : @wire.InventoryCheckpointProofBundle
}

///|
fn inventory_checkpoint_central_fixture() -> InventoryCheckpointCentralFixture raise Error {
  let hasher = @bft.FnvHasher::new()
  let authority = @bft.MockSigner::new("inventory-authority")
  let session_id = "inventory-session"
  let previous_checkpoint = @bft.Digest("creation-checkpoint")
  let origins : Array[@market.ItemReceipt] = []
  let records : Array[@inventory.AssetRecord] = []
  for index in 0..<2 {
    let asset_id = "asset-" + (index + 1).to_string()
    let origin : @market.ItemReceipt = {
      asset_id,
      recipient_id: "alice",
      item_type: "raid-token",
      quantity: index + 1,
      source_event: @bft.Digest("loot-event-" + index.to_string()),
      output_index: index,
    }
    let anchor = @inventory.origin_asset_lineage_anchor(hasher, origin)
    let transition : @inventory.AssetLineageTransition = {
      asset_id,
      origin_receipt_digest: anchor.origin_receipt_digest,
      from_owner: "alice",
      to_owner: "bob",
      expected_version: 0,
      previous_event: anchor.last_event,
      source_event: @bft.Digest("transfer-event-" + index.to_string()),
      previous_lineage_root: anchor.lineage_root,
    }
    origins.push(origin)
    records.push({
      asset_id,
      owner_id: "bob",
      item_type: origin.item_type,
      quantity: origin.quantity,
      origin_source_event: origin.source_event,
      origin_output_index: origin.output_index,
      origin_receipt_digest: anchor.origin_receipt_digest,
      version: 1,
      last_event: transition.source_event,
      lineage_root: @inventory.asset_lineage_transition_root(hasher, transition),
    })
  }
  let state = @authmap.AuthenticatedMap::new(hasher)
  for record in records {
    ignore(
      state.put(record.asset_id, @inventory.serialize_asset_record(record)),
    )
  }
  let proofs : Array[@inventory.InventoryProof] = []
  for record in records {
    let map_proof = match state.proof(record.asset_id) {
      Some(value) => value
      None => fail("expected multi-asset inventory proof")
    }
    proofs.push({ record, map_proof })
  }
  let witness_signers : Array[@bft.MockSigner] = []
  let witnesses : Array[@witness_manifest.ReplayWitnessIdentity] = []
  let participants : Array[@attestation.Participant] = []
  for index in 0..<4 {
    let id = "inventory-witness-" + index.to_string()
    let signer = @bft.MockSigner::new(id)
    witness_signers.push(signer)
    witnesses.push({ id, key: signer.public_key() })
    participants.push({ id, key: signer.public_key() })
  }
  let game_manifest_digest = @bft.Digest("canonical-asset-kernel-v1")
  let prepared = @checkpoint.prepare_checkpoint(hasher, {
    session_id,
    epoch: 1,
    previous_checkpoint,
    manifest_digest: @attestation.replay_witness_session_manifest(
      hasher,
      game_manifest_digest~,
      referee_key=authority.public_key(),
      witnesses=participants,
      max_faults=1,
    ),
    event_root: @bft.Digest("inventory-events"),
    public_state_root: state.root(),
    asset_delta_root: @bft.Digest("no-new-assets"),
    hidden_state_commitment: None,
  })
  let signed_checkpoint = @checkpoint.sign_prepared_checkpoint(
    authority, prepared,
  )
  let attestations : Array[@attestation.SignedAttestation] = []
  for index in 0..<3 {
    attestations.push(
      @attestation.sign_replay_witness_attestation(
        hasher,
        witness_signers[index],
        prepared,
        witnesses[index].id,
        @attestation.AttestationChoice::Approve,
      ),
    )
  }
  let expected_assets : Array[ExpectedInventoryCheckpointAsset] = []
  for origin in origins {
    expected_assets.push({
      origin,
      current_owner_id: "alice",
      current_version: 0,
      current_checkpoint_digest: previous_checkpoint,
      current_epoch: 0,
      creation_eligible: true,
      lineage_clean: true,
    })
  }
  {
    session_id,
    authority_key: authority.public_key(),
    checkpoint_digest: signed_checkpoint.digest,
    game_manifest_digest,
    expected_assets,
    bundle: {
      signed_checkpoint,
      game_manifest_digest,
      witnesses,
      max_faults: 1,
      attestations,
      proofs,
    },
  }
}

///|
fn verify_inventory_checkpoint_fixture(
  fixture : InventoryCheckpointCentralFixture,
  expected_assets? : Array[ExpectedInventoryCheckpointAsset] = fixture.expected_assets,
) -> InventoryCheckpointCentralResult {
  verify_inventory_checkpoint_proof_bundle(
    @bft.FnvHasher::new(),
    @bft.MockVerifier::new(),
    @wire.encode_inventory_checkpoint_proof_bundle(fixture.bundle),
    expected_session_id=fixture.session_id,
    expected_authority_key=fixture.authority_key,
    expected_checkpoint_digest=fixture.checkpoint_digest,
    expected_game_manifest_digest=fixture.game_manifest_digest,
    expected_assets~,
    limits=@wire.InventoryCheckpointWireLimits::default(),
  )
}

///|
test "central multi-asset checkpoint verifies one shared certificate and every head" {
  let fixture = inventory_checkpoint_central_fixture()
  match verify_inventory_checkpoint_fixture(fixture) {
    InventoryCheckpointCentralVerified(verified) => {
      assert_eq(verified.asset_count(), 2)
      assert_eq(verified.epoch(), 1)
      assert_eq(
        verified.previous_checkpoint(),
        @bft.Digest("creation-checkpoint"),
      )
      assert_eq(verified.records()[0].asset_id, "asset-1")
      assert_eq(verified.records()[1].asset_id, "asset-2")
      assert_true(verified.write_set_digest().0 != "")
    }
    _ => fail("expected central multi-asset checkpoint verification")
  }
}

///|
test "central multi-asset checkpoint rejects one stale or revoked member" {
  let fixture = inventory_checkpoint_central_fixture()
  let stale = fixture.expected_assets.copy()
  stale[1] = { ..stale[1], current_version: 1 }
  match verify_inventory_checkpoint_fixture(fixture, expected_assets=stale) {
    InventoryCheckpointCentralRefused(
      InventoryCheckpointAssetHeadVersionMismatch(1)
    ) => ()
    _ => fail("expected one stale asset to reject the whole checkpoint")
  }
  let revoked = fixture.expected_assets.copy()
  revoked[1] = { ..revoked[1], lineage_clean: false }
  match verify_inventory_checkpoint_fixture(fixture, expected_assets=revoked) {
    InventoryCheckpointCentralRefused(InventoryCheckpointAssetLineageRevoked(1)) =>
      ()
    _ => fail("expected one revoked asset to reject the whole checkpoint")
  }
}
