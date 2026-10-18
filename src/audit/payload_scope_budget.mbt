///|
/// Admit one new payload scope, including metadata for an empty queue, only
/// while the shared pool has a free scope slot. The host supplies the number
/// of registered scopes and registers the new scope in the same transaction.
/// Comparing counts directly avoids an overflowing speculative increment.
pub fn player_local_payload_scope_registration_allowed(
  current_scopes : Int,
  max_scopes : Int,
) -> Bool where {
  proof_ensure: result => {
    player_local_payload_scope_registration_post(
      current_scopes, max_scopes, result,
    )
  },
} {
  current_scopes >= 0 && max_scopes > 0 && current_scopes < max_scopes
}
