///|
pub extend Checkpoint with @commitment.CheckpointAdapter::{
  checkpoint_commitment,
}

///|
pub extend Checkpoint with Debug::{to_repr}

///|
pub extend Checkpoint with Eq::{not_equal, equal}

///|
pub extend CheckpointVerification with Debug::{to_repr}

///|
pub extend CheckpointVerification with Eq::{not_equal, equal}

///|
pub extend SignedCheckpoint with Debug::{to_repr}

///|
pub extend SignedCheckpoint with Eq::{not_equal, equal}
