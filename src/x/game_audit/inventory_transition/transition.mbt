///|
/// Lightweight canonical input for one parent-bound inventory transition.
/// This package deliberately excludes inventory state and authenticated maps
/// so browser and Worker bridges can share framing without global state.
pub(all) struct InventoryLineageTransition {
  asset_id : String
  origin_receipt_digest : @bft.Digest
  from_owner : String
  to_owner : String
  expected_version : Int
  previous_event : @bft.Digest
  source_event : @bft.Digest
  previous_lineage_root : @bft.Digest
} derive(Eq, Debug)

///|
fn append_field(buffer : StringBuilder, value : String) -> Unit {
  buffer.write_string(value.length().to_string())
  buffer.write_char(':')
  buffer.write_string(value)
}

///|
pub fn inventory_lineage_transition_valid(
  transition : InventoryLineageTransition,
) -> Bool {
  transition.asset_id != "" &&
  transition.origin_receipt_digest.0 != "" &&
  transition.from_owner != "" &&
  transition.to_owner != "" &&
  transition.from_owner != transition.to_owner &&
  transition.expected_version >= 0 &&
  transition.previous_event.0 != "" &&
  transition.source_event.0 != "" &&
  transition.previous_lineage_root.0 != ""
}

///|
pub fn serialize_inventory_lineage_transition(
  transition : InventoryLineageTransition,
) -> String {
  let buffer = StringBuilder::new()
  append_field(buffer, "inventory-asset-lineage-transition-v1")
  append_field(buffer, transition.asset_id)
  append_field(buffer, transition.origin_receipt_digest.0)
  append_field(buffer, transition.from_owner)
  append_field(buffer, transition.to_owner)
  append_field(buffer, transition.expected_version.to_string())
  append_field(buffer, transition.previous_event.0)
  append_field(buffer, transition.source_event.0)
  append_field(buffer, transition.previous_lineage_root.0)
  buffer.to_string()
}

///|
pub fn inventory_lineage_transition_root(
  hasher : &@bft.Hasher,
  transition : InventoryLineageTransition,
) -> @bft.Digest {
  hasher.hash_string(serialize_inventory_lineage_transition(transition))
}
