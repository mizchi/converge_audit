///|
pub extend AuditDigest with Compare::{op_lt, op_le, op_ge, compare, op_gt}

///|
pub extend AuditDigest with Debug::{to_repr}

///|
pub extend AuditDigest with Eq::{not_equal, equal}

///|
pub extend AuditDigest with Hash::{hash, hash_combine}

///|
pub extend CheckpointCommitment with Debug::{to_repr}

///|
pub extend CheckpointCommitment with Eq::{not_equal, equal}
