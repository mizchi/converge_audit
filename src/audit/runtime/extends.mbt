///|
pub extend AtomicCheckpointSealPlan with Debug::{to_repr}

///|
pub extend AtomicCheckpointSealPlan with Eq::{not_equal, equal}

///|
pub extend AtomicCheckpointSealResult with Debug::{to_repr}

///|
pub extend AtomicCheckpointSealResult with Eq::{not_equal, equal}

///|
pub extend AuditBoundary with Debug::{to_repr}

///|
pub extend AuditBoundary with Eq::{not_equal, equal}

///|
pub extend AuthenticatedCheckpointAck with Debug::{to_repr}

///|
pub extend AuthenticatedCheckpointAck with Eq::{not_equal, equal}

///|
pub extend CheckpointAckDecision with Debug::{to_repr}

///|
pub extend CheckpointAckDecision with Eq::{not_equal, equal}

///|
pub extend CheckpointAckEvidence with Debug::{to_repr}

///|
pub extend CheckpointAckEvidence with Eq::{not_equal, equal}

///|
pub extend CheckpointAckOpenResult with Debug::{to_repr}

///|
pub extend CheckpointAckOpenResult with Eq::{not_equal, equal}

///|
pub extend CheckpointAckRefusal with Debug::{to_repr}

///|
pub extend CheckpointAckRefusal with Eq::{not_equal, equal}

///|
pub extend CheckpointOutboxAckResult with Debug::{to_repr}

///|
pub extend CheckpointOutboxAckResult with Eq::{not_equal, equal}

///|
pub extend CheckpointOutboxClaimResult with Debug::{to_repr}

///|
pub extend CheckpointOutboxClaimResult with Eq::{not_equal, equal}

///|
pub extend CheckpointOutboxEntry with Debug::{to_repr}

///|
pub extend CheckpointOutboxEntry with Eq::{not_equal, equal}

///|
pub extend CheckpointOutboxOpenResult with Debug::{to_repr}

///|
pub extend CheckpointOutboxOpenResult with Eq::{not_equal, equal}

///|
pub extend CheckpointOutboxReleaseResult with Debug::{to_repr}

///|
pub extend CheckpointOutboxReleaseResult with Eq::{not_equal, equal}

///|
pub extend CheckpointOutboxState with Debug::{to_repr}

///|
pub extend CheckpointOutboxState with Eq::{not_equal, equal}

///|
pub extend CheckpointSealConflictReason with Debug::{to_repr}

///|
pub extend CheckpointSealConflictReason with Eq::{not_equal, equal}

///|
pub extend CheckpointSealDraft with Debug::{to_repr}

///|
pub extend CheckpointSealDraft with Eq::{not_equal, equal}

///|
pub extend CheckpointSealHead with Debug::{to_repr}

///|
pub extend CheckpointSealHead with Eq::{not_equal, equal}

///|
pub extend CheckpointSealRefusal with Debug::{to_repr}

///|
pub extend CheckpointSealRefusal with Eq::{not_equal, equal}

///|
pub extend CheckpointSealStorageSnapshot with Debug::{to_repr}

///|
pub extend CheckpointSealStorageSnapshot with Eq::{not_equal, equal}

///|
pub extend EpochClosureConflictReason with Debug::{to_repr}

///|
pub extend EpochClosureConflictReason with Eq::{not_equal, equal}

///|
pub extend EpochClosureEvidence with Debug::{to_repr}

///|
pub extend EpochClosureEvidence with Eq::{not_equal, equal}

///|
pub extend EpochClosureOpenResult with Debug::{to_repr}

///|
pub extend EpochClosureOpenResult with Eq::{not_equal, equal}

///|
pub extend EpochClosurePendingReason with Debug::{to_repr}

///|
pub extend EpochClosurePendingReason with Eq::{not_equal, equal}

///|
pub extend EpochClosureRefusal with Debug::{to_repr}

///|
pub extend EpochClosureRefusal with Eq::{not_equal, equal}

///|
pub extend OutboxAckRefusal with Debug::{to_repr}

///|
pub extend OutboxAckRefusal with Eq::{not_equal, equal}

///|
pub extend OutboxClaimRefusal with Debug::{to_repr}

///|
pub extend OutboxClaimRefusal with Eq::{not_equal, equal}

///|
pub extend OutboxEntryRefusal with Debug::{to_repr}

///|
pub extend OutboxEntryRefusal with Eq::{not_equal, equal}

///|
pub extend PeerCheckpointResponse with Debug::{to_repr}

///|
pub extend PeerCheckpointResponse with Eq::{not_equal, equal}

///|
pub extend PeerCheckpointResponseSelection with Debug::{to_repr}

///|
pub extend PeerCheckpointResponseSelection with Eq::{not_equal, equal}

///|
pub extend PeerDeliveryRefusal with Debug::{to_repr}

///|
pub extend PeerDeliveryRefusal with Eq::{not_equal, equal}

///|
pub extend PeerDeliverySelectionResult with Debug::{to_repr}

///|
pub extend PeerDeliverySelectionResult with Eq::{not_equal, equal}

///|
pub extend PeerRouteState with Debug::{to_repr}

///|
pub extend PeerRouteState with Eq::{not_equal, equal}

///|
pub extend PeerRouteUpdateResult with Debug::{to_repr}

///|
pub extend PeerRouteUpdateResult with Eq::{not_equal, equal}

///|
pub extend PlayerLocalAuditEvent with Debug::{to_repr}

///|
pub extend PlayerLocalAuditEvent with Eq::{not_equal, equal}

///|
pub extend PlayerLocalAuditImage with Debug::{to_repr}

///|
pub extend PlayerLocalAuditImage with Eq::{not_equal, equal}

///|
pub extend PlayerLocalAuditStoreRefusal with Debug::{to_repr}

///|
pub extend PlayerLocalAuditStoreRefusal with Eq::{not_equal, equal}

///|
pub extend PlayerLocalCheckpointOutboxRecord with Debug::{to_repr}

///|
pub extend PlayerLocalCheckpointOutboxRecord with Eq::{not_equal, equal}

///|
pub extend PlayerLocalEventAdmission with Debug::{to_repr}

///|
pub extend PlayerLocalEventAdmission with Eq::{not_equal, equal}

///|
pub extend PlayerLocalEventEquivocation with Debug::{to_repr}

///|
pub extend PlayerLocalEventEquivocation with Eq::{not_equal, equal}

///|
pub extend PlayerLocalEventRefusal with Debug::{to_repr}

///|
pub extend PlayerLocalEventRefusal with Eq::{not_equal, equal}

///|
pub extend PlayerLocalEvidenceHold with Debug::{to_repr}

///|
pub extend PlayerLocalEvidenceHold with Eq::{not_equal, equal}

///|
pub extend PlayerLocalEvidenceHoldKind with Debug::{to_repr}

///|
pub extend PlayerLocalEvidenceHoldKind with Eq::{not_equal, equal}

///|
pub extend PlayerLocalEvidenceHoldResolutionDecision with Debug::{to_repr}

///|
pub extend PlayerLocalEvidenceHoldResolutionDecision with Eq::{not_equal, equal}

///|
pub extend PlayerLocalEvidenceHoldState with Debug::{to_repr}

///|
pub extend PlayerLocalEvidenceHoldState with Eq::{not_equal, equal}

///|
pub extend PlayerLocalEvidenceInboxCursor with Debug::{to_repr}

///|
pub extend PlayerLocalEvidenceInboxCursor with Eq::{not_equal, equal}

///|
pub extend PlayerLocalEvidencePollJob with Debug::{to_repr}

///|
pub extend PlayerLocalEvidencePollJob with Eq::{not_equal, equal}

///|
pub extend PlayerLocalEvidencePollJobState with Debug::{to_repr}

///|
pub extend PlayerLocalEvidencePollJobState with Eq::{not_equal, equal}

///|
pub extend PlayerLocalOutboxUpdateResult with Debug::{to_repr}

///|
pub extend PlayerLocalOutboxUpdateResult with Eq::{not_equal, equal}

///|
pub extend PlayerLocalRetentionAnchor with Debug::{to_repr}

///|
pub extend PlayerLocalRetentionAnchor with Eq::{not_equal, equal}

///|
pub extend PlayerLocalSealCommitResult with Debug::{to_repr}

///|
pub extend PlayerLocalSealCommitResult with Eq::{not_equal, equal}

///|
pub extend PlayerLocalSealPlan with Debug::{to_repr}

///|
pub extend PlayerLocalSealPlan with Eq::{not_equal, equal}

///|
pub extend PlayerLocalSealPrepareResult with Debug::{to_repr}

///|
pub extend PlayerLocalSealPrepareResult with Eq::{not_equal, equal}

///|
pub extend PlayerLocalSealWriteSet with Debug::{to_repr}

///|
pub extend PlayerLocalSealWriteSet with Eq::{not_equal, equal}

///|
pub extend RetrySelectionRefusal with Debug::{to_repr}

///|
pub extend RetrySelectionRefusal with Eq::{not_equal, equal}

///|
pub extend RetrySelectionResult with Debug::{to_repr}

///|
pub extend RetrySelectionResult with Eq::{not_equal, equal}

///|
pub extend TrustedEpochClosure with Debug::{to_repr}

///|
pub extend TrustedEpochClosure with Eq::{not_equal, equal}
