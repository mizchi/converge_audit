///|
test "lineage transition commitment binds its parent and Unicode fields" {
  let hasher = @bft.FnvHasher::new()
  let transition : InventoryLineageTransition = {
    asset_id: "asset-雪😀",
    origin_receipt_digest: @bft.Digest("origin-digest"),
    from_owner: "alice-猫",
    to_owner: "bob-犬",
    expected_version: 2,
    previous_event: @bft.Digest("previous-event"),
    source_event: @bft.Digest("transfer-event"),
    previous_lineage_root: @bft.Digest("previous-root"),
  }
  assert_true(inventory_lineage_transition_valid(transition))
  assert_eq(
    inventory_lineage_transition_root(hasher, transition),
    hasher.hash_string(serialize_inventory_lineage_transition(transition)),
  )
  assert_not_eq(
    inventory_lineage_transition_root(hasher, transition),
    inventory_lineage_transition_root(hasher, {
      ..transition,
      previous_lineage_root: @bft.Digest("other-root"),
    }),
  )
}

///|
test "lineage transition rejects an invalid ownership edge" {
  let transition : InventoryLineageTransition = {
    asset_id: "asset-1",
    origin_receipt_digest: @bft.Digest("origin-digest"),
    from_owner: "alice",
    to_owner: "alice",
    expected_version: 0,
    previous_event: @bft.Digest("previous-event"),
    source_event: @bft.Digest("transfer-event"),
    previous_lineage_root: @bft.Digest("previous-root"),
  }
  assert_false(inventory_lineage_transition_valid(transition))
}
