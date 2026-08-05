///|
pub(all) enum AssetOwner {
  O1
  O2
  O3
} derive(Eq, Debug)

///|
pub(all) enum AssetListingStatus {
  NeverListed
  Active
  Canceled
  Quarantined
} derive(Eq, Debug)

///|
pub(all) enum AssetListingNonce {
  N1
  N2
  N3
} derive(Eq, Debug)

///|
pub(all) struct AssetSnapshot {
  owner : AssetOwner
  owner_version : Int
  transfer_count : Int
  listing_status : AssetListingStatus
  listing_owner : AssetOwner
  listing_version : Int
  listing_nonce : AssetListingNonce
  canceled_nonce_mask : Int
  revoked_version_mask : Int
  lineage_clean : Bool
  last_transfer_lineage_clean : Bool
  last_sender_authenticated : Bool
  last_recipient_authenticated : Bool
} derive(Eq, Debug)

///|
pub struct AssetDriver {
  snapshot : AssetSnapshot
  broken_revocation : Bool
}

///|
fn initial_asset_snapshot() -> AssetSnapshot {
  {
    owner: O1,
    owner_version: 0,
    transfer_count: 0,
    listing_status: NeverListed,
    listing_owner: O1,
    listing_version: -1,
    listing_nonce: N1,
    canceled_nonce_mask: 0,
    revoked_version_mask: 0,
    lineage_clean: true,
    last_transfer_lineage_clean: true,
    last_sender_authenticated: true,
    last_recipient_authenticated: true,
  }
}

///|
pub fn new_asset_driver(broken_revocation? : Bool = false) -> AssetDriver {
  { snapshot: initial_asset_snapshot(), broken_revocation }
}

///|
fn variant_tag(value : Json, field : String) -> Result[String, String] {
  guard value is Object(fields) else {
    return Err("\{field} must be an ITF variant object")
  }
  match fields.get("tag") {
    Some(String(tag)) => Ok(tag)
    _ => Err("\{field} is missing a variant tag")
  }
}

///|
fn decode_owner(value : Json, field : String) -> Result[AssetOwner, String] {
  match variant_tag(value, field) {
    Ok("O1") => Ok(O1)
    Ok("O2") => Ok(O2)
    Ok("O3") => Ok(O3)
    Ok(tag) => Err("unknown \{field} owner \{tag}")
    Err(reason) => Err(reason)
  }
}

///|
fn decode_listing_status(value : Json) -> Result[AssetListingStatus, String] {
  match variant_tag(value, "listingStatus") {
    Ok("NeverListed") => Ok(NeverListed)
    Ok("Active") => Ok(Active)
    Ok("Canceled") => Ok(Canceled)
    Ok("Quarantined") => Ok(Quarantined)
    Ok(tag) => Err("unknown listingStatus \{tag}")
    Err(reason) => Err(reason)
  }
}

///|
fn decode_nonce(
  value : Json,
  field : String,
) -> Result[AssetListingNonce, String] {
  match variant_tag(value, field) {
    Ok("N1") => Ok(N1)
    Ok("N2") => Ok(N2)
    Ok("N3") => Ok(N3)
    Ok(tag) => Err("unknown \{field} nonce \{tag}")
    Err(reason) => Err(reason)
  }
}

///|
fn nonce_bit(nonce : AssetListingNonce) -> Int {
  match nonce {
    N1 => 1
    N2 => 2
    N3 => 4
  }
}

///|
fn version_bit(version : Int) -> Result[Int, String] {
  match version {
    0 => Ok(1)
    1 => Ok(2)
    2 => Ok(4)
    _ => Err("asset version must be between 0 and 2")
  }
}

///|
fn required_pick(picks : Json, name : String) -> Result[Json, String] {
  @quint_connect.required_nondet(picks, name)
}

///|
fn decode_pick_int(picks : Json, name : String) -> Result[Int, String] {
  match required_pick(picks, name) {
    Ok(value) => @quint_connect.decode_itf_int(value)
    Err(reason) => Err(reason)
  }
}

///|
fn decode_pick_bool(picks : Json, name : String) -> Result[Bool, String] {
  match required_pick(picks, name) {
    Ok(true) => Ok(true)
    Ok(false) => Ok(false)
    Ok(_) => Err("\{name} must be a boolean")
    Err(reason) => Err(reason)
  }
}

///|
fn decode_pick_owner(picks : Json, name : String) -> Result[AssetOwner, String] {
  match required_pick(picks, name) {
    Ok(value) => decode_owner(value, name)
    Err(reason) => Err(reason)
  }
}

///|
fn decode_pick_nonce(
  picks : Json,
  name : String,
) -> Result[AssetListingNonce, String] {
  match required_pick(picks, name) {
    Ok(value) => decode_nonce(value, name)
    Err(reason) => Err(reason)
  }
}

///|
fn AssetDriver::apply_transfer(
  self : AssetDriver,
  picks : Json,
) -> Result[AssetDriver, String] {
  let from = match decode_pick_owner(picks, "from") {
    Ok(value) => value
    Err(reason) => return Err(reason)
  }
  let recipient = match decode_pick_owner(picks, "recipient") {
    Ok(value) => value
    Err(reason) => return Err(reason)
  }
  let previous_version = match decode_pick_int(picks, "previousVersion") {
    Ok(value) => value
    Err(reason) => return Err(reason)
  }
  let next_version = match decode_pick_int(picks, "nextVersion") {
    Ok(value) => value
    Err(reason) => return Err(reason)
  }
  let sender_authenticated = match
    decode_pick_bool(picks, "senderAuthenticated") {
    Ok(value) => value
    Err(reason) => return Err(reason)
  }
  let recipient_authenticated = match
    decode_pick_bool(picks, "recipientAuthenticated") {
    Ok(value) => value
    Err(reason) => return Err(reason)
  }
  let clean = @audit.asset_lineage_use_allowed(
    creation_verified=true,
    current_head_verified=true,
    open_revocations=if self.snapshot.revoked_version_mask == 0 { 0 } else { 1 },
  )
  let transition_allowed = @audit.transfer_transition_allowed(
    asset_exists=true,
    owner_matches=from == self.snapshot.owner,
    version_matches=previous_version == self.snapshot.owner_version &&
      next_version == previous_version + 1,
    recipient_valid=true,
    changes_owner=recipient != from,
    source_authenticated=sender_authenticated && recipient_authenticated,
  )
  if !clean || !transition_allowed || self.snapshot.listing_status == Active {
    Err("transferSome rejected by the MoonBit asset policy")
  } else {
    Ok({
      ..self,
      snapshot: {
        ..self.snapshot,
        owner: recipient,
        owner_version: next_version,
        transfer_count: self.snapshot.transfer_count + 1,
        last_transfer_lineage_clean: clean,
        last_sender_authenticated: sender_authenticated,
        last_recipient_authenticated: recipient_authenticated,
      },
    })
  }
}

///|
fn AssetDriver::apply_list(
  self : AssetDriver,
  picks : Json,
) -> Result[AssetDriver, String] {
  let seller = match decode_pick_owner(picks, "seller") {
    Ok(value) => value
    Err(reason) => return Err(reason)
  }
  let version = match decode_pick_int(picks, "version") {
    Ok(value) => value
    Err(reason) => return Err(reason)
  }
  let nonce = match decode_pick_nonce(picks, "nonce") {
    Ok(value) => value
    Err(reason) => return Err(reason)
  }
  let authenticated = match decode_pick_bool(picks, "authenticated") {
    Ok(value) => value
    Err(reason) => return Err(reason)
  }
  let clean = @audit.asset_lineage_use_allowed(
    creation_verified=true,
    current_head_verified=true,
    open_revocations=if self.snapshot.revoked_version_mask == 0 { 0 } else { 1 },
  )
  let bit = nonce_bit(nonce)
  if seller != self.snapshot.owner ||
    version != self.snapshot.owner_version ||
    !authenticated ||
    !clean ||
    self.snapshot.listing_status == Active ||
    (self.snapshot.canceled_nonce_mask & bit) != 0 {
    Err("listSome rejected by the MoonBit asset policy")
  } else {
    Ok({
      ..self,
      snapshot: {
        ..self.snapshot,
        listing_status: Active,
        listing_owner: seller,
        listing_version: version,
        listing_nonce: nonce,
      },
    })
  }
}

///|
fn AssetDriver::apply_cancel(
  self : AssetDriver,
  picks : Json,
) -> Result[AssetDriver, String] {
  let seller = match decode_pick_owner(picks, "seller") {
    Ok(value) => value
    Err(reason) => return Err(reason)
  }
  let version = match decode_pick_int(picks, "version") {
    Ok(value) => value
    Err(reason) => return Err(reason)
  }
  let authenticated = match decode_pick_bool(picks, "authenticated") {
    Ok(value) => value
    Err(reason) => return Err(reason)
  }
  if self.snapshot.listing_status != Active ||
    seller != self.snapshot.owner ||
    seller != self.snapshot.listing_owner ||
    version != self.snapshot.owner_version ||
    version != self.snapshot.listing_version ||
    !authenticated {
    Err("cancelSome rejected by the MoonBit asset policy")
  } else {
    Ok({
      ..self,
      snapshot: {
        ..self.snapshot,
        listing_status: Canceled,
        canceled_nonce_mask: self.snapshot.canceled_nonce_mask |
        nonce_bit(self.snapshot.listing_nonce),
      },
    })
  }
}

///|
fn AssetDriver::apply_revoke(
  self : AssetDriver,
  picks : Json,
) -> Result[AssetDriver, String] {
  let version = match decode_pick_int(picks, "version") {
    Ok(value) => value
    Err(reason) => return Err(reason)
  }
  let bit = match version_bit(version) {
    Ok(value) => value
    Err(reason) => return Err(reason)
  }
  let allowed = @audit.asset_lineage_decision_allowed(
    asset_exists=true,
    ancestor_in_lineage=version <= self.snapshot.owner_version,
    expected_decision_matches=true,
    revision_advances=true,
    decision_changes_status=(self.snapshot.revoked_version_mask & bit) == 0,
  )
  if !allowed {
    Err("revokeSome rejected by the MoonBit asset policy")
  } else {
    let quarantine = self.snapshot.listing_status == Active &&
      !self.broken_revocation
    Ok({
      ..self,
      snapshot: {
        ..self.snapshot,
        listing_status: if quarantine {
          Quarantined
        } else {
          self.snapshot.listing_status
        },
        canceled_nonce_mask: if quarantine {
          self.snapshot.canceled_nonce_mask |
          nonce_bit(self.snapshot.listing_nonce)
        } else {
          self.snapshot.canceled_nonce_mask
        },
        revoked_version_mask: self.snapshot.revoked_version_mask | bit,
        lineage_clean: false,
      },
    })
  }
}

///|
fn AssetDriver::apply_restore(
  self : AssetDriver,
  picks : Json,
) -> Result[AssetDriver, String] {
  let version = match decode_pick_int(picks, "version") {
    Ok(value) => value
    Err(reason) => return Err(reason)
  }
  let bit = match version_bit(version) {
    Ok(value) => value
    Err(reason) => return Err(reason)
  }
  let allowed = @audit.asset_lineage_decision_allowed(
    asset_exists=true,
    ancestor_in_lineage=version <= self.snapshot.owner_version,
    expected_decision_matches=true,
    revision_advances=true,
    decision_changes_status=(self.snapshot.revoked_version_mask & bit) != 0,
  )
  if !allowed {
    Err("restoreSome rejected by the MoonBit asset policy")
  } else {
    let remaining = self.snapshot.revoked_version_mask & (bit ^ 7)
    Ok({
      ..self,
      snapshot: {
        ..self.snapshot,
        revoked_version_mask: remaining,
        lineage_clean: remaining == 0,
      },
    })
  }
}

///|
fn AssetDriver::apply(
  self : AssetDriver,
  action : String,
  picks : Json,
) -> Result[AssetDriver, String] {
  match action {
    "init" => Ok({ ..self, snapshot: initial_asset_snapshot() })
    "transferSome" => self.apply_transfer(picks)
    "listSome" => self.apply_list(picks)
    "cancelSome" => self.apply_cancel(picks)
    "revokeSome" => self.apply_revoke(picks)
    "restoreSome" => self.apply_restore(picks)
    _ => Err("unknown AssetOwnership action \{action}")
  }
}

///|
fn object_field(
  fields : Map[String, Json],
  name : String,
) -> Result[Json, String] {
  match fields.get(name) {
    Some(value) => Ok(value)
    None => Err("ITF state is missing \{name}")
  }
}

///|
fn decode_state_int(
  fields : Map[String, Json],
  name : String,
) -> Result[Int, String] {
  match object_field(fields, name) {
    Ok(value) => @quint_connect.decode_itf_int(value)
    Err(reason) => Err(reason)
  }
}

///|
fn decode_state_bool(
  fields : Map[String, Json],
  name : String,
) -> Result[Bool, String] {
  match object_field(fields, name) {
    Ok(true) => Ok(true)
    Ok(false) => Ok(false)
    Ok(_) => Err("\{name} must be a boolean")
    Err(reason) => Err(reason)
  }
}

///|
fn decode_nonce_set(value : Json) -> Result[Int, String] {
  guard value is Object(fields) && fields.get("#set") is Some(Array(items)) else {
    return Err("canceledListingNonces must be an ITF set")
  }
  let mut mask = 0
  for item in items {
    let nonce = match decode_nonce(item, "canceledListingNonces") {
      Ok(value) => value
      Err(reason) => return Err(reason)
    }
    mask = mask | nonce_bit(nonce)
  }
  Ok(mask)
}

///|
fn decode_version_set(value : Json) -> Result[Int, String] {
  guard value is Object(fields) && fields.get("#set") is Some(Array(items)) else {
    return Err("revokedAncestors must be an ITF set")
  }
  let mut mask = 0
  for item in items {
    let version = match @quint_connect.decode_itf_int(item) {
      Ok(value) => value
      Err(reason) => return Err(reason)
    }
    let bit = match version_bit(version) {
      Ok(value) => value
      Err(reason) => return Err(reason)
    }
    mask = mask | bit
  }
  Ok(mask)
}

///|
fn decode_asset_snapshot(value : Json) -> Result[AssetSnapshot, String] {
  guard value is Object(fields) else {
    return Err("projected AssetOwnership state must be an object")
  }
  let owner = match object_field(fields, "owner") {
    Ok(value) =>
      match decode_owner(value, "owner") {
        Ok(value) => value
        Err(reason) => return Err(reason)
      }
    Err(reason) => return Err(reason)
  }
  let listing_status = match object_field(fields, "listingStatus") {
    Ok(value) =>
      match decode_listing_status(value) {
        Ok(value) => value
        Err(reason) => return Err(reason)
      }
    Err(reason) => return Err(reason)
  }
  let listing_owner = match object_field(fields, "listingOwner") {
    Ok(value) =>
      match decode_owner(value, "listingOwner") {
        Ok(value) => value
        Err(reason) => return Err(reason)
      }
    Err(reason) => return Err(reason)
  }
  let listing_nonce = match object_field(fields, "listingNonce") {
    Ok(value) =>
      match decode_nonce(value, "listingNonce") {
        Ok(value) => value
        Err(reason) => return Err(reason)
      }
    Err(reason) => return Err(reason)
  }
  let canceled_nonce_mask = match
    object_field(fields, "canceledListingNonces") {
    Ok(value) =>
      match decode_nonce_set(value) {
        Ok(value) => value
        Err(reason) => return Err(reason)
      }
    Err(reason) => return Err(reason)
  }
  let revoked_version_mask = match object_field(fields, "revokedAncestors") {
    Ok(value) =>
      match decode_version_set(value) {
        Ok(value) => value
        Err(reason) => return Err(reason)
      }
    Err(reason) => return Err(reason)
  }
  let owner_version = match decode_state_int(fields, "ownerVersion") {
    Ok(value) => value
    Err(reason) => return Err(reason)
  }
  let transfer_count = match decode_state_int(fields, "transferCount") {
    Ok(value) => value
    Err(reason) => return Err(reason)
  }
  let listing_version = match decode_state_int(fields, "listingVersion") {
    Ok(value) => value
    Err(reason) => return Err(reason)
  }
  let lineage_clean = match decode_state_bool(fields, "lineageClean") {
    Ok(value) => value
    Err(reason) => return Err(reason)
  }
  let last_transfer_lineage_clean = match
    decode_state_bool(fields, "lastTransferLineageClean") {
    Ok(value) => value
    Err(reason) => return Err(reason)
  }
  let last_sender_authenticated = match
    decode_state_bool(fields, "lastSenderAuthenticated") {
    Ok(value) => value
    Err(reason) => return Err(reason)
  }
  let last_recipient_authenticated = match
    decode_state_bool(fields, "lastRecipientAuthenticated") {
    Ok(value) => value
    Err(reason) => return Err(reason)
  }
  Ok({
    owner,
    owner_version,
    transfer_count,
    listing_status,
    listing_owner,
    listing_version,
    listing_nonce,
    canceled_nonce_mask,
    revoked_version_mask,
    lineage_clean,
    last_transfer_lineage_clean,
    last_sender_authenticated,
    last_recipient_authenticated,
  })
}

///|
pub fn replay_asset_ownership(
  trace : @quint_connect.ItfTrace,
  driver : AssetDriver,
) -> Result[@quint_connect.ReplaySummary, @quint_connect.ConnectError] {
  @quint_connect.replay(
    trace,
    driver,
    (driver, action, picks) => driver.apply(action, picks),
    driver => driver.snapshot,
    decode_asset_snapshot,
  )
}

///|
pub fn replay_asset_ownership_suite(
  traces : Array[@quint_connect.ItfTrace],
  broken_revocation? : Bool = false,
) -> Result[@quint_connect.ReplaySuiteSummary, @quint_connect.SuiteError] {
  @quint_connect.replay_suite(
    traces,
    () => new_asset_driver(broken_revocation~),
    (driver, action, picks) => driver.apply(action, picks),
    driver => driver.snapshot,
    decode_asset_snapshot,
  )
}
