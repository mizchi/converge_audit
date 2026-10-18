///|
fn wire_anchor_envelope_for_test(
  hasher : &@bft.Hasher,
  authority : &@bft.Signer,
  session : String,
  epoch : Int,
  previous : @bft.Digest,
) -> @open_world.OpenWorldObserverSigningAnchorEnvelope raise Error {
  let anchor = @open_world.OpenWorldObserverSigningAnchor::{
    observer_id: "wire-observer",
    signer_key: @bft.PublicKey("wire-observer-key"),
    root: @bft.Digest("wire-observer-root-" + epoch.to_string()),
    size: epoch + 1,
  }
  let anchor_map = @authmap.AuthenticatedMap::new(hasher)
  let key = @open_world.open_world_observer_signing_anchor_key(anchor)
  ignore(
    anchor_map.put(
      key,
      @open_world.open_world_observer_signing_anchor_value(anchor),
    ),
  )
  let signed_checkpoint = @checkpoint.sign_checkpoint(hasher, authority, {
    session_id: session,
    epoch,
    previous_checkpoint: previous,
    manifest_digest: @open_world.open_world_observer_signing_anchor_log_manifest(
      hasher,
      log_session_id=session,
    ),
    event_root: @bft.Digest("wire-events"),
    public_state_root: anchor_map.root(),
    asset_delta_root: @bft.Digest("wire-no-assets"),
    hidden_state_commitment: Some(@bft.Digest("wire-hidden")),
  })
  let membership_proof = match anchor_map.proof(key) {
    Some(proof) => proof
    None => fail("expected wire anchor membership proof")
  }
  { signed_checkpoint, anchor, membership_proof, }
}

///|
fn replace_canonical_version(encoded : Bytes, version_byte : Byte) -> Bytes {
  Bytes::makei(encoded.length(), fn(index) {
    if index == 1 {
      version_byte
    } else {
      encoded[index]
    }
  })
}

///|
fn make_noncanonical_version(encoded : Bytes) -> Bytes {
  let output = Buffer()
  output.write_byte(encoded[0])
  output.write_byte(b'\x18')
  output.write_byte(b'\x01')
  for index in 2..<encoded.length() {
    output.write_byte(encoded[index])
  }
  output.to_bytes()
}

///|
test "observer anchor envelope has a canonical versioned wire round trip" {
  let hasher = @bft.FnvHasher::new()
  let authority = @bft.MockSigner::new("wire-authority")
  let envelope = wire_anchor_envelope_for_test(
    hasher,
    authority,
    "world-1:wire",
    7,
    @bft.Digest("wire-checkpoint-6"),
  )
  let encoded = @wire.encode_open_world_observer_signing_anchor_envelope(
    envelope,
  )
  let decoded = match
    @wire.decode_open_world_observer_signing_anchor_envelope(
      encoded,
      limits=@wire.OpenWorldAuditWireLimits::default(),
    ) {
    Ok(decoded) => decoded
    Err(_) => fail("expected canonical envelope decode")
  }
  assert_eq(decoded, envelope)
  assert_eq(
    @wire.encode_open_world_observer_signing_anchor_envelope(decoded),
    encoded,
  )
}

///|
test "wire decoder rejects noncanonical and unsupported versions" {
  let hasher = @bft.FnvHasher::new()
  let authority = @bft.MockSigner::new("wire-version-authority")
  let envelope = wire_anchor_envelope_for_test(
    hasher,
    authority,
    "world-1:wire-version",
    3,
    @bft.Digest("wire-version-2"),
  )
  let encoded = @wire.encode_open_world_observer_signing_anchor_envelope(
    envelope,
  )
  match
    @wire.decode_open_world_observer_signing_anchor_envelope(
      make_noncanonical_version(encoded),
      limits=@wire.OpenWorldAuditWireLimits::default(),
    ) {
    Err(@wire.OpenWorldAuditWireError::WireNonCanonicalEncoding) => ()
    _ => fail("expected noncanonical envelope refusal")
  }
  match
    @wire.decode_open_world_observer_signing_anchor_envelope(
      replace_canonical_version(encoded, b'\x02'),
      limits=@wire.OpenWorldAuditWireLimits::default(),
    ) {
    Err(@wire.OpenWorldAuditWireError::WireUnsupportedVersion(version)) =>
      assert_eq(version, 2)
    _ => fail("expected unsupported wire version refusal")
  }
}

///|
test "wire decoder enforces byte text and proof budgets before capability use" {
  let hasher = @bft.FnvHasher::new()
  let authority = @bft.MockSigner::new("wire-budget-authority")
  let envelope = wire_anchor_envelope_for_test(
    hasher,
    authority,
    "world-1:wire-budget",
    9,
    @bft.Digest("wire-budget-8"),
  )
  let encoded = @wire.encode_open_world_observer_signing_anchor_envelope(
    envelope,
  )
  let default_limits = @wire.OpenWorldAuditWireLimits::default()
  match
    @wire.decode_open_world_observer_signing_anchor_envelope(encoded, limits={
      ..default_limits,
      max_envelope_bytes: encoded.length() - 1,
    }) {
    Err(@wire.OpenWorldAuditWireError::WireInputTooLarge(actual, maximum)) => {
      assert_eq(actual, encoded.length())
      assert_eq(maximum, encoded.length() - 1)
    }
    _ => fail("expected envelope byte-budget refusal")
  }
  match
    @wire.decode_open_world_observer_signing_anchor_envelope(encoded, limits={
      ..default_limits,
      max_text_bytes: 3,
    }) {
    Err(@wire.OpenWorldAuditWireError::WireTextTooLarge(_, 3)) => ()
    _ => fail("expected text-budget refusal")
  }
  match
    @wire.decode_open_world_observer_signing_anchor_envelope(encoded, limits={
      ..default_limits,
      max_proof_steps: -1,
    }) {
    Err(@wire.OpenWorldAuditWireError::WireProofTooLong(_, -1)) => ()
    _ => fail("expected proof-budget refusal")
  }
}

///|
test "gap request and response round trip under independent budgets" {
  let hasher = @bft.FnvHasher::new()
  let authority = @bft.MockSigner::new("wire-gap-authority")
  let request = @open_world.OpenWorldObserverSigningAnchorGapRequest::{
    log_session_id: "world-1:wire-gap",
    publisher_key: authority.public_key(),
    after_epoch: 10,
    after_checkpoint_digest: @bft.Digest("wire-gap-10"),
    target_epoch: 12,
    max_items: 2,
  }
  let request_bytes = @wire.encode_open_world_observer_signing_anchor_gap_request(
    request,
  )
  assert_eq(
    @wire.decode_open_world_observer_signing_anchor_gap_request(
      request_bytes,
      limits=@wire.OpenWorldAuditWireLimits::default(),
    ),
    Ok(request),
  )
  let oversized_request = {
    ..request,
    max_items: @wire.OpenWorldAuditWireLimits::default().max_gap_response_items +
    1,
  }
  match
    @wire.decode_open_world_observer_signing_anchor_gap_request(
      @wire.encode_open_world_observer_signing_anchor_gap_request(
        oversized_request,
      ),
      limits=@wire.OpenWorldAuditWireLimits::default(),
    ) {
    Err(@wire.OpenWorldAuditWireError::WireGapItemsTooMany(257, 256)) => ()
    _ => fail("expected request-item-budget refusal")
  }
  let envelope = wire_anchor_envelope_for_test(
    hasher,
    authority,
    request.log_session_id,
    11,
    request.after_checkpoint_digest,
  )
  let response = @open_world.OpenWorldObserverSigningAnchorGapResponse::{
    envelopes: [envelope, envelope],
  }
  let response_bytes = @wire.encode_open_world_observer_signing_anchor_gap_response(
    response,
  )
  assert_eq(
    @wire.decode_open_world_observer_signing_anchor_gap_response(
      response_bytes,
      limits=@wire.OpenWorldAuditWireLimits::default(),
    ),
    Ok(response),
  )
  match
    @wire.decode_open_world_observer_signing_anchor_gap_response(
      response_bytes,
      limits={
        ..@wire.OpenWorldAuditWireLimits::default(),
        max_gap_response_items: 1,
      },
    ) {
    Err(@wire.OpenWorldAuditWireError::WireGapItemsTooMany(2, 1)) => ()
    _ => fail("expected response-item-budget refusal")
  }
}

///|
test "wire decoder rejects malformed and truncated CBOR" {
  match
    @wire.decode_open_world_observer_signing_anchor_envelope(
      b"\x84\x01",
      limits=@wire.OpenWorldAuditWireLimits::default(),
    ) {
    Err(@wire.OpenWorldAuditWireError::WireMalformedCbor) => ()
    _ => fail("expected malformed CBOR refusal")
  }
  match
    @wire.decode_open_world_observer_signing_anchor_envelope(
      b"\x7a\x7f\xff\xff\xff",
      limits=@wire.OpenWorldAuditWireLimits::default(),
    ) {
    Err(@wire.OpenWorldAuditWireError::WireMalformedCbor) => ()
    _ => fail("expected impossible declared CBOR length refusal")
  }
}

///|
test "wire anchor envelope encoded-size baseline" {
  let hasher = @bft.FnvHasher::new()
  let authority = @bft.MockSigner::new("wire-size-authority")
  let envelope = wire_anchor_envelope_for_test(
    hasher,
    authority,
    "world-1:wire-size",
    15,
    @bft.Digest("wire-size-14"),
  )
  inspect(
    @wire.encode_open_world_observer_signing_anchor_envelope(envelope).length(),
    content=(
      #|400
    ),
  )
}
