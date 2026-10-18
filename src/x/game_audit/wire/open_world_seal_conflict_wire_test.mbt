///|
fn open_world_seal_conflict_wire_bundle(
  source : @wire.OpenWorldMissingSlotEvidence,
) -> @wire.OpenWorldMissingSlotConflictBundle {
  let replay = open_world_replay_wire_bundle()
  {
    signed_audit_checkpoint: replay.signed_audit_checkpoint,
    signed_anchor_seal_checkpoint: replay.signed_anchor_seal_checkpoint,
    audit_transparency: replay.audit_transparency,
    game_manifest_digest: replay.game_manifest_digest,
    sample_numerator: replay.sample_numerator,
    sample_denominator: replay.sample_denominator,
    registered_count: replay.registered_count,
    seed: replay.seed,
    observers: replay.observers,
    max_faults: replay.max_faults,
    source,
    missing_registration: {
      key: @open_world.open_world_encounter_registration_key(0),
      entry_count: 0,
      path: [],
    },
  }
}

///|
test "compact open-world seal conflict wire round trips both evidence sources" {
  let replay = open_world_replay_wire_bundle()
  for
    source in [
      @wire.OpenWorldMissingSlotEvidence::AuthoritySignedEncounter(
        replay.encounter.signed_checkpoint,
      ),
      @wire.OpenWorldMissingSlotEvidence::ObserverQuorum(
        0,
        replay.encounter.signed_checkpoint.digest,
        replay.observations,
      ),
    ] {
    let bundle = open_world_seal_conflict_wire_bundle(source)
    let encoded = @wire.encode_open_world_missing_slot_conflict_bundle(bundle)
    let decoded = match
      @wire.decode_open_world_missing_slot_conflict_bundle(
        encoded,
        limits=@wire.OpenWorldMissingSlotConflictWireLimits::default(),
      ) {
      Ok(value) => value
      Err(_) => fail("expected compact conflict wire round trip")
    }
    assert_eq(decoded, bundle)
    assert_eq(
      @wire.encode_open_world_missing_slot_conflict_bundle(decoded),
      encoded,
    )
  }
}

///|
test "compact open-world seal conflict wire enforces the absence path budget" {
  let replay = open_world_replay_wire_bundle()
  let bundle = open_world_seal_conflict_wire_bundle(
    @wire.OpenWorldMissingSlotEvidence::AuthoritySignedEncounter(
      replay.encounter.signed_checkpoint,
    ),
  )
  let limited = @wire.OpenWorldMissingSlotConflictWireLimits::{
    ..@wire.OpenWorldMissingSlotConflictWireLimits::default(),
    max_absence_proof_steps: -1,
  }
  match
    @wire.decode_open_world_missing_slot_conflict_bundle(
      @wire.encode_open_world_missing_slot_conflict_bundle(bundle),
      limits=limited,
    ) {
    Err(
      @wire.OpenWorldMissingSlotConflictWireError::MissingSlotProofTooLong(
        0,
        -1
      )
    ) => ()
    _ => fail("expected compact absence path budget refusal")
  }
}

///|
test "compact open-world seal conflict wire rejects noncanonical and unsupported versions" {
  let replay = open_world_replay_wire_bundle()
  let encoded = @wire.encode_open_world_missing_slot_conflict_bundle(
    open_world_seal_conflict_wire_bundle(
      @wire.OpenWorldMissingSlotEvidence::AuthoritySignedEncounter(
        replay.encounter.signed_checkpoint,
      ),
    ),
  )
  match
    @wire.decode_open_world_missing_slot_conflict_bundle(
      make_noncanonical_version(encoded),
      limits=@wire.OpenWorldMissingSlotConflictWireLimits::default(),
    ) {
    Err(MissingSlotCodecRefused(WireNonCanonicalEncoding)) => ()
    _ => fail("expected noncanonical compact conflict refusal")
  }
  match
    @wire.decode_open_world_missing_slot_conflict_bundle(
      replace_canonical_version(encoded, b'\x02'),
      limits=@wire.OpenWorldMissingSlotConflictWireLimits::default(),
    ) {
    Err(MissingSlotUnsupportedVersion(2)) => ()
    _ => fail("expected unsupported compact conflict version refusal")
  }
}

///|
test "compact open-world seal conflict wire enforces its byte budget" {
  let replay = open_world_replay_wire_bundle()
  let encoded = @wire.encode_open_world_missing_slot_conflict_bundle(
    open_world_seal_conflict_wire_bundle(
      @wire.OpenWorldMissingSlotEvidence::AuthoritySignedEncounter(
        replay.encounter.signed_checkpoint,
      ),
    ),
  )
  let limited = @wire.OpenWorldMissingSlotConflictWireLimits::{
    ..@wire.OpenWorldMissingSlotConflictWireLimits::default(),
    max_bundle_bytes: encoded.length() - 1,
  }
  match
    @wire.decode_open_world_missing_slot_conflict_bundle(
      encoded,
      limits=limited,
    ) {
    Err(MissingSlotInputTooLarge(actual, maximum)) =>
      assert_eq(actual, maximum + 1)
    _ => fail("expected compact conflict byte budget refusal")
  }
}
