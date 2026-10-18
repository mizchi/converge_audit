///|
/// Reserve a positive byte and item budget alongside stored payloads and
/// outstanding reservations. `headroom_bytes` remains unavailable to payloads.
/// Counters must be read and the reservation persisted in one transaction.
/// Bounds precede each subtraction, avoiding speculative overflowing sums.
pub fn player_local_payload_reservation_allowed(
  used_bytes : Int,
  used_items : Int,
  reserved_bytes : Int,
  reserved_items : Int,
  incoming_bytes : Int,
  incoming_items : Int,
  max_bytes : Int,
  max_items : Int,
  headroom_bytes : Int,
) -> Bool where {
  proof_ensure: result => {
    player_local_payload_reservation_post(
      used_bytes, used_items, reserved_bytes, reserved_items, incoming_bytes, incoming_items,
      max_bytes, max_items, headroom_bytes, result,
    )
  },
} {
  if used_bytes < 0 ||
    used_items < 0 ||
    reserved_bytes < 0 ||
    reserved_items < 0 ||
    incoming_bytes <= 0 ||
    incoming_items <= 0 ||
    max_bytes < 0 ||
    max_items < 0 ||
    headroom_bytes < 0 ||
    headroom_bytes > max_bytes {
    false
  } else {
    let payload_capacity = max_bytes - headroom_bytes
    if used_bytes > payload_capacity || used_items > max_items {
      false
    } else {
      let available_bytes = payload_capacity - used_bytes
      let available_items = max_items - used_items
      if reserved_bytes > available_bytes || reserved_items > available_items {
        false
      } else {
        incoming_bytes <= available_bytes - reserved_bytes &&
        incoming_items <= available_items - reserved_items
      }
    }
  }
}
