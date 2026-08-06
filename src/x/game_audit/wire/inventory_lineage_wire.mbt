///|
const INVENTORY_LINEAGE_WIRE_VERSION : Int = 2

///|
/// Current checkpoint membership plus a bounded authenticated lineage suffix.
pub(all) struct InventoryLineageProofBundle {
  listing : InventoryListingProofBundle
  lineage : @inventory.AssetLineageSlice
} derive(Eq, Debug)

///|
pub(all) struct InventoryLineageWireLimits {
  max_bundle_bytes : Int
  max_transfers : Int
  max_owner_bindings : Int
  listing_limits : InventoryListingWireLimits
} derive(Eq, Debug)

///|
pub fn InventoryLineageWireLimits::default() -> InventoryLineageWireLimits {
  {
    max_bundle_bytes: 524288,
    max_transfers: 64,
    max_owner_bindings: 128,
    listing_limits: InventoryListingWireLimits::default(),
  }
}

///|
pub(all) enum InventoryLineageWireError {
  InventoryLineageWireInputTooLarge(Int, Int)
  InventoryLineageWireTransfersTooMany(Int, Int)
  InventoryLineageWireOwnerBindingsTooMany(Int, Int)
  InventoryLineageWireUnsupportedVersion(Int)
  InventoryLineageWireNonCanonicalEncoding
  InventoryLineageWireMalformedCbor
  InventoryLineageWireCodecRefused(OpenWorldAuditWireError)
  InventoryLineageWireListingRefused(InventoryListingWireError)
} derive(Eq, Debug)

///|
fn encode_asset_lineage_anchor(
  anchor : @inventory.AssetLineageAnchor,
) -> @cbor.CborValue {
  @cbor.CborValue::Array([
    @cbor.CborValue::Text(anchor.asset_id),
    @cbor.CborValue::Text(anchor.owner_id),
    wire_int(anchor.version),
    @cbor.CborValue::Text(anchor.last_event.0),
    @cbor.CborValue::Text(anchor.lineage_root.0),
    @cbor.CborValue::Text(anchor.origin_receipt_digest.0),
  ])
}

///|
fn decode_asset_lineage_anchor(
  value : @cbor.CborValue,
  limits : OpenWorldAuditWireLimits,
) -> @inventory.AssetLineageAnchor raise OpenWorldAuditWireError {
  let fields = decode_wire_array(value, 6)
  {
    asset_id: decode_wire_text(fields[0], limits),
    owner_id: decode_wire_text(fields[1], limits),
    version: decode_wire_int(fields[2]),
    last_event: decode_wire_digest(fields[3], limits),
    lineage_root: decode_wire_digest(fields[4], limits),
    origin_receipt_digest: decode_wire_digest(fields[5], limits),
  }
}

///|
fn encode_asset_lineage_transition(
  transition : @inventory.AssetLineageTransition,
) -> @cbor.CborValue {
  @cbor.CborValue::Array([
    @cbor.CborValue::Text(transition.asset_id),
    @cbor.CborValue::Text(transition.origin_receipt_digest.0),
    @cbor.CborValue::Text(transition.from_owner),
    @cbor.CborValue::Text(transition.to_owner),
    wire_int(transition.expected_version),
    @cbor.CborValue::Text(transition.previous_event.0),
    @cbor.CborValue::Text(transition.source_event.0),
    @cbor.CborValue::Text(transition.previous_lineage_root.0),
  ])
}

///|
fn decode_asset_lineage_transition(
  value : @cbor.CborValue,
  limits : OpenWorldAuditWireLimits,
) -> @inventory.AssetLineageTransition raise OpenWorldAuditWireError {
  let fields = decode_wire_array(value, 8)
  {
    asset_id: decode_wire_text(fields[0], limits),
    origin_receipt_digest: decode_wire_digest(fields[1], limits),
    from_owner: decode_wire_text(fields[2], limits),
    to_owner: decode_wire_text(fields[3], limits),
    expected_version: decode_wire_int(fields[4]),
    previous_event: decode_wire_digest(fields[5], limits),
    source_event: decode_wire_digest(fields[6], limits),
    previous_lineage_root: decode_wire_digest(fields[7], limits),
  }
}

///|
fn encode_asset_owner_key_binding(
  signed : @inventory.SignedAssetOwnerKeyBinding,
) -> @cbor.CborValue {
  @cbor.CborValue::Array([
    @cbor.CborValue::Array([
      @cbor.CborValue::Text(signed.binding.session_id),
      @cbor.CborValue::Text(signed.binding.owner_id),
      @cbor.CborValue::Text(signed.binding.owner_key.0),
    ]),
    @cbor.CborValue::Text(signed.digest.0),
    @cbor.CborValue::Text(signed.signature.0),
    @cbor.CborValue::Text(signed.authority_key.0),
  ])
}

///|
fn decode_asset_owner_key_binding(
  value : @cbor.CborValue,
  limits : OpenWorldAuditWireLimits,
) -> @inventory.SignedAssetOwnerKeyBinding raise OpenWorldAuditWireError {
  let fields = decode_wire_array(value, 4)
  let binding = decode_wire_array(fields[0], 3)
  {
    binding: {
      session_id: decode_wire_text(binding[0], limits),
      owner_id: decode_wire_text(binding[1], limits),
      owner_key: decode_wire_public_key(binding[2], limits),
    },
    digest: decode_wire_digest(fields[1], limits),
    signature: decode_wire_signature(fields[2], limits),
    authority_key: decode_wire_public_key(fields[3], limits),
  }
}

///|
fn encode_signed_asset_lineage_transfer(
  signed : @inventory.SignedAssetLineageTransfer,
) -> @cbor.CborValue {
  @cbor.CborValue::Array([
    @cbor.CborValue::Array([
      @cbor.CborValue::Text(signed.authorization.session_id),
      encode_asset_lineage_transition(signed.authorization.transition),
      @cbor.CborValue::Text(signed.authorization.sender_key.0),
      @cbor.CborValue::Text(signed.authorization.recipient_key.0),
    ]),
    @cbor.CborValue::Text(signed.digest.0),
    @cbor.CborValue::Text(signed.sender_signature.0),
    @cbor.CborValue::Text(signed.recipient_signature.0),
  ])
}

///|
fn decode_signed_asset_lineage_transfer(
  value : @cbor.CborValue,
  limits : OpenWorldAuditWireLimits,
) -> @inventory.SignedAssetLineageTransfer raise OpenWorldAuditWireError {
  let fields = decode_wire_array(value, 4)
  let authorization = decode_wire_array(fields[0], 4)
  {
    authorization: {
      session_id: decode_wire_text(authorization[0], limits),
      transition: decode_asset_lineage_transition(authorization[1], limits),
      sender_key: decode_wire_public_key(authorization[2], limits),
      recipient_key: decode_wire_public_key(authorization[3], limits),
    },
    digest: decode_wire_digest(fields[1], limits),
    sender_signature: decode_wire_signature(fields[2], limits),
    recipient_signature: decode_wire_signature(fields[3], limits),
  }
}

///|
fn encode_authenticated_asset_lineage_transfer(
  entry : @inventory.AuthenticatedAssetLineageTransfer,
  sender_binding_index : Int,
  recipient_binding_index : Int,
) -> @cbor.CborValue {
  @cbor.CborValue::Array([
    encode_signed_asset_lineage_transfer(entry.signed_transfer),
    wire_int(sender_binding_index),
    wire_int(recipient_binding_index),
  ])
}

///|
fn decode_authenticated_asset_lineage_transfer(
  value : @cbor.CborValue,
  limits : OpenWorldAuditWireLimits,
  bindings : Array[@inventory.SignedAssetOwnerKeyBinding],
) -> @inventory.AuthenticatedAssetLineageTransfer raise OpenWorldAuditWireError {
  let fields = decode_wire_array(value, 3)
  let sender_binding_index = decode_wire_int(fields[1])
  let recipient_binding_index = decode_wire_int(fields[2])
  if sender_binding_index < 0 ||
    sender_binding_index >= bindings.length() ||
    recipient_binding_index < 0 ||
    recipient_binding_index >= bindings.length() {
    raise WireInvalidShape
  }
  {
    signed_transfer: decode_signed_asset_lineage_transfer(fields[0], limits),
    sender_binding: bindings[sender_binding_index],
    recipient_binding: bindings[recipient_binding_index],
  }
}

///|
fn inventory_lineage_binding_index(
  bindings : Array[@inventory.SignedAssetOwnerKeyBinding],
  binding : @inventory.SignedAssetOwnerKeyBinding,
) -> Int {
  for index, candidate in bindings {
    if candidate == binding {
      return index
    }
  }
  bindings.push(binding)
  bindings.length() - 1
}

///|
pub fn encode_inventory_lineage_proof_bundle(
  bundle : InventoryLineageProofBundle,
) -> Bytes {
  let bindings : Array[@inventory.SignedAssetOwnerKeyBinding] = []
  let transfers : Array[@cbor.CborValue] = []
  for transfer in bundle.lineage.transfers {
    let sender_binding_index = inventory_lineage_binding_index(
      bindings,
      transfer.sender_binding,
    )
    let recipient_binding_index = inventory_lineage_binding_index(
      bindings,
      transfer.recipient_binding,
    )
    transfers.push(
      encode_authenticated_asset_lineage_transfer(
        transfer, sender_binding_index, recipient_binding_index,
      ),
    )
  }
  let encoded_bindings : Array[@cbor.CborValue] = []
  for binding in bindings {
    encoded_bindings.push(encode_asset_owner_key_binding(binding))
  }
  @cbor.encode(
    @cbor.CborValue::Array([
      wire_int(INVENTORY_LINEAGE_WIRE_VERSION),
      @cbor.CborValue::Bytes(
        encode_inventory_listing_proof_bundle(bundle.listing),
      ),
      encode_asset_lineage_anchor(bundle.lineage.anchor),
      @cbor.CborValue::Array([
        @cbor.CborValue::Array(encoded_bindings),
        @cbor.CborValue::Array(transfers),
      ]),
    ]),
  )
}

///|
fn decode_lineage_wire_bytes(
  value : @cbor.CborValue,
) -> Bytes raise OpenWorldAuditWireError {
  match value {
    @cbor.CborValue::Bytes(bytes) => bytes
    _ => raise WireInvalidShape
  }
}

///|
pub fn decode_inventory_lineage_proof_bundle(
  input : Bytes,
  limits~ : InventoryLineageWireLimits,
) -> Result[InventoryLineageProofBundle, InventoryLineageWireError] {
  if input.length() > limits.max_bundle_bytes {
    return Err(
      InventoryLineageWireInputTooLarge(input.length(), limits.max_bundle_bytes),
    )
  }
  preflight_cbor(input) catch {
    _ => return Err(InventoryLineageWireMalformedCbor)
  }
  let value = @cbor.decode(input) catch {
    _ => return Err(InventoryLineageWireMalformedCbor)
  }
  if @cbor.encode(value) != input {
    return Err(InventoryLineageWireNonCanonicalEncoding)
  }
  let fields = decode_wire_array(value, 4) catch {
    error => return Err(InventoryLineageWireCodecRefused(error))
  }
  let version = decode_wire_int(fields[0]) catch {
    error => return Err(InventoryLineageWireCodecRefused(error))
  }
  if version != INVENTORY_LINEAGE_WIRE_VERSION {
    return Err(InventoryLineageWireUnsupportedVersion(version))
  }
  let evidence = decode_wire_array(fields[3], 2) catch {
    error => return Err(InventoryLineageWireCodecRefused(error))
  }
  let encoded_bindings = inventory_wire_items(evidence[0]) catch {
    error => return Err(InventoryLineageWireCodecRefused(error))
  }
  if encoded_bindings.length() > limits.max_owner_bindings {
    return Err(
      InventoryLineageWireOwnerBindingsTooMany(
        encoded_bindings.length(),
        limits.max_owner_bindings,
      ),
    )
  }
  let encoded_transfers = inventory_wire_items(evidence[1]) catch {
    error => return Err(InventoryLineageWireCodecRefused(error))
  }
  if encoded_transfers.length() > limits.max_transfers {
    return Err(
      InventoryLineageWireTransfersTooMany(
        encoded_transfers.length(),
        limits.max_transfers,
      ),
    )
  }
  let listing_bytes = decode_lineage_wire_bytes(fields[1]) catch {
    error => return Err(InventoryLineageWireCodecRefused(error))
  }
  let listing = match
    decode_inventory_listing_proof_bundle(
      listing_bytes,
      limits=limits.listing_limits,
    ) {
    Ok(value) => value
    Err(reason) => return Err(InventoryLineageWireListingRefused(reason))
  }
  let codec_limits = inventory_open_world_limits(limits.listing_limits)
  let anchor = decode_asset_lineage_anchor(fields[2], codec_limits) catch {
    error => return Err(InventoryLineageWireCodecRefused(error))
  }
  let bindings : Array[@inventory.SignedAssetOwnerKeyBinding] = []
  for encoded in encoded_bindings {
    let binding = decode_asset_owner_key_binding(encoded, codec_limits) catch {
      error => return Err(InventoryLineageWireCodecRefused(error))
    }
    bindings.push(binding)
  }
  let transfers : Array[@inventory.AuthenticatedAssetLineageTransfer] = []
  for encoded in encoded_transfers {
    let transfer = decode_authenticated_asset_lineage_transfer(
      encoded, codec_limits, bindings,
    ) catch {
      error => return Err(InventoryLineageWireCodecRefused(error))
    }
    transfers.push(transfer)
  }
  Ok({ listing, lineage: { anchor, transfers } })
}
