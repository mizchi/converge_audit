///|
/// A server-trusted retention boundary. It can be the origin state or the final
/// state of a previously verified bounded slice.
pub(all) struct AssetLineageAnchor {
  asset_id : String
  owner_id : String
  version : Int
  last_event : @bft.Digest
  lineage_root : @bft.Digest
  origin_receipt_digest : @bft.Digest
} derive(Eq, Debug)

///|
/// Authority-certified mapping from a game owner identifier to a signing key.
pub(all) struct AssetOwnerKeyBinding {
  session_id : String
  owner_id : String
  owner_key : @bft.PublicKey
} derive(Eq, Debug)

///|
pub(all) struct SignedAssetOwnerKeyBinding {
  binding : AssetOwnerKeyBinding
  digest : @bft.Digest
  signature : @bft.Signature
  authority_key : @bft.PublicKey
} derive(Eq, Debug)

///|
/// Both participants sign the same parent-bound transition statement.
pub(all) struct AssetLineageTransferAuthorization {
  session_id : String
  transition : AssetLineageTransition
  sender_key : @bft.PublicKey
  recipient_key : @bft.PublicKey
} derive(Eq, Debug)

///|
pub(all) struct SignedAssetLineageTransfer {
  authorization : AssetLineageTransferAuthorization
  digest : @bft.Digest
  sender_signature : @bft.Signature
  recipient_signature : @bft.Signature
} derive(Eq, Debug)

///|
pub(all) struct AuthenticatedAssetLineageTransfer {
  signed_transfer : SignedAssetLineageTransfer
  sender_binding : SignedAssetOwnerKeyBinding
  recipient_binding : SignedAssetOwnerKeyBinding
} derive(Eq, Debug)

///|
pub(all) struct AssetLineageSlice {
  anchor : AssetLineageAnchor
  transfers : Array[AuthenticatedAssetLineageTransfer]
} derive(Eq, Debug)

///|
pub(all) enum AssetLineageRefusal {
  InvalidAssetLineageLimit
  MissingAssetLineageTransfers
  AssetLineageTransfersTooMany(Int, Int)
  AssetLineageOriginMismatch
  AssetLineageAnchorMismatch
  AssetLineageAssetMismatch(Int)
  AssetLineageParentMismatch(Int)
  AssetLineageOwnerMismatch(Int)
  AssetLineageVersionMismatch(Int)
  AssetLineageInvalidRecipient(Int)
  AssetLineageAuthenticationRefused(Int)
  AssetLineageCurrentRecordMismatch
} derive(Eq, Debug)

///|
pub struct VerifiedAssetLineageSlice {
  initial_anchor : AssetLineageAnchor
  final_anchor : AssetLineageAnchor
  transitions : Array[AssetLineageTransition]
} derive(Eq, Debug)

///|
pub(all) enum AssetLineageVerificationResult {
  AssetLineageVerified(VerifiedAssetLineageSlice)
  AssetLineageRefused(AssetLineageRefusal)
} derive(Eq, Debug)

///|
pub fn origin_asset_lineage_anchor(
  hasher : &@bft.Hasher,
  origin : @market.ItemReceipt,
) -> AssetLineageAnchor {
  {
    asset_id: origin.asset_id,
    owner_id: origin.recipient_id,
    version: 0,
    last_event: origin.source_event,
    lineage_root: inventory_origin_lineage_root(hasher, origin),
    origin_receipt_digest: inventory_origin_receipt_digest(hasher, origin),
  }
}

///|
pub fn asset_record_lineage_anchor(record : AssetRecord) -> AssetLineageAnchor {
  {
    asset_id: record.asset_id,
    owner_id: record.owner_id,
    version: record.version,
    last_event: record.last_event,
    lineage_root: record.lineage_root,
    origin_receipt_digest: record.origin_receipt_digest,
  }
}

///|
pub fn serialize_asset_owner_key_binding(
  binding : AssetOwnerKeyBinding,
) -> String {
  let buffer = StringBuilder::new()
  append_field(buffer, "inventory-owner-key-binding-v1")
  append_field(buffer, binding.session_id)
  append_field(buffer, binding.owner_id)
  append_field(buffer, binding.owner_key.0)
  buffer.to_string()
}

///|
pub fn asset_owner_key_binding_digest(
  hasher : &@bft.Hasher,
  binding : AssetOwnerKeyBinding,
) -> @bft.Digest {
  hasher.hash_string(serialize_asset_owner_key_binding(binding))
}

///|
pub fn sign_asset_owner_key_binding(
  hasher : &@bft.Hasher,
  authority : &@bft.Signer,
  binding : AssetOwnerKeyBinding,
) -> SignedAssetOwnerKeyBinding {
  let digest = asset_owner_key_binding_digest(hasher, binding)
  {
    binding,
    digest,
    signature: authority.sign(digest),
    authority_key: authority.public_key(),
  }
}

///|
pub fn serialize_asset_lineage_transfer_authorization(
  authorization : AssetLineageTransferAuthorization,
) -> String {
  let buffer = StringBuilder::new()
  append_field(buffer, "inventory-lineage-transfer-authorization-v1")
  append_field(buffer, authorization.session_id)
  append_field(
    buffer,
    serialize_asset_lineage_transition(authorization.transition),
  )
  append_field(buffer, authorization.sender_key.0)
  append_field(buffer, authorization.recipient_key.0)
  buffer.to_string()
}

///|
pub fn asset_lineage_transfer_authorization_digest(
  hasher : &@bft.Hasher,
  authorization : AssetLineageTransferAuthorization,
) -> @bft.Digest {
  hasher.hash_string(
    serialize_asset_lineage_transfer_authorization(authorization),
  )
}

///|
pub fn sign_asset_lineage_transfer(
  hasher : &@bft.Hasher,
  sender : &@bft.Signer,
  recipient : &@bft.Signer,
  session_id~ : String,
  transition~ : AssetLineageTransition,
) -> SignedAssetLineageTransfer {
  let authorization : AssetLineageTransferAuthorization = {
    session_id,
    transition,
    sender_key: sender.public_key(),
    recipient_key: recipient.public_key(),
  }
  let digest = asset_lineage_transfer_authorization_digest(
    hasher, authorization,
  )
  {
    authorization,
    digest,
    sender_signature: sender.sign(digest),
    recipient_signature: recipient.sign(digest),
  }
}

///|
fn asset_owner_key_binding_valid(
  hasher : &@bft.Hasher,
  verifier : &@bft.Verifier,
  signed : SignedAssetOwnerKeyBinding,
  expected_session_id : String,
  expected_owner_id : String,
  expected_owner_key : @bft.PublicKey,
  expected_authority_key : @bft.PublicKey,
) -> Bool {
  let binding = signed.binding
  let expected_digest = asset_owner_key_binding_digest(hasher, binding)
  binding.session_id == expected_session_id &&
  binding.owner_id == expected_owner_id &&
  binding.owner_key == expected_owner_key &&
  signed.authority_key == expected_authority_key &&
  signed.digest == expected_digest &&
  verifier.verify(expected_authority_key, expected_digest, signed.signature)
}

///|
fn asset_owner_key_binding_cache_key(
  signed : SignedAssetOwnerKeyBinding,
  expected_session_id : String,
  expected_owner_id : String,
  expected_owner_key : @bft.PublicKey,
  expected_authority_key : @bft.PublicKey,
) -> String {
  let buffer = StringBuilder::new()
  append_field(buffer, serialize_asset_owner_key_binding(signed.binding))
  append_field(buffer, signed.digest.0)
  append_field(buffer, signed.signature.0)
  append_field(buffer, signed.authority_key.0)
  append_field(buffer, expected_session_id)
  append_field(buffer, expected_owner_id)
  append_field(buffer, expected_owner_key.0)
  append_field(buffer, expected_authority_key.0)
  buffer.to_string()
}

///|
fn cached_asset_owner_key_binding_valid(
  hasher : &@bft.Hasher,
  verifier : &@bft.Verifier,
  signed : SignedAssetOwnerKeyBinding,
  expected_session_id : String,
  expected_owner_id : String,
  expected_owner_key : @bft.PublicKey,
  expected_authority_key : @bft.PublicKey,
  cache : Map[String, Bool],
) -> Bool {
  let key = asset_owner_key_binding_cache_key(
    signed, expected_session_id, expected_owner_id, expected_owner_key, expected_authority_key,
  )
  match cache.get(key) {
    Some(valid) => valid
    None => {
      let valid = asset_owner_key_binding_valid(
        hasher, verifier, signed, expected_session_id, expected_owner_id, expected_owner_key,
        expected_authority_key,
      )
      cache[key] = valid
      valid
    }
  }
}

///|
fn asset_lineage_transfer_authentication_valid(
  hasher : &@bft.Hasher,
  verifier : &@bft.Verifier,
  entry : AuthenticatedAssetLineageTransfer,
  expected_session_id : String,
  expected_authority_key : @bft.PublicKey,
  binding_cache : Map[String, Bool],
) -> Bool {
  let signed = entry.signed_transfer
  let authorization = signed.authorization
  let transition = authorization.transition
  let digest = asset_lineage_transfer_authorization_digest(
    hasher, authorization,
  )
  authorization.session_id == expected_session_id &&
  cached_asset_owner_key_binding_valid(
    hasher,
    verifier,
    entry.sender_binding,
    expected_session_id,
    transition.from_owner,
    authorization.sender_key,
    expected_authority_key,
    binding_cache,
  ) &&
  cached_asset_owner_key_binding_valid(
    hasher,
    verifier,
    entry.recipient_binding,
    expected_session_id,
    transition.to_owner,
    authorization.recipient_key,
    expected_authority_key,
    binding_cache,
  ) &&
  signed.digest == digest &&
  verifier.verify(authorization.sender_key, digest, signed.sender_signature) &&
  verifier.verify(
    authorization.recipient_key,
    digest,
    signed.recipient_signature,
  )
}

///|
/// Verify only a bounded suffix from a caller-trusted anchor. Full frame logs
/// are not required: each transition is parent-bound, dual-signed and the final
/// cumulative root must equal the current checkpoint-authenticated record.
pub fn verify_asset_lineage_slice(
  hasher : &@bft.Hasher,
  verifier : &@bft.Verifier,
  slice : AssetLineageSlice,
  expected_session_id~ : String,
  expected_authority_key~ : @bft.PublicKey,
  expected_origin_receipt_digest~ : @bft.Digest,
  expected_anchor~ : AssetLineageAnchor,
  expected_current~ : AssetRecord,
  max_transfers~ : Int,
) -> AssetLineageVerificationResult {
  if max_transfers < 0 {
    return AssetLineageRefused(InvalidAssetLineageLimit)
  }
  if slice.transfers.length() == 0 {
    return AssetLineageRefused(MissingAssetLineageTransfers)
  }
  if slice.transfers.length() > max_transfers {
    return AssetLineageRefused(
      AssetLineageTransfersTooMany(slice.transfers.length(), max_transfers),
    )
  }
  if expected_origin_receipt_digest.0 == "" ||
    expected_current.origin_receipt_digest != expected_origin_receipt_digest {
    return AssetLineageRefused(AssetLineageOriginMismatch)
  }
  if slice.anchor != expected_anchor ||
    expected_anchor.origin_receipt_digest != expected_origin_receipt_digest {
    return AssetLineageRefused(AssetLineageAnchorMismatch)
  }
  let mut cursor = expected_anchor
  let verified_transitions : Array[AssetLineageTransition] = []
  let binding_cache : Map[String, Bool] = Map([])
  for index, entry in slice.transfers {
    let transition = entry.signed_transfer.authorization.transition
    if transition.asset_id != cursor.asset_id ||
      transition.asset_id != expected_current.asset_id ||
      transition.origin_receipt_digest != expected_origin_receipt_digest {
      return AssetLineageRefused(AssetLineageAssetMismatch(index))
    }
    if transition.previous_event != cursor.last_event ||
      transition.previous_lineage_root != cursor.lineage_root {
      return AssetLineageRefused(AssetLineageParentMismatch(index))
    }
    if transition.from_owner != cursor.owner_id {
      return AssetLineageRefused(AssetLineageOwnerMismatch(index))
    }
    if transition.expected_version != cursor.version {
      return AssetLineageRefused(AssetLineageVersionMismatch(index))
    }
    if transition.to_owner == "" ||
      transition.to_owner == transition.from_owner ||
      transition.source_event.0 == "" {
      return AssetLineageRefused(AssetLineageInvalidRecipient(index))
    }
    if !asset_lineage_transfer_authentication_valid(
        hasher, verifier, entry, expected_session_id, expected_authority_key, binding_cache,
      ) {
      return AssetLineageRefused(AssetLineageAuthenticationRefused(index))
    }
    cursor = {
      asset_id: cursor.asset_id,
      owner_id: transition.to_owner,
      version: cursor.version + 1,
      last_event: transition.source_event,
      lineage_root: asset_lineage_transition_root(hasher, transition),
      origin_receipt_digest: cursor.origin_receipt_digest,
    }
    verified_transitions.push(transition)
  }
  let current_record_matches = cursor ==
    asset_record_lineage_anchor(expected_current)
  if !@audit.asset_lineage_slice_allowed(
      has_transfers=true,
      within_limit=true,
      origin_matches=true,
      anchor_matches=true,
      parent_chain_matches=true,
      every_transfer_authenticated=true,
      current_record_matches~,
    ) {
    return AssetLineageRefused(AssetLineageCurrentRecordMismatch)
  }
  AssetLineageVerified(VerifiedAssetLineageSlice::{
    initial_anchor: expected_anchor,
    final_anchor: cursor,
    transitions: verified_transitions,
  })
}

///|
pub fn VerifiedAssetLineageSlice::initial_anchor(
  self : VerifiedAssetLineageSlice,
) -> AssetLineageAnchor {
  self.initial_anchor
}

///|
pub fn VerifiedAssetLineageSlice::final_anchor(
  self : VerifiedAssetLineageSlice,
) -> AssetLineageAnchor {
  self.final_anchor
}

///|
pub fn VerifiedAssetLineageSlice::transfer_count(
  self : VerifiedAssetLineageSlice,
) -> Int {
  self.transitions.length()
}

///|
pub fn VerifiedAssetLineageSlice::transfer_events(
  self : VerifiedAssetLineageSlice,
) -> Array[@bft.Digest] {
  self.transitions.map(fn(transition) { transition.source_event })
}

///|
pub fn VerifiedAssetLineageSlice::transitions(
  self : VerifiedAssetLineageSlice,
) -> Array[AssetLineageTransition] {
  self.transitions.copy()
}

///|
pub fn VerifiedAssetLineageSlice::contains_event(
  self : VerifiedAssetLineageSlice,
  event : @bft.Digest,
) -> Bool {
  self.transitions.any(fn(transition) { transition.source_event == event })
}
