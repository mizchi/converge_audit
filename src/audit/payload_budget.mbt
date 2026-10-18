///|
/// Admit one non-empty payload while preserving item, byte, and control-reserve
/// limits. The caller supplies authoritative counters from one storage
/// transaction; this pure guard does not make concurrent writes atomic.
/// Subtractions follow non-negative bounds so no capacity addition can overflow.
pub fn player_local_payload_admission_allowed(
  current_bytes : Int,
  current_items : Int,
  incoming_bytes : Int,
  max_bytes : Int,
  max_items : Int,
  max_item_bytes : Int,
  reserved_bytes : Int,
) -> Bool where {
  proof_ensure: result => {
    player_local_payload_admission_post(
      current_bytes, current_items, incoming_bytes, max_bytes, max_items, max_item_bytes,
      reserved_bytes, result,
    )
  },
} {
  if current_bytes < 0 ||
    current_items < 0 ||
    incoming_bytes <= 0 ||
    max_bytes < 0 ||
    max_items < 0 ||
    max_item_bytes < 0 ||
    reserved_bytes < 0 ||
    incoming_bytes > max_item_bytes ||
    current_items >= max_items ||
    reserved_bytes > max_bytes {
    false
  } else {
    let payload_capacity = max_bytes - reserved_bytes
    if current_bytes > payload_capacity {
      false
    } else {
      incoming_bytes <= payload_capacity - current_bytes
    }
  }
}

///|
/// Gate payload deletion on trusted delivery, gameplay-finality, and retention
/// facts. A transport ACK alone establishes neither gameplay finality nor
/// permission to delete. Unresolved evidence references always retain payloads.
pub fn player_local_payload_prunable(
  delivery_acknowledged : Bool,
  gameplay_finalized : Bool,
  retention_closed : Bool,
  unresolved_reference : Bool,
) -> Bool where {
  proof_ensure: result => {
    player_local_payload_prunable_post(
      delivery_acknowledged, gameplay_finalized, retention_closed, unresolved_reference,
      result,
    )
  },
} {
  delivery_acknowledged &&
  gameplay_finalized &&
  retention_closed &&
  !unresolved_reference
}
