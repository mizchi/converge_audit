///|
const OPEN_WORLD_MISSING_SLOT_CONFLICT_WIRE_VERSION : Int = 1

///|
/// The compact left-hand evidence carried by a missing-slot accusation.
pub(all) enum OpenWorldMissingSlotEvidence {
  AuthoritySignedEncounter(@checkpoint.SignedCheckpoint)
  ObserverQuorum(
    Int,
    @bft.Digest,
    Array[@open_world.SignedOpenWorldRegistrationObservation]
  )
} derive(Eq, Debug)

///|
/// Canonical evidence needed to open a missing-slot conflict. Full encounter
/// events, deterministic replay state, and item receipts are deliberately not
/// part of this wire contract.
pub(all) struct OpenWorldMissingSlotConflictBundle {
  signed_audit_checkpoint : @checkpoint.SignedCheckpoint
  signed_anchor_seal_checkpoint : @checkpoint.SignedCheckpoint
  audit_transparency : @open_world.OpenWorldAuditTransparencyEnvelope
  game_manifest_digest : @bft.Digest
  sample_numerator : Int
  sample_denominator : Int
  registered_count : Int
  seed : String
  observers : Array[@attestation.Participant]
  max_faults : Int
  source : OpenWorldMissingSlotEvidence
  missing_registration : @authmap.AuthMapAbsenceProof
} derive(Eq, Debug)

///|
pub(all) struct OpenWorldMissingSlotConflictWireLimits {
  max_bundle_bytes : Int
  max_text_bytes : Int
  max_observers : Int
  max_observations : Int
  max_absence_proof_steps : Int
  max_transparency_proof_steps : Int
} derive(Eq, Debug)

///|
pub fn OpenWorldMissingSlotConflictWireLimits::default() -> OpenWorldMissingSlotConflictWireLimits {
  {
    max_bundle_bytes: 262144,
    max_text_bytes: 4096,
    max_observers: 64,
    max_observations: 64,
    max_absence_proof_steps: 64,
    max_transparency_proof_steps: 64,
  }
}

///|
pub suberror OpenWorldMissingSlotConflictWireError {
  MissingSlotInputTooLarge(Int, Int)
  MissingSlotObserversTooMany(Int, Int)
  MissingSlotObservationsTooMany(Int, Int)
  MissingSlotProofTooLong(Int, Int)
  MissingSlotUnsupportedVersion(Int)
  MissingSlotCodecRefused(OpenWorldAuditWireError)
} derive(Eq, Debug)

///|
fn missing_slot_wire_limits(
  limits : OpenWorldMissingSlotConflictWireLimits,
) -> OpenWorldAuditWireLimits {
  {
    max_envelope_bytes: limits.max_bundle_bytes,
    max_gap_request_bytes: limits.max_bundle_bytes,
    max_gap_response_bytes: limits.max_bundle_bytes,
    max_text_bytes: limits.max_text_bytes,
    max_proof_steps: limits.max_transparency_proof_steps,
    max_gap_response_items: 0,
  }
}

///|
fn missing_slot_array(
  value : @cbor.CborValue,
  expected_length : Int,
) -> Array[@cbor.CborValue] raise OpenWorldMissingSlotConflictWireError {
  decode_wire_array(value, expected_length) catch {
    error => raise MissingSlotCodecRefused(error)
  }
}

///|
fn missing_slot_items(
  value : @cbor.CborValue,
) -> Array[@cbor.CborValue] raise OpenWorldMissingSlotConflictWireError {
  match value {
    @cbor.CborValue::Array(items) => items
    _ => raise MissingSlotCodecRefused(WireInvalidShape)
  }
}

///|
fn missing_slot_int(
  value : @cbor.CborValue,
) -> Int raise OpenWorldMissingSlotConflictWireError {
  decode_wire_int(value) catch {
    error => raise MissingSlotCodecRefused(error)
  }
}

///|
fn missing_slot_text(
  value : @cbor.CborValue,
  limits : OpenWorldAuditWireLimits,
) -> String raise OpenWorldMissingSlotConflictWireError {
  decode_wire_text(value, limits) catch {
    error => raise MissingSlotCodecRefused(error)
  }
}

///|
fn missing_slot_signed_checkpoint(
  value : @cbor.CborValue,
  limits : OpenWorldAuditWireLimits,
) -> @checkpoint.SignedCheckpoint raise OpenWorldMissingSlotConflictWireError {
  decode_signed_checkpoint(value, limits) catch {
    error => raise MissingSlotCodecRefused(error)
  }
}

///|
fn encode_missing_slot_transparency(
  envelope : @open_world.OpenWorldAuditTransparencyEnvelope,
) -> @cbor.CborValue {
  @cbor.CborValue::Array([
    encode_signed_checkpoint(envelope.signed_checkpoint),
    encode_auth_map_proof(envelope.audit_membership_proof),
    encode_auth_map_proof(envelope.seal_membership_proof),
  ])
}

///|
fn decode_missing_slot_transparency(
  value : @cbor.CborValue,
  limits : OpenWorldAuditWireLimits,
) -> @open_world.OpenWorldAuditTransparencyEnvelope raise OpenWorldMissingSlotConflictWireError {
  let fields = missing_slot_array(value, 3)
  let audit_membership_proof = decode_auth_map_proof(fields[1], limits) catch {
    error => raise MissingSlotCodecRefused(error)
  }
  let seal_membership_proof = decode_auth_map_proof(fields[2], limits) catch {
    error => raise MissingSlotCodecRefused(error)
  }
  {
    signed_checkpoint: missing_slot_signed_checkpoint(fields[0], limits),
    audit_membership_proof,
    seal_membership_proof,
  }
}

///|
fn encode_missing_slot_observer(
  observer : @attestation.Participant,
) -> @cbor.CborValue {
  @cbor.CborValue::Array([
    @cbor.CborValue::Text(observer.id),
    @cbor.CborValue::Text(observer.key.0),
  ])
}

///|
fn decode_missing_slot_observer(
  value : @cbor.CborValue,
  limits : OpenWorldAuditWireLimits,
) -> @attestation.Participant raise OpenWorldMissingSlotConflictWireError {
  let fields = missing_slot_array(value, 2)
  {
    id: missing_slot_text(fields[0], limits),
    key: @bft.PublicKey(missing_slot_text(fields[1], limits)),
  }
}

///|
fn encode_missing_slot_observation(
  signed : @open_world.SignedOpenWorldRegistrationObservation,
) -> @cbor.CborValue {
  let observation = signed.observation
  @cbor.CborValue::Array([
    @cbor.CborValue::Array([
      @cbor.CborValue::Text(observation.audit_checkpoint_digest.0),
      @cbor.CborValue::Text(observation.observer_id),
      wire_int(observation.registration_index),
      @cbor.CborValue::Text(observation.encounter_digest.0),
    ]),
    @cbor.CborValue::Text(signed.digest.0),
    @cbor.CborValue::Text(signed.signature.0),
    @cbor.CborValue::Text(signed.signer_key.0),
  ])
}

///|
fn decode_missing_slot_observation(
  value : @cbor.CborValue,
  limits : OpenWorldAuditWireLimits,
) -> @open_world.SignedOpenWorldRegistrationObservation raise OpenWorldMissingSlotConflictWireError {
  let fields = missing_slot_array(value, 4)
  let observation = missing_slot_array(fields[0], 4)
  {
    observation: {
      audit_checkpoint_digest: @bft.Digest(
        missing_slot_text(observation[0], limits),
      ),
      observer_id: missing_slot_text(observation[1], limits),
      registration_index: missing_slot_int(observation[2]),
      encounter_digest: @bft.Digest(missing_slot_text(observation[3], limits)),
    },
    digest: @bft.Digest(missing_slot_text(fields[1], limits)),
    signature: @bft.Signature(missing_slot_text(fields[2], limits)),
    signer_key: @bft.PublicKey(missing_slot_text(fields[3], limits)),
  }
}

///|
fn encode_missing_slot_absence(
  proof : @authmap.AuthMapAbsenceProof,
) -> @cbor.CborValue {
  let path : Array[@cbor.CborValue] = []
  for step in proof.path {
    path.push(encode_auth_map_step(step))
  }
  @cbor.CborValue::Array([
    @cbor.CborValue::Text(proof.key),
    wire_int(proof.entry_count),
    @cbor.CborValue::Array(path),
  ])
}

///|
fn decode_missing_slot_absence(
  value : @cbor.CborValue,
  limits : OpenWorldMissingSlotConflictWireLimits,
  wire_limits : OpenWorldAuditWireLimits,
) -> @authmap.AuthMapAbsenceProof raise OpenWorldMissingSlotConflictWireError {
  let fields = missing_slot_array(value, 3)
  let encoded_path = missing_slot_items(fields[2])
  if encoded_path.length() > limits.max_absence_proof_steps {
    raise MissingSlotProofTooLong(
      encoded_path.length(),
      limits.max_absence_proof_steps,
    )
  }
  let path : Array[@authmap.AuthMapStep] = []
  for encoded in encoded_path {
    let step = decode_auth_map_step(encoded, wire_limits) catch {
      error => raise MissingSlotCodecRefused(error)
    }
    path.push(step)
  }
  {
    key: missing_slot_text(fields[0], wire_limits),
    entry_count: missing_slot_int(fields[1]),
    path,
  }
}

///|
fn encode_missing_slot_evidence(
  source : OpenWorldMissingSlotEvidence,
) -> @cbor.CborValue {
  match source {
    AuthoritySignedEncounter(encounter) =>
      @cbor.CborValue::Array([wire_int(0), encode_signed_checkpoint(encounter)])
    ObserverQuorum(registration_index, encounter_digest, observations) => {
      let encoded : Array[@cbor.CborValue] = []
      for observation in observations {
        encoded.push(encode_missing_slot_observation(observation))
      }
      @cbor.CborValue::Array([
        wire_int(1),
        wire_int(registration_index),
        @cbor.CborValue::Text(encounter_digest.0),
        @cbor.CborValue::Array(encoded),
      ])
    }
  }
}

///|
fn decode_missing_slot_evidence(
  value : @cbor.CborValue,
  limits : OpenWorldMissingSlotConflictWireLimits,
  wire_limits : OpenWorldAuditWireLimits,
) -> OpenWorldMissingSlotEvidence raise OpenWorldMissingSlotConflictWireError {
  let fields = missing_slot_items(value)
  if fields.length() == 0 {
    raise MissingSlotCodecRefused(WireInvalidShape)
  }
  match missing_slot_int(fields[0]) {
    0 => {
      if fields.length() != 2 {
        raise MissingSlotCodecRefused(WireInvalidShape)
      }
      AuthoritySignedEncounter(
        missing_slot_signed_checkpoint(fields[1], wire_limits),
      )
    }
    1 => {
      if fields.length() != 4 {
        raise MissingSlotCodecRefused(WireInvalidShape)
      }
      let encoded_observations = missing_slot_items(fields[3])
      if encoded_observations.length() > limits.max_observations {
        raise MissingSlotObservationsTooMany(
          encoded_observations.length(),
          limits.max_observations,
        )
      }
      let observations : Array[
        @open_world.SignedOpenWorldRegistrationObservation,
      ] = []
      for encoded in encoded_observations {
        observations.push(decode_missing_slot_observation(encoded, wire_limits))
      }
      ObserverQuorum(
        missing_slot_int(fields[1]),
        @bft.Digest(missing_slot_text(fields[2], wire_limits)),
        observations,
      )
    }
    _ => raise MissingSlotCodecRefused(WireInvalidShape)
  }
}

///|
fn encode_open_world_missing_slot_conflict_value(
  bundle : OpenWorldMissingSlotConflictBundle,
) -> @cbor.CborValue {
  let observers : Array[@cbor.CborValue] = []
  for observer in bundle.observers {
    observers.push(encode_missing_slot_observer(observer))
  }
  @cbor.CborValue::Array([
    wire_int(OPEN_WORLD_MISSING_SLOT_CONFLICT_WIRE_VERSION),
    encode_signed_checkpoint(bundle.signed_audit_checkpoint),
    encode_signed_checkpoint(bundle.signed_anchor_seal_checkpoint),
    encode_missing_slot_transparency(bundle.audit_transparency),
    @cbor.CborValue::Text(bundle.game_manifest_digest.0),
    wire_int(bundle.sample_numerator),
    wire_int(bundle.sample_denominator),
    wire_int(bundle.registered_count),
    @cbor.CborValue::Text(bundle.seed),
    @cbor.CborValue::Array(observers),
    wire_int(bundle.max_faults),
    encode_missing_slot_evidence(bundle.source),
    encode_missing_slot_absence(bundle.missing_registration),
  ])
}

///|
pub fn encode_open_world_missing_slot_conflict_bundle(
  bundle : OpenWorldMissingSlotConflictBundle,
) -> Bytes {
  @cbor.encode(encode_open_world_missing_slot_conflict_value(bundle))
}

///|
fn decode_open_world_missing_slot_conflict_value(
  value : @cbor.CborValue,
  limits : OpenWorldMissingSlotConflictWireLimits,
) -> OpenWorldMissingSlotConflictBundle raise OpenWorldMissingSlotConflictWireError {
  let fields = missing_slot_array(value, 13)
  let version = missing_slot_int(fields[0])
  if version != OPEN_WORLD_MISSING_SLOT_CONFLICT_WIRE_VERSION {
    raise MissingSlotUnsupportedVersion(version)
  }
  let wire_limits = missing_slot_wire_limits(limits)
  let encoded_observers = missing_slot_items(fields[9])
  if encoded_observers.length() > limits.max_observers {
    raise MissingSlotObserversTooMany(
      encoded_observers.length(),
      limits.max_observers,
    )
  }
  let observers : Array[@attestation.Participant] = []
  for encoded in encoded_observers {
    observers.push(decode_missing_slot_observer(encoded, wire_limits))
  }
  {
    signed_audit_checkpoint: missing_slot_signed_checkpoint(
      fields[1],
      wire_limits,
    ),
    signed_anchor_seal_checkpoint: missing_slot_signed_checkpoint(
      fields[2],
      wire_limits,
    ),
    audit_transparency: decode_missing_slot_transparency(fields[3], wire_limits),
    game_manifest_digest: @bft.Digest(missing_slot_text(fields[4], wire_limits)),
    sample_numerator: missing_slot_int(fields[5]),
    sample_denominator: missing_slot_int(fields[6]),
    registered_count: missing_slot_int(fields[7]),
    seed: missing_slot_text(fields[8], wire_limits),
    observers,
    max_faults: missing_slot_int(fields[10]),
    source: decode_missing_slot_evidence(fields[11], limits, wire_limits),
    missing_registration: decode_missing_slot_absence(
      fields[12],
      limits,
      wire_limits,
    ),
  }
}

///|
pub fn decode_open_world_missing_slot_conflict_bundle(
  input : Bytes,
  limits~ : OpenWorldMissingSlotConflictWireLimits,
) -> Result[
  OpenWorldMissingSlotConflictBundle,
  OpenWorldMissingSlotConflictWireError,
] {
  if input.length() > limits.max_bundle_bytes {
    return Err(
      MissingSlotInputTooLarge(input.length(), limits.max_bundle_bytes),
    )
  }
  let value = decode_canonical_cbor(input) catch {
    error => return Err(MissingSlotCodecRefused(error))
  }
  try decode_open_world_missing_slot_conflict_value(value, limits) |> Ok catch {
    error => Err(error)
  }
}
