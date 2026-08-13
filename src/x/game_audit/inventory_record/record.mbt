///|
/// Lightweight canonical inventory record shared by stateful inventory code
/// and browser/server verification bridges.
pub(all) struct InventoryRecord {
  asset_id : String
  owner_id : String
  item_type : String
  quantity : Int
  origin_source_event : @bft.Digest
  origin_output_index : Int
  origin_receipt_digest : @bft.Digest
  version : Int
  last_event : @bft.Digest
  lineage_root : @bft.Digest
} derive(Eq, Debug)

///|
fn append_field(buffer : StringBuilder, value : String) -> Unit {
  buffer.write_string(value.length().to_string())
  buffer.write_char(':')
  buffer.write_string(value)
}

///|
pub fn inventory_record_valid(record : InventoryRecord) -> Bool {
  record.asset_id != "" &&
  record.owner_id != "" &&
  record.item_type != "" &&
  record.quantity > 0 &&
  record.origin_source_event.0 != "" &&
  record.origin_output_index >= 0 &&
  record.origin_receipt_digest.0 != "" &&
  record.version >= 0 &&
  record.last_event.0 != "" &&
  record.lineage_root.0 != ""
}

///|
pub fn serialize_inventory_record(record : InventoryRecord) -> String {
  let buffer = StringBuilder::new()
  append_field(buffer, "asset-record-v2")
  append_field(buffer, record.asset_id)
  append_field(buffer, record.owner_id)
  append_field(buffer, record.item_type)
  append_field(buffer, record.quantity.to_string())
  append_field(buffer, record.origin_source_event.0)
  append_field(buffer, record.origin_output_index.to_string())
  append_field(buffer, record.origin_receipt_digest.0)
  append_field(buffer, record.version.to_string())
  append_field(buffer, record.last_event.0)
  append_field(buffer, record.lineage_root.0)
  buffer.to_string()
}
