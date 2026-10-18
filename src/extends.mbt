///|
pub extend AuditAlert with Debug::{to_repr}

///|
pub extend AuditAlert with Eq::{not_equal, equal}

///|
pub extend AuditAlertKind with Debug::{to_repr}

///|
pub extend AuditAlertKind with Eq::{not_equal, equal}

///|
pub extend AuthenticatedEvent with Debug::{to_repr}

///|
pub extend AuthenticatedEvent with Eq::{not_equal, equal}

///|
pub extend DeliveryResult with Debug::{to_repr}

///|
pub extend DeliveryResult with Eq::{not_equal, equal}

///|
pub extend Digest with Compare::{op_lt, op_le, op_ge, compare, op_gt}

///|
pub extend Digest with Debug::{to_repr}

///|
pub extend Digest with Eq::{not_equal, equal}

///|
pub extend Digest with Hash::{hash, hash_combine}

///|
pub extend FnvHasher with Hasher::{hash_string}

///|
pub extend MockSigner with Signer::{sign, public_key}

///|
pub extend MockVerifier with Verifier::{verify}

///|
pub extend PublicKey with Debug::{to_repr}

///|
pub extend PublicKey with Eq::{not_equal, equal}

///|
pub extend PublicKey with Hash::{hash, hash_combine}

///|
pub extend Signature with Debug::{to_repr}

///|
pub extend Signature with Eq::{not_equal, equal}
