///|
test "inventory record framing binds current state and origin" {
  let record : @inventory_record.InventoryRecord = {
    asset_id: "asset-雪😀",
    owner_id: "alice-猫",
    item_type: "raid-token",
    quantity: 2,
    origin_source_event: @bft.Digest("loot-event"),
    origin_output_index: 3,
    origin_receipt_digest: @bft.Digest("origin-digest"),
    version: 1,
    last_event: @bft.Digest("transfer-event"),
    lineage_root: @bft.Digest("lineage-root"),
  }
  assert_true(@inventory_record.inventory_record_valid(record))
  assert_not_eq(
    @inventory_record.serialize_inventory_record(record),
    @inventory_record.serialize_inventory_record({
      ..record,
      owner_id: "bob-犬",
    }),
  )
}
