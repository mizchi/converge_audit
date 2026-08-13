///|
/// Lightweight origin data used by browser and server bridges. This package is
/// deliberately independent of inventory state, authenticated maps and bench
/// support so importing its serializers cannot initialize runtime state.
pub(all) struct InventoryOrigin {
  asset_id : String
  recipient_id : String
  item_type : String
  quantity : Int
  source_event : @bft.Digest
  output_index : Int
} derive(Eq, Debug)

///|
pub(all) struct InventoryOriginVerificationPlan {
  receipt_statement : String
  receipt_digest : @bft.Digest
  lineage_statement : String
  lineage_root : @bft.Digest
} derive(Eq, Debug)

///|
fn append_field(buffer : StringBuilder, value : String) -> Unit {
  buffer.write_string(value.length().to_string())
  buffer.write_char(':')
  buffer.write_string(value)
}

///|
pub fn inventory_origin_valid(origin : InventoryOrigin) -> Bool {
  origin.asset_id != "" &&
  origin.recipient_id != "" &&
  origin.item_type != "" &&
  origin.quantity > 0 &&
  origin.source_event.0 != "" &&
  origin.output_index >= 0
}

///|
pub fn serialize_item_receipt(origin : InventoryOrigin) -> String {
  let buffer = StringBuilder::new()
  append_field(buffer, "item-receipt-v1")
  append_field(buffer, origin.asset_id)
  append_field(buffer, origin.recipient_id)
  append_field(buffer, origin.item_type)
  append_field(buffer, origin.quantity.to_string())
  append_field(buffer, origin.source_event.0)
  append_field(buffer, origin.output_index.to_string())
  buffer.to_string()
}

///|
pub fn serialize_inventory_origin_receipt(origin : InventoryOrigin) -> String {
  let buffer = StringBuilder::new()
  append_field(buffer, "inventory-origin-receipt-v1")
  append_field(buffer, serialize_item_receipt(origin))
  buffer.to_string()
}

///|
pub fn serialize_inventory_origin_lineage(
  receipt_digest : @bft.Digest,
) -> String {
  let buffer = StringBuilder::new()
  append_field(buffer, "inventory-origin-lineage-v1")
  append_field(buffer, receipt_digest.0)
  buffer.to_string()
}

///|
pub fn inventory_origin_verification_plan(
  hasher : &@bft.Hasher,
  origin : InventoryOrigin,
) -> InventoryOriginVerificationPlan {
  let receipt_statement = serialize_inventory_origin_receipt(origin)
  let receipt_digest = hasher.hash_string(receipt_statement)
  let lineage_statement = serialize_inventory_origin_lineage(receipt_digest)
  let lineage_root = hasher.hash_string(lineage_statement)
  { receipt_statement, receipt_digest, lineage_statement, lineage_root }
}
