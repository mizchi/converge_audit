///|
pub(all) enum InventoryLineageCentralRefusal {
  InventoryLineageWireRefused(@wire.InventoryLineageWireError)
  InventoryLineageListingRefused(InventoryListingCentralRefusal)
  InventoryLineageVerificationRefused(@inventory.AssetLineageRefusal)
} derive(Eq, Debug)

///|
/// Capability produced only when the bounded suffix and the current
/// checkpoint-authenticated inventory record terminate at the same lineage
/// root.
pub struct InventoryLineageCentralVerified {
  listing : InventoryListingCentralVerified
  lineage : @inventory.VerifiedAssetLineageSlice
} derive(Eq, Debug)

///|
pub(all) enum InventoryLineageCentralResult {
  InventoryLineageCentralVerified(InventoryLineageCentralVerified)
  InventoryLineageCentralRefused(InventoryLineageCentralRefusal)
} derive(Eq, Debug)

///|
pub fn InventoryLineageCentralVerified::asset_id(
  self : InventoryLineageCentralVerified,
) -> String {
  self.listing.asset_id()
}

///|
pub fn InventoryLineageCentralVerified::current_owner_id(
  self : InventoryLineageCentralVerified,
) -> String {
  self.listing.current_owner_id()
}

///|
pub fn InventoryLineageCentralVerified::checkpoint_digest(
  self : InventoryLineageCentralVerified,
) -> @bft.Digest {
  self.listing.checkpoint_digest()
}

///|
pub fn InventoryLineageCentralVerified::transfer_count(
  self : InventoryLineageCentralVerified,
) -> Int {
  self.lineage.transfer_count()
}

///|
pub fn InventoryLineageCentralVerified::transfer_events(
  self : InventoryLineageCentralVerified,
) -> Array[@bft.Digest] {
  self.lineage.transfer_events()
}

///|
pub fn InventoryLineageCentralVerified::transitions(
  self : InventoryLineageCentralVerified,
) -> Array[@inventory.AssetLineageTransition] {
  self.lineage.transitions()
}

///|
pub fn InventoryLineageCentralVerified::contains_event(
  self : InventoryLineageCentralVerified,
  event : @bft.Digest,
) -> Bool {
  self.lineage.contains_event(event)
}

///|
pub fn InventoryLineageCentralVerified::initial_anchor(
  self : InventoryLineageCentralVerified,
) -> @inventory.AssetLineageAnchor {
  self.lineage.initial_anchor()
}

///|
pub fn InventoryLineageCentralVerified::final_anchor(
  self : InventoryLineageCentralVerified,
) -> @inventory.AssetLineageAnchor {
  self.lineage.final_anchor()
}

///|
/// Verify a historical suffix independently of marketplace revocation state.
/// This is important for appeals: cryptographic evidence remains admissible
/// while use/listing of a revoked asset stays blocked by the policy layer.
pub fn verify_inventory_lineage_proof_bundle(
  hasher : &@bft.Hasher,
  verifier : &@bft.Verifier,
  bundle_bytes : Bytes,
  expected_session_id~ : String,
  expected_authority_key~ : @bft.PublicKey,
  expected_checkpoint_digest~ : @bft.Digest,
  expected_game_manifest_digest~ : @bft.Digest,
  expected_origin~ : @market.ItemReceipt,
  expected_seller_id~ : String,
  expected_anchor~ : @inventory.AssetLineageAnchor,
  limits~ : @wire.InventoryLineageWireLimits,
) -> InventoryLineageCentralResult {
  let bundle = match
    @wire.decode_inventory_lineage_proof_bundle(bundle_bytes, limits~) {
    Ok(value) => value
    Err(reason) =>
      return InventoryLineageCentralRefused(InventoryLineageWireRefused(reason))
  }
  if expected_anchor.version == 0 &&
    expected_anchor !=
    @inventory.origin_asset_lineage_anchor(hasher, expected_origin) {
    return InventoryLineageCentralRefused(
      InventoryLineageVerificationRefused(
        @inventory.AssetLineageRefusal::AssetLineageAnchorMismatch,
      ),
    )
  }
  let listing = match
    verify_inventory_listing_proof_bundle(
      hasher,
      verifier,
      @wire.encode_inventory_listing_proof_bundle(bundle.listing),
      expected_session_id~,
      expected_authority_key~,
      expected_checkpoint_digest~,
      expected_game_manifest_digest~,
      expected_origin~,
      expected_seller_id~,
      rejected_ancestor=false,
      limits=limits.listing_limits,
    ) {
    InventoryListingVerified(value) => value
    InventoryListingRefused(reason) =>
      return InventoryLineageCentralRefused(
        InventoryLineageListingRefused(reason),
      )
  }
  let lineage = match
    @inventory.verify_asset_lineage_slice(
      hasher,
      verifier,
      bundle.lineage,
      expected_session_id~,
      expected_authority_key~,
      expected_origin_receipt_digest=@inventory.inventory_origin_receipt_digest(
        hasher, expected_origin,
      ),
      expected_anchor~,
      expected_current=bundle.listing.proof.record,
      max_transfers=limits.max_transfers,
    ) {
    AssetLineageVerified(value) => value
    AssetLineageRefused(reason) =>
      return InventoryLineageCentralRefused(
        InventoryLineageVerificationRefused(reason),
      )
  }
  InventoryLineageCentralVerified(InventoryLineageCentralVerified::{
    listing,
    lineage,
  })
}
