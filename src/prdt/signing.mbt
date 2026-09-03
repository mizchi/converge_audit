///|
/// Shared-secret HMAC-SHA256 authenticator implementing the converge_audit
/// `Signer` and `Verifier` traits.
///
/// This is a MAC, not a signature: anyone who can verify can also forge.
/// It is meant for tests and local development. Deployments should plug an
/// Ed25519 signer/verifier (for example the experimental adapter in
/// `x/game_audit/crypto`) through the same traits.
pub struct SharedSecretAuthenticator {
  key : Bytes
  public_key : @bft.PublicKey
}

///|
pub fn SharedSecretAuthenticator::new(
  key_id : String,
  secret : String,
) -> SharedSecretAuthenticator {
  {
    key: @utf8.encode(("prdt/shared-secret/v1:" + secret)[:]),
    public_key: @bft.PublicKey(key_id),
  }
}

///|
fn SharedSecretAuthenticator::tag(
  self : SharedSecretAuthenticator,
  digest : @bft.Digest,
) -> String {
  bytes_to_lower_hex(@hash.hmac_sha256(self.key, @utf8.encode(digest.0[:])))
}

///|
pub impl @bft.Signer for SharedSecretAuthenticator with fn sign(self, digest) {
  @bft.Signature(self.tag(digest))
}

///|
pub impl @bft.Signer for SharedSecretAuthenticator with fn public_key(self) {
  self.public_key
}

///|
pub impl @bft.Verifier for SharedSecretAuthenticator with fn verify(
  self,
  key,
  digest,
  signature,
) {
  key == self.public_key && signature.0 == self.tag(digest)
}
