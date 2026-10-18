///|
/// Admit an encounter commitment only in a fresh slot strictly before release.
/// The host supplies freshness from trusted state; this pure guard does not
/// authenticate a commitment or atomically reserve the slot.
pub fn encounter_commit_allowed(
  fresh : Bool,
  now : Int,
  release_at : Int,
) -> Bool where {
  proof_ensure: result => {
    encounter_commit_allowed_post(fresh, now, release_at, result)
  },
} {
  fresh && now >= 0 && release_at >= 0 && now < release_at
}

///|
/// A reveal needs a non-negative commitment time strictly before release and
/// may occur at release or later. Times must name the same authenticated
/// encounter; checking the opening against its commitment remains separate.
pub fn encounter_reveal_allowed(
  committed_at : Int,
  release_at : Int,
  now : Int,
) -> Bool where {
  proof_ensure: result => {
    encounter_reveal_allowed_post(committed_at, release_at, now, result)
  },
} {
  committed_at >= 0 && committed_at < release_at && release_at <= now
}

///|
/// A revealed encounter is consumable once, after replay and exact-root
/// verification. All four facts must come from trusted encounter state; a
/// transport ACK cannot supply replay verification or gameplay finality.
pub fn encounter_consume_allowed(
  revealed : Bool,
  consumed : Bool,
  replay_verified : Bool,
  root_matches : Bool,
) -> Bool where {
  proof_ensure: result => {
    encounter_consume_allowed_post(
      revealed, consumed, replay_verified, root_matches, result,
    )
  },
} {
  revealed && !consumed && replay_verified && root_matches
}

///|
/// Release retention only after settlement and the non-negative deadline,
/// with no unresolved reference. Settlement and holds are trusted game facts;
/// elapsed time alone does not authorize evidence deletion.
pub fn encounter_retention_release_allowed(
  settled : Bool,
  retention_until : Int,
  now : Int,
  unresolved : Bool,
) -> Bool where {
  proof_ensure: result => {
    encounter_retention_release_allowed_post(
      settled, retention_until, now, unresolved, result,
    )
  },
} {
  settled &&
  retention_until >= 0 &&
  now >= 0 &&
  retention_until <= now &&
  !unresolved
}
