///|
test "origin verification plan binds the receipt before the lineage root" {
  let hasher = @bft.FnvHasher::new()
  let origin : InventoryOrigin = {
    asset_id: "asset-1",
    recipient_id: "alice",
    item_type: "raid-token",
    quantity: 2,
    source_event: @bft.Digest("loot-event"),
    output_index: 3,
  }
  let plan = inventory_origin_verification_plan(hasher, origin)
  assert_eq(plan.receipt_digest, hasher.hash_string(plan.receipt_statement))
  assert_eq(plan.lineage_root, hasher.hash_string(plan.lineage_statement))
  assert_eq(
    plan.lineage_statement,
    serialize_inventory_origin_lineage(plan.receipt_digest),
  )
}
