///|
/// An unsettled encounter may be aborted, or freshly expired only after its
/// commitment deadline without a commitment. Trusted terminal state permits
/// reading the stored result again; the host must preserve that result rather
/// than replacing its cause or timestamps. Invalid clocks always fail closed.
pub fn encounter_termination_allowed(
  settled : Bool,
  already_terminated : Bool,
  expire_requested : Bool,
  has_commitment : Bool,
  now : Int,
  commit_deadline : Int,
) -> Bool where {
  proof_ensure: result => {
    encounter_termination_allowed_post(
      settled, already_terminated, expire_requested, has_commitment, now, commit_deadline,
      result,
    )
  },
} {
  now >= 0 &&
  commit_deadline >= 0 &&
  !settled &&
  (
    already_terminated ||
    !expire_requested ||
    (!has_commitment && commit_deadline <= now)
  )
}

///|
/// Terminal cleanup needs trusted termination, elapsed retention, and no
/// unresolved evidence reference. Clock comparison alone cannot release a
/// live encounter or bypass an evidence hold.
pub fn encounter_terminal_cleanup_allowed(
  terminated : Bool,
  now : Int,
  retention_until : Int,
  unresolved_reference : Bool,
) -> Bool where {
  proof_ensure: result => {
    encounter_terminal_cleanup_allowed_post(
      terminated, now, retention_until, unresolved_reference, result,
    )
  },
} {
  now >= 0 &&
  retention_until >= 0 &&
  terminated &&
  retention_until <= now &&
  !unresolved_reference
}
