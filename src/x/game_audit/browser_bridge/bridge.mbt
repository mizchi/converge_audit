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
