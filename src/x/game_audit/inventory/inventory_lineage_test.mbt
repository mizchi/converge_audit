///|
priv struct AssetLineageFixture {
  authority : @bft.MockSigner
  origin : @market.ItemReceipt
  anchor : AssetLineageAnchor
  current : AssetRecord
  slice : AssetLineageSlice
}

///|
fn asset_lineage_fixture() -> AssetLineageFixture {
  let hasher = @bft.FnvHasher::new()
  let authority = @bft.MockSigner::new("inventory-authority")
  let alice = @bft.MockSigner::new("alice-key")
  let bob = @bft.MockSigner::new("bob-key")
  let origin : @market.ItemReceipt = {
    asset_id: "asset-1",
    recipient_id: "alice",
    item_type: "raid-token",
    quantity: 1,
    source_event: @bft.Digest("loot-event"),
    output_index: 0,
  }
  let anchor = origin_asset_lineage_anchor(hasher, origin)
  let transition : AssetLineageTransition = {
    asset_id: origin.asset_id,
    origin_receipt_digest: anchor.origin_receipt_digest,
    from_owner: "alice",
    to_owner: "bob",
    expected_version: 0,
    previous_event: anchor.last_event,
    source_event: @bft.Digest("transfer-event"),
    previous_lineage_root: anchor.lineage_root,
  }
  let sender_binding = sign_asset_owner_key_binding(hasher, authority, {
    session_id: "inventory-session",
    owner_id: "alice",
    owner_key: alice.public_key(),
  })
  let recipient_binding = sign_asset_owner_key_binding(hasher, authority, {
    session_id: "inventory-session",
    owner_id: "bob",
    owner_key: bob.public_key(),
  })
  let signed_transfer = sign_asset_lineage_transfer(
    hasher,
    alice,
    bob,
    session_id="inventory-session",
    transition~,
  )
  let current : AssetRecord = {
    asset_id: origin.asset_id,
    owner_id: "bob",
    item_type: origin.item_type,
    quantity: origin.quantity,
    origin_source_event: origin.source_event,
    origin_output_index: origin.output_index,
    origin_receipt_digest: anchor.origin_receipt_digest,
    version: 1,
    last_event: transition.source_event,
    lineage_root: asset_lineage_transition_root(hasher, transition),
  }
  {
    authority,
    origin,
    anchor,
    current,
    slice: {
      anchor,
      transfers: [{ signed_transfer, sender_binding, recipient_binding }],
    },
  }
}

///|
fn verify_asset_lineage_fixture(
  fixture : AssetLineageFixture,
  slice? : AssetLineageSlice = fixture.slice,
  current? : AssetRecord = fixture.current,
) -> AssetLineageVerificationResult {
  verify_asset_lineage_slice(
    @bft.FnvHasher::new(),
    @bft.MockVerifier::new(),
    slice,
    expected_session_id="inventory-session",
    expected_authority_key=fixture.authority.public_key(),
    expected_origin_receipt_digest=inventory_origin_receipt_digest(
      @bft.FnvHasher::new(),
      fixture.origin,
    ),
    expected_anchor=fixture.anchor,
    expected_current=current,
    max_transfers=64,
  )
}

///|
test "bounded lineage slice binds origin exact parent and current root" {
  let fixture = asset_lineage_fixture()
  match verify_asset_lineage_fixture(fixture) {
    AssetLineageVerified(verified) => {
      assert_eq(verified.transfer_count(), 1)
      assert_true(verified.contains_event(@bft.Digest("transfer-event")))
      assert_eq(
        verified.final_anchor(),
        asset_record_lineage_anchor(fixture.current),
      )
    }
    _ => fail("expected authenticated asset lineage slice")
  }
}

///|
test "lineage slice rejects missing and oversized transition evidence" {
  let fixture = asset_lineage_fixture()
  match
    verify_asset_lineage_fixture(fixture, slice={
      ..fixture.slice,
      transfers: [],
    }) {
    AssetLineageRefused(MissingAssetLineageTransfers) => ()
    _ => fail("missing lineage slice was accepted")
  }
  match
    verify_asset_lineage_slice(
      @bft.FnvHasher::new(),
      @bft.MockVerifier::new(),
      fixture.slice,
      expected_session_id="inventory-session",
      expected_authority_key=fixture.authority.public_key(),
      expected_origin_receipt_digest=inventory_origin_receipt_digest(
        @bft.FnvHasher::new(),
        fixture.origin,
      ),
      expected_anchor=fixture.anchor,
      expected_current=fixture.current,
      max_transfers=0,
    ) {
    AssetLineageRefused(AssetLineageTransfersTooMany(1, 0)) => ()
    _ => fail("oversized lineage slice was accepted")
  }
}

///|
test "lineage slice rejects wrong parent version and cross-asset transition" {
  let fixture = asset_lineage_fixture()
  let entry = fixture.slice.transfers[0]
  let authorization = entry.signed_transfer.authorization
  let transition = authorization.transition
  let cases : Array[(AssetLineageTransition, AssetLineageRefusal)] = [
    (
      { ..transition, previous_event: @bft.Digest("wrong-parent") },
      AssetLineageParentMismatch(0),
    ),
    ({ ..transition, expected_version: 7 }, AssetLineageVersionMismatch(0)),
    ({ ..transition, asset_id: "asset-2" }, AssetLineageAssetMismatch(0)),
  ]
  for case in cases {
    let (changed, expected) = case
    let changed_entry = {
      ..entry,
      signed_transfer: {
        ..entry.signed_transfer,
        authorization: { ..authorization, transition: changed },
      },
    }
    assert_eq(
      verify_asset_lineage_fixture(fixture, slice={
        ..fixture.slice,
        transfers: [changed_entry],
      }),
      AssetLineageVerificationResult::AssetLineageRefused(expected),
    )
  }
}

///|
test "lineage slice rejects authority sender and recipient signature tampering" {
  let fixture = asset_lineage_fixture()
  let entry = fixture.slice.transfers[0]
  let cases : Array[AuthenticatedAssetLineageTransfer] = [
    { ..entry, recipient_binding: entry.sender_binding },
    {
      ..entry,
      sender_binding: {
        ..entry.sender_binding,
        signature: @bft.Signature("tampered-authority-signature"),
      },
    },
    {
      ..entry,
      signed_transfer: {
        ..entry.signed_transfer,
        sender_signature: @bft.Signature("tampered-sender-signature"),
      },
    },
    {
      ..entry,
      signed_transfer: {
        ..entry.signed_transfer,
        recipient_signature: @bft.Signature("tampered-recipient-signature"),
      },
    },
  ]
  for changed in cases {
    match
      verify_asset_lineage_fixture(fixture, slice={
        ..fixture.slice,
        transfers: [changed],
      }) {
      AssetLineageRefused(AssetLineageAuthenticationRefused(0)) => ()
      _ => fail("tampered lineage authentication was accepted")
    }
  }
}

///|
test "lineage slice cannot terminate at an uncommitted current record" {
  let fixture = asset_lineage_fixture()
  match
    verify_asset_lineage_fixture(fixture, current={
      ..fixture.current,
      lineage_root: @bft.Digest("other-root"),
    }) {
    AssetLineageRefused(AssetLineageCurrentRecordMismatch) => ()
    _ => fail("lineage slice with a foreign terminal root was accepted")
  }
}
