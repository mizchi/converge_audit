///|
pub extend ExperimentalEd25519Signer with @bft.Signer::{sign, public_key}

///|
pub extend ExperimentalEd25519Verifier with @bft.Verifier::{verify}

///|
pub extend ExperimentalSha256Hasher with @bft.Hasher::{hash_string}
