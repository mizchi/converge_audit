///|
/// Minimal JavaScript boundary for browser-side audit commitments. Hashing and
/// Merkle framing stay in the MoonBit implementation used by the verifier.
pub fn audit_browser_sha256(value : String) -> String {
  let hasher = @crypto.ExperimentalSha256Hasher::new()
  hasher.hash_string(value).0
}

///|
/// Build the game-neutral `mizchi/converge_audit/audit/merkle` root with SHA-256.
pub fn audit_browser_merkle_root(payloads : Array[String]) -> String {
  let hasher = @crypto.ExperimentalSha256Hasher::new()
  @merkle.MerkleTree::build(hasher, payloads).root().0
}

///|
/// Expose MoonBit-owned Merkle framing for asynchronous platform hashers.
pub fn audit_browser_merkle_leaf_payload(payload : String) -> String {
  @merkle.canonical_leaf_payload(payload)
}

///|
pub fn audit_browser_merkle_node_payload(
  left : String,
  right : String,
) -> String {
  @merkle.canonical_node_payload(@bft.Digest(left), @bft.Digest(right))
}

///|
pub fn audit_browser_merkle_empty_payload() -> String {
  @merkle.canonical_empty_payload()
}

///|
pub fn audit_browser_merkle_root_payload(
  leaf_count : Int,
  content_root : String,
) -> String {
  @merkle.canonical_root_payload(leaf_count, @bft.Digest(content_root))
}

///|
/// Derive the lower-hex Ed25519 public key for a 32-byte lower/uppercase hex
/// seed. Empty string is the JavaScript-boundary refusal value.
pub fn audit_browser_ed25519_public_key(seed_hex : String) -> String {
  match @crypto.ExperimentalEd25519Signer::from_seed_hex(seed_hex) {
    Some(signer) => signer.public_key().0
    None => ""
  }
}

///|
/// Sign the UTF-8 bytes of a digest string with a hex Ed25519 seed. Empty
/// string is the JavaScript-boundary refusal value.
pub fn audit_browser_ed25519_sign(seed_hex : String, digest : String) -> String {
  match @crypto.ExperimentalEd25519Signer::from_seed_hex(seed_hex) {
    Some(signer) => signer.sign(@bft.Digest(digest)).0
    None => ""
  }
}

///|
/// Strictly verify the lower-hex Ed25519 wire form used by the reference game.
pub fn audit_browser_ed25519_verify(
  public_key : String,
  digest : String,
  signature : String,
) -> Bool {
  let verifier = @crypto.ExperimentalEd25519Verifier::new()
  verifier.verify(
    @bft.PublicKey(public_key),
    @bft.Digest(digest),
    @bft.Signature(signature),
  )
}

///|
/// Expose the same MoonBit-owned replay-witness manifest statement used by the
/// server verifier. The browser hashes this statement with its WebCrypto
/// adapter; it does not get to choose a different roster order or framing.
pub fn audit_browser_replay_witness_session_manifest_statement(
  game_manifest_digest : String,
  referee_key : String,
  witness_ids : Array[String],
  witness_keys : Array[String],
  max_faults : Int,
) -> String {
  if witness_ids.length() != witness_keys.length() {
    return ""
  }
  let witnesses : Array[@witness_manifest.ReplayWitnessIdentity] = []
  for index in 0..<witness_ids.length() {
    witnesses.push({
      id: witness_ids[index],
      key: @bft.PublicKey(witness_keys[index]),
    })
  }
  @witness_manifest.serialize_replay_witness_session_manifest(
    game_manifest_digest=@bft.Digest(game_manifest_digest),
    referee_key=@bft.PublicKey(referee_key),
    witnesses~,
    max_faults~,
  )
}

///|
/// Expose the first statement in the server's bounded origin hash plan. JSON
/// plan construction stays outside this browser bridge because MoonBit's JSON
/// object runtime initializes a random hash seed at module load, which is not
/// allowed in a Cloudflare Worker global scope.
pub fn audit_browser_inventory_origin_receipt_statement(
  asset_id : String,
  recipient_id : String,
  item_type : String,
  quantity : Int,
  source_event : String,
  output_index : Int,
) -> String {
  let origin : @inventory_origin.InventoryOrigin = {
    asset_id,
    recipient_id,
    item_type,
    quantity,
    source_event: @bft.Digest(source_event),
    output_index,
  }
  if !@inventory_origin.inventory_origin_valid(origin) {
    return ""
  }
  @inventory_origin.serialize_inventory_origin_receipt(origin)
}

///|
/// Expose the second origin statement after the host hashes the receipt
/// statement. This keeps the dependency explicit without duplicating framing
/// in TypeScript.
pub fn audit_browser_inventory_origin_lineage_statement(
  receipt_digest : String,
) -> String {
  if receipt_digest == "" {
    return ""
  }
  @inventory_origin.serialize_inventory_origin_lineage(
    @bft.Digest(receipt_digest),
  )
}

///|
/// Expose the canonical statement for one parent-bound lineage transition.
/// Hash execution remains in the host WebCrypto adapter.
pub fn audit_browser_inventory_lineage_transition_statement(
  asset_id : String,
  origin_receipt_digest : String,
  from_owner : String,
  to_owner : String,
  expected_version : Int,
  previous_event : String,
  source_event : String,
  previous_lineage_root : String,
) -> String {
  let transition : @inventory_transition.InventoryLineageTransition = {
    asset_id,
    origin_receipt_digest: @bft.Digest(origin_receipt_digest),
    from_owner,
    to_owner,
    expected_version,
    previous_event: @bft.Digest(previous_event),
    source_event: @bft.Digest(source_event),
    previous_lineage_root: @bft.Digest(previous_lineage_root),
  }
  if !@inventory_transition.inventory_lineage_transition_valid(transition) {
    return ""
  }
  @inventory_transition.serialize_inventory_lineage_transition(transition)
}

///|
/// Expose the canonical current inventory record without importing stateful
/// inventory maps into the browser bridge.
pub fn audit_browser_inventory_record_statement(
  asset_id : String,
  owner_id : String,
  item_type : String,
  quantity : Int,
  origin_source_event : String,
  origin_output_index : Int,
  origin_receipt_digest : String,
  version : Int,
  last_event : String,
  lineage_root : String,
) -> String {
  let record : @inventory_record.InventoryRecord = {
    asset_id,
    owner_id,
    item_type,
    quantity,
    origin_source_event: @bft.Digest(origin_source_event),
    origin_output_index,
    origin_receipt_digest: @bft.Digest(origin_receipt_digest),
    version,
    last_event: @bft.Digest(last_event),
    lineage_root: @bft.Digest(lineage_root),
  }
  if !@inventory_record.inventory_record_valid(record) {
    return ""
  }
  @inventory_record.serialize_inventory_record(record)
}

///|
pub fn audit_browser_authmap_node_statement(
  key : String,
  value : String,
  left_digest : String,
  right_digest : String,
) -> String {
  if key == "" || value == "" || left_digest == "" || right_digest == "" {
    return ""
  }
  @authmap.serialize_authmap_node(
    key,
    value,
    @bft.Digest(left_digest),
    @bft.Digest(right_digest),
  )
}

///|
pub fn audit_browser_authmap_empty_statement() -> String {
  @authmap.serialize_authmap_empty()
}

///|
pub fn audit_browser_authmap_root_statement(
  entry_count : Int,
  node_digest : String,
) -> String {
  if entry_count < 0 || node_digest == "" {
    return ""
  }
  @authmap.serialize_authmap_root(entry_count, @bft.Digest(node_digest))
}
