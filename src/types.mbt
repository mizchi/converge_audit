///|
/// Content-addressed hash digest of an event.
pub(all) struct Digest(String) derive(Eq, Compare, Hash, Debug)

///|
/// Cryptographic signature over a digest.
pub(all) struct Signature(String) derive(Eq, Debug)

///|
/// Public key identifying a peer for signature verification.
pub(all) struct PublicKey(String) derive(Eq, Hash, Debug)

///|
/// An event wrapped with cryptographic authentication.
/// Contains the original event plus its hash, signature, and dependency hashes.
pub(all) struct SignedEvent {
  session_id : String
  digest : Digest
  signature : Signature
  author_key : PublicKey
  dep_hashes : Array[Digest]
  event : @types.Event
}

///|
/// Capability minted only after session, hash, roster, signature, equivocation,
/// and causal-dependency validation succeeds.
pub struct AuthenticatedEvent {
  session_id : String
  digest : Digest
  author_key : PublicKey
  event : @types.Event
} derive(Eq, Debug)

///|
/// Kind of audit validation failure detected.
pub(all) enum AuditAlertKind {
  SessionMismatch
  UnknownPeer
  AuthorKeyMismatch
  DependencyMismatch
  Equivocation
  HashMismatch
  InvalidSignature
  MissingDependency
} derive(Eq, Debug)

///|
/// Report of a rejected or conflicting event.
pub(all) struct AuditAlert {
  kind : AuditAlertKind
  peer : @types.PeerId
  digest : Digest
  detail : String
} derive(Eq, Debug)

///|
/// Result of attempting to deliver a signed event through the audit adapter.
pub(all) enum DeliveryResult {
  Accepted(AuthenticatedEvent)
  Buffered
  Rejected(AuditAlert)
} derive(Eq, Debug)
