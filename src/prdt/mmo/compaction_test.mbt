///|
fn chain(s : Setup, ticks : Int) -> GameObject raise Error {
  let auth = @prdt.ReplicatedDomain::new(s.protocol, "A")
  for tick in 0..<ticks {
    if tick % 2 == 0 {
      auth.merge(
        proposals([
          env("Y", tick, tick, Damage(source="m", target=player_a, amount=1)),
        ]),
      )
    }
    let _ = close_next(auth, s.authority)
  }
  auth
}

///|
test "compaction folds old batches into the base without changing the head or the world" {
  let s = setup()
  let auth = chain(s, 5)
  let before = auth.decision()
  let world_before = auth.domain_state()
  auth.compact(retain_ticks=2)
  let base = auth.state().base()
  assert_eq(base.next_tick, 3)
  assert_eq(auth.next_tick(), 5)
  assert_eq(auth.decision().committed_ticks(), [3, 4])
  assert_eq(auth.decision().head_decision_hash(), before.head_decision_hash())
  assert_eq(auth.domain_state(), world_before)
  assert_eq(auth.domain_state().hp(player_a), Some(7))
  // Proposals and closures below the base are forgotten.
  assert_eq(auth.state().proposals().ticks(), [4])
  assert_eq(auth.state().closures().list().map(fn(c) { c.tick }), [3, 4])
  // Compacting again with a larger window is a no-op.
  auth.compact(retain_ticks=10)
  assert_eq(auth.state().base().next_tick, 3)
}

///|
test "a compacted replica keeps finalizing and refuses late proposals for forgotten ticks" {
  let s = setup()
  let auth = chain(s, 4)
  auth.compact(retain_ticks=0)
  assert_eq(auth.state().base().next_tick, 4)
  assert_eq(auth.decision().committed_ticks(), [])
  auth.merge(proposals([env("Z", 0, 1, fireball())])) // tick 1 is gone: dropped, not retained
  assert_eq(auth.decision().of("Z:0"), @prdt.DecisionPending)
  assert_eq(auth.state().proposals().count(), 0)
  auth.merge(proposals([env("X", 0, 4, fireball())]))
  let _ = close_next(auth, s.authority)
  assert_eq(
    auth.decision().of("X:0"),
    @prdt.DecisionAccepted(
      4,
      GameEvent::SkillActivated(actor=player_a, skill="fireball", mp_cost=30),
    ),
  )
  assert_eq(auth.next_tick(), 5)
}

///|
test "snapshot round trip preserves a compacted base and refuses a tampered base" {
  let s = setup()
  let auth = chain(s, 4)
  auth.compact(retain_ticks=1)
  let restored = @prdt.ReplicatedDomain::restore(
    s.protocol,
    @json.parse(auth.snapshot().stringify()),
  )
  assert_true(s.protocol.states_equal(restored.state(), auth.state()))
  assert_eq(restored.state_hash(), auth.state_hash())
  assert_eq(restored.domain_state(), auth.domain_state())
  let tampered = auth.snapshot()
  guard tampered is Object(fields) &&
    fields.get("state").unwrap() is Object(state_fields) &&
    state_fields.get("base").unwrap() is Object(base_fields) else {
    fail("snapshot shape")
  }
  base_fields["decision_hash"] = "ffff".to_json()
  let outcome = try {
    let _ = @prdt.ReplicatedDomain::restore(s.protocol, tampered)
    None
  } catch {
    error => Some(error)
  }
  // The retained closure chains from the base hash, so recomputation diverges.
  assert_eq(
    outcome,
    Some(@prdt.SnapshotMismatch("recomputation failed: ChainMismatch")),
  )
}

///|
test "join adopts the later base and rejects a contradicting prefix" {
  let s = setup()
  let full = chain(s, 5)
  let compacted = chain(s, 5)
  compacted.compact(retain_ticks=1)
  let joined = s.protocol.join(full.state(), compacted.state())
  assert_true(s.protocol.states_equal(joined, compacted.state()))
  let joined_other_way = s.protocol.join(compacted.state(), full.state())
  assert_true(s.protocol.states_equal(joined_other_way, compacted.state()))
  assert_eq(
    s.protocol.lattice_law_violations(
      full.state(),
      compacted.state(),
      s.protocol.initial(),
    ),
    [],
  )

  // A replica whose history diverges from the base is refused.
  let other = setup(
    initial_world=World::new([(player_a, { hp: 99, max_hp: 99, mp: 1 })]),
  )
  let divergent = chain(other, 5)
  let outcome = try {
    let _ = s.protocol.join(compacted.state(), divergent.state())
    None
  } catch {
    error => Some(error)
  }
  assert_eq(outcome, Some(@prdt.PrefixConflict(3)))
}

///|
test "digest-based delta carries only what the peer is missing, and catchup transfers a base" {
  let s = setup()
  let auth = chain(s, 3)
  auth.merge(
    proposals([env("X", 0, 3, fireball()), env("X", 1, 4, fireball())]),
  )
  let peer = @prdt.ReplicatedDomain::new(s.protocol, "P")
  peer.merge(proposals([env("X", 0, 3, fireball())]))
  let digest = peer.digest()
  assert_eq(digest.base_next_tick, 0)
  assert_eq(digest.next_tick, 0)
  assert_eq(digest.known_ids, ["X:0"])
  let delta = auth.delta_since(digest)
  assert_eq(delta.proposals.map(fn(e) { e.id }), ["Y:0", "Y:2", "X:1"])
  assert_eq(delta.closures.map(fn(c) { c.tick }), [0, 1, 2])
  peer.merge(delta)
  assert_eq(peer.state_hash(), auth.state_hash())
  assert_eq(auth.delta_since(peer.digest()), @prdt.Delta::empty())

  // A peer that missed everything catches up from a compacted authority.
  auth.compact(retain_ticks=0)
  let fresh = @prdt.ReplicatedDomain::new(s.protocol, "F")
  let catchup = auth.catchup_since(fresh.digest())
  assert_eq(catchup.base.next_tick, 3)
  fresh.apply_catchup(catchup)
  assert_eq(fresh.next_tick(), 3)
  assert_eq(fresh.state_hash(), auth.state_hash())
  assert_eq(fresh.domain_state(), auth.domain_state())
  let decoded : @prdt.Catchup[World, GameCommand] = @json.from_json(
    catchup.to_json(),
  )
  assert_eq(decoded.base, catchup.base)
  assert_eq(decoded.delta, catchup.delta)
}
