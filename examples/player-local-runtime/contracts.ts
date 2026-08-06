export interface AuditBoundary {
  protocol_version: number;
  purpose: string;
  manifest_digest: string;
  scope_id: string;
  unit_id: string;
}

export interface PlayerLocalStoreConfiguration {
  boundary: AuditBoundary;
  genesis_digest: string;
  outbox_capacity: number;
}

export interface PlayerLocalAuditEvent {
  boundary: AuditBoundary;
  author_id: string;
  counter: number;
  epoch: number;
  event_digest: string;
  canonical_event: string;
}

export interface PlayerLocalEventEquivocation {
  accepted: PlayerLocalAuditEvent;
  conflicting: PlayerLocalAuditEvent;
}

export interface CheckpointSealDraft {
  boundary: AuditBoundary;
  epoch: number;
  previous_checkpoint: string;
  checkpoint_digest: string;
  canonical_envelope: string;
}

export interface CheckpointSealHead {
  boundary: AuditBoundary;
  epoch: number;
  checkpoint_digest: string;
}

export type CheckpointOutboxState =
  | { kind: "pending" }
  | { kind: "in_flight"; lease_expires_at_ms: number }
  | { kind: "acknowledged" };

export interface PlayerLocalCheckpointOutboxRecord {
  boundary: AuditBoundary;
  destination_id: string;
  epoch: number;
  checkpoint_digest: string;
  canonical_envelope: string;
  created_order: number;
  state: CheckpointOutboxState;
}

export interface EpochClosureEvidence {
  boundary: AuditBoundary;
  epoch: number;
  roster_digest: string;
  frontier_digest: string;
  certificate_digest: string;
}

export interface CheckpointAckEvidence {
  boundary: AuditBoundary;
  authority_id: string;
  epoch: number;
  checkpoint_digest: string;
  decision: "accepted" | "duplicate";
}

/** Last checkpoint whose detailed local evidence was safely pruned. */
export interface PlayerLocalRetentionAnchor {
  boundary: AuditBoundary;
  epoch: number;
  checkpoint_digest: string;
}

export type PlayerLocalEvidenceHoldKind = "fork" | "challenge" | "appeal";

export type PlayerLocalEvidenceHoldState =
  | { kind: "active" }
  | {
      kind: "resolved";
      decision: "upheld" | "dismissed";
      resolution_digest: string;
    };

/** Durable authenticated reference that prevents evidence prefix pruning. */
export interface PlayerLocalEvidenceHold {
  boundary: AuditBoundary;
  hold_id: string;
  epoch: number;
  checkpoint_digest: string;
  kind: PlayerLocalEvidenceHoldKind;
  reference_digest: string;
  state: PlayerLocalEvidenceHoldState;
}

export interface PlayerLocalEvidenceHoldResolution {
  boundary: AuditBoundary;
  hold_id: string;
  epoch: number;
  checkpoint_digest: string;
  reference_digest: string;
  decision: "upheld" | "dismissed";
  resolution_digest: string;
}

/** Last atomically applied message from one authenticated evidence source. */
export interface PlayerLocalEvidenceInboxCursor {
  boundary: AuditBoundary;
  source_id: string;
  /** `-1` is allowed only as an expected, not-yet-persisted genesis cursor. */
  sequence: number;
  message_digest: string;
}

export type PlayerLocalEvidencePollJobState =
  | { kind: "scheduled" }
  | { kind: "in_flight"; lease_expires_at_ms: number }
  | { kind: "expired"; expired_at_ms: number }
  | {
      kind: "escalated";
      escalated_at_ms: number;
      reason_digest: string;
    };

/** Durable schedule for polling one authenticated evidence hash-chain. */
export interface PlayerLocalEvidencePollJob {
  boundary: AuditBoundary;
  source_id: string;
  endpoint: string;
  initial_message_digest: string;
  deadline_at_ms: number;
  next_poll_at_ms: number;
  /** Consecutive failed polls; reset to zero after a successful poll. */
  failures: number;
  /** Monotonic fencing token incremented by every successful claim. */
  attempt_count: number;
  state: PlayerLocalEvidencePollJobState;
}

export interface PlayerLocalEvidencePollJobDraft {
  boundary: AuditBoundary;
  source_id: string;
  endpoint: string;
  initial_message_digest: string;
  deadline_at_ms: number;
  next_poll_at_ms: number;
}

/** CAS completion for a claimed poll. The token prevents stale workers. */
export interface PlayerLocalEvidencePollJobCompletion {
  source_id: string;
  expected_attempt_count: number;
  expected_lease_expires_at_ms: number;
  completed_at_ms: number;
  next_poll_at_ms: number;
  failures: number;
}

export type PlayerLocalEvidenceInboxOperation =
  | { kind: "place"; hold: PlayerLocalEvidenceHold }
  | { kind: "resolve"; resolution: PlayerLocalEvidenceHoldResolution };

/** Authenticated storage-neutral CAS operation for hold plus cursor commit. */
export interface PlayerLocalEvidenceInboxWriteSet {
  expected_revision: number;
  expected_cursor: PlayerLocalEvidenceInboxCursor;
  next_cursor: PlayerLocalEvidenceInboxCursor;
  message_id: string;
  operation: PlayerLocalEvidenceInboxOperation;
}

export interface CheckpointSealStorageSnapshot {
  boundary: AuditBoundary;
  current_epoch: number;
  current_digest: string;
  incoming_epoch_known: boolean;
  known_digest_matches: boolean;
  known_seal_complete: boolean;
  closure_consumed: boolean;
  /** Pending plus in-flight entries; acknowledged history does not use capacity. */
  outbox_entry_count: number;
  outbox_capacity: number;
  next_created_order: number;
}

/**
 * Host representation of MoonBit's opaque `PlayerLocalSealPlan`. Construct it
 * from `PlayerLocalSealPlan::write_set`; physical adapters only recheck and
 * atomically apply this DTO. Unauthenticated network input is not a write set.
 */
export interface PlayerLocalSealWriteSet {
  expected_revision: number;
  expected_snapshot: CheckpointSealStorageSnapshot;
  checkpoint: CheckpointSealDraft;
  next_head: CheckpointSealHead;
  outbox_entries: PlayerLocalCheckpointOutboxRecord[];
  consumed_closure: EpochClosureEvidence;
  next_outbox_entry_count: number;
  next_created_order: number;
}

export interface PlayerLocalAuditImage {
  boundary: AuditBoundary;
  genesis_digest: string;
  outbox_capacity: number;
  events: PlayerLocalAuditEvent[];
  equivocations: PlayerLocalEventEquivocation[];
  checkpoints: CheckpointSealDraft[];
  head: CheckpointSealHead;
  retention_anchor: PlayerLocalRetentionAnchor;
  evidence_holds: PlayerLocalEvidenceHold[];
  evidence_inbox_cursors: PlayerLocalEvidenceInboxCursor[];
  evidence_poll_jobs: PlayerLocalEvidencePollJob[];
  consumed_closures: EpochClosureEvidence[];
  outbox: PlayerLocalCheckpointOutboxRecord[];
  ack_history: CheckpointAckEvidence[];
  next_created_order: number;
  storage_revision: number;
}

export interface PlayerLocalPruneRequest {
  /** First epoch that must remain queryable for the active appeal window. */
  retain_from_epoch: number;
  /** Authenticated unresolved challenge/appeal epochs. */
  protected_epochs: number[];
}

/** Storage-neutral CAS plan prepared through the MoonBit pruning predicate. */
export interface PlayerLocalPruneWriteSet extends PlayerLocalPruneRequest {
  expected_revision: number;
  expected_anchor: PlayerLocalRetentionAnchor;
  next_anchor: PlayerLocalRetentionAnchor;
}

export type PlayerLocalEventAdmission =
  | { decision: "stored" | "duplicate" | "equivocation" }
  | { decision: "refused"; reason: string };

export type PlayerLocalSealCommitResult =
  | { decision: "committed" | "concurrent_write" }
  | { decision: "refused"; reason: "invalid_write_set" };

export type PlayerLocalOutboxAckResult =
  | { decision: "updated" | "no_change" }
  | { decision: "refused"; reason: string };

export type PlayerLocalPruneResult =
  | { decision: "pruned"; pruned_through_epoch: number }
  | { decision: "no_change" | "concurrent_write" }
  | { decision: "refused"; reason: string };

export type PlayerLocalEvidenceHoldAdmission =
  | { decision: "stored" | "duplicate" }
  | { decision: "refused"; reason: string };

export type PlayerLocalEvidenceHoldResolutionResult =
  | { decision: "resolved" | "no_change" }
  | { decision: "refused"; reason: string };

export type PlayerLocalEvidenceInboxApplyResult =
  | { decision: "applied" | "concurrent_write" }
  | { decision: "refused"; reason: "invalid_write_set" };

export type PlayerLocalEvidencePollJobAdmission =
  | { decision: "stored" | "duplicate" }
  | { decision: "refused"; reason: string };

export type PlayerLocalEvidencePollJobClaimResult =
  | { decision: "claimed"; job: PlayerLocalEvidencePollJob }
  | { decision: "not_due" | "not_found" }
  | { decision: "terminal"; state: "expired" | "escalated" }
  | { decision: "refused"; reason: string };

export type PlayerLocalEvidencePollJobCompletionResult =
  | { decision: "updated" | "concurrent_write" }
  | { decision: "refused"; reason: string };

export type PlayerLocalEvidencePollJobEscalationResult =
  | { decision: "updated" | "no_change" | "not_found" }
  | { decision: "refused"; reason: string };

export type PlayerLocalEvidenceInboxFaultPoint =
  | "after_hold"
  | "after_cursor";

export type PlayerLocalSealFaultPoint =
  | "after_history"
  | "after_head"
  | "after_outbox"
  | "after_closure";

export type PlayerLocalPruneFaultPoint =
  | "after_events"
  | "after_checkpoints"
  | "after_outbox"
  | "after_anchor";

export type Awaitable<Value> = Value | Promise<Value>;

/** Common host contract implemented by Node/mobile SQLite and IndexedDB. */
export interface PlayerLocalAuditStorage {
  admitEvent(event: PlayerLocalAuditEvent): Awaitable<PlayerLocalEventAdmission>;
  commitSeal(
    writeSet: PlayerLocalSealWriteSet,
    faultPoint?: PlayerLocalSealFaultPoint,
  ): Awaitable<PlayerLocalSealCommitResult>;
  claimOutbox(
    createdOrder: number,
    nowMs: number,
    leaseDurationMs: number,
  ): Awaitable<PlayerLocalCheckpointOutboxRecord | undefined>;
  releaseOutbox(createdOrder: number): Awaitable<boolean>;
  acknowledgeOutbox(
    evidence: CheckpointAckEvidence,
  ): Awaitable<PlayerLocalOutboxAckResult>;
  placeEvidenceHold(
    hold: PlayerLocalEvidenceHold,
  ): Awaitable<PlayerLocalEvidenceHoldAdmission>;
  resolveEvidenceHold(
    resolution: PlayerLocalEvidenceHoldResolution,
  ): Awaitable<PlayerLocalEvidenceHoldResolutionResult>;
  applyEvidenceInbox(
    writeSet: PlayerLocalEvidenceInboxWriteSet,
    faultPoint?: PlayerLocalEvidenceInboxFaultPoint,
  ): Awaitable<PlayerLocalEvidenceInboxApplyResult>;
  scheduleEvidencePollJob(
    draft: PlayerLocalEvidencePollJobDraft,
  ): Awaitable<PlayerLocalEvidencePollJobAdmission>;
  claimEvidencePollJob(
    sourceId: string,
    nowMs: number,
    leaseDurationMs: number,
  ): Awaitable<PlayerLocalEvidencePollJobClaimResult>;
  completeEvidencePollJob(
    completion: PlayerLocalEvidencePollJobCompletion,
  ): Awaitable<PlayerLocalEvidencePollJobCompletionResult>;
  escalateEvidencePollJob(
    sourceId: string,
    nowMs: number,
    reasonDigest: string,
  ): Awaitable<PlayerLocalEvidencePollJobEscalationResult>;
  pruneEvidence(
    writeSet: PlayerLocalPruneWriteSet,
    faultPoint?: PlayerLocalPruneFaultPoint,
  ): Awaitable<PlayerLocalPruneResult>;
  image(): Awaitable<PlayerLocalAuditImage>;
  close(): Awaitable<void>;
}

export function isNonNegativeInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

export function playerLocalBoundaryValid(boundary: AuditBoundary): boolean {
  return Number.isSafeInteger(boundary.protocol_version) &&
    boundary.protocol_version > 0 &&
    boundary.purpose.length > 0 &&
    boundary.manifest_digest.length > 0 &&
    boundary.scope_id.length > 0 &&
    boundary.unit_id.length > 0;
}

export function samePlayerLocalBoundary(
  left: AuditBoundary,
  right: AuditBoundary,
): boolean {
  return left.protocol_version === right.protocol_version &&
    left.purpose === right.purpose &&
    left.manifest_digest === right.manifest_digest &&
    left.scope_id === right.scope_id &&
    left.unit_id === right.unit_id;
}

function playerLocalPollEndpointValid(value: string): boolean {
  if (value.length === 0 || value.length > 4_096) return false;
  try {
    const endpoint = new URL(value);
    return endpoint.protocol === "https:" || endpoint.protocol === "http:";
  } catch {
    return false;
  }
}

export function playerLocalEvidencePollJobDraftValid(
  boundary: AuditBoundary,
  draft: PlayerLocalEvidencePollJobDraft,
): boolean {
  return samePlayerLocalBoundary(boundary, draft.boundary) &&
    draft.source_id.length > 0 &&
    draft.source_id.length <= 256 &&
    playerLocalPollEndpointValid(draft.endpoint) &&
    draft.initial_message_digest.length > 0 &&
    draft.initial_message_digest.length <= 4_096 &&
    isNonNegativeInteger(draft.deadline_at_ms) &&
    isNonNegativeInteger(draft.next_poll_at_ms) &&
    draft.next_poll_at_ms <= draft.deadline_at_ms;
}

export function playerLocalEvidencePollJobValid(
  boundary: AuditBoundary,
  job: PlayerLocalEvidencePollJob,
): boolean {
  const stateValid = job.state.kind === "scheduled" ||
    (job.state.kind === "in_flight" &&
      job.attempt_count > 0 &&
      isNonNegativeInteger(job.state.lease_expires_at_ms) &&
      job.state.lease_expires_at_ms <= job.deadline_at_ms) ||
    (job.state.kind === "expired" &&
      isNonNegativeInteger(job.state.expired_at_ms) &&
      job.state.expired_at_ms >= job.deadline_at_ms) ||
    (job.state.kind === "escalated" &&
      isNonNegativeInteger(job.state.escalated_at_ms) &&
      job.state.reason_digest.length > 0 &&
      job.state.reason_digest.length <= 4_096);
  return playerLocalEvidencePollJobDraftValid(boundary, job) &&
    isNonNegativeInteger(job.failures) &&
    isNonNegativeInteger(job.attempt_count) &&
    stateValid;
}

export function samePlayerLocalEvidencePollJobDraft(
  job: PlayerLocalEvidencePollJob,
  draft: PlayerLocalEvidencePollJobDraft,
): boolean {
  return samePlayerLocalBoundary(job.boundary, draft.boundary) &&
    job.source_id === draft.source_id &&
    job.endpoint === draft.endpoint &&
    job.initial_message_digest === draft.initial_message_digest &&
    job.deadline_at_ms === draft.deadline_at_ms;
}

export function samePlayerLocalHead(
  left: CheckpointSealHead,
  right: CheckpointSealHead,
): boolean {
  return samePlayerLocalBoundary(left.boundary, right.boundary) &&
    left.epoch === right.epoch &&
    left.checkpoint_digest === right.checkpoint_digest;
}

export function samePlayerLocalRetentionAnchor(
  left: PlayerLocalRetentionAnchor,
  right: PlayerLocalRetentionAnchor,
): boolean {
  return samePlayerLocalBoundary(left.boundary, right.boundary) &&
    left.epoch === right.epoch &&
    left.checkpoint_digest === right.checkpoint_digest;
}

export function playerLocalEvidenceHoldValid(
  boundary: AuditBoundary,
  hold: PlayerLocalEvidenceHold,
): boolean {
  const stateValid = hold.state.kind === "active" ||
    (hold.state.kind === "resolved" &&
      (hold.state.decision === "upheld" ||
        hold.state.decision === "dismissed") &&
      hold.state.resolution_digest.length > 0);
  return samePlayerLocalBoundary(boundary, hold.boundary) &&
    hold.hold_id.length > 0 &&
    isNonNegativeInteger(hold.epoch) &&
    hold.checkpoint_digest.length > 0 &&
    (hold.kind === "fork" || hold.kind === "challenge" ||
      hold.kind === "appeal") &&
    hold.reference_digest.length > 0 &&
    stateValid;
}

export function samePlayerLocalEvidenceInboxCursor(
  left: PlayerLocalEvidenceInboxCursor,
  right: PlayerLocalEvidenceInboxCursor,
): boolean {
  return samePlayerLocalBoundary(left.boundary, right.boundary) &&
    left.source_id === right.source_id &&
    left.sequence === right.sequence &&
    left.message_digest === right.message_digest;
}

function playerLocalEvidenceHoldResolutionValid(
  boundary: AuditBoundary,
  resolution: PlayerLocalEvidenceHoldResolution,
): boolean {
  return samePlayerLocalBoundary(boundary, resolution.boundary) &&
    resolution.hold_id.length > 0 &&
    isNonNegativeInteger(resolution.epoch) &&
    resolution.checkpoint_digest.length > 0 &&
    resolution.reference_digest.length > 0 &&
    (resolution.decision === "upheld" ||
      resolution.decision === "dismissed") &&
    resolution.resolution_digest.length > 0;
}

export function playerLocalEvidenceInboxWriteSetValid(
  image: PlayerLocalAuditImage,
  writeSet: PlayerLocalEvidenceInboxWriteSet,
): boolean {
  const expected = writeSet.expected_cursor;
  const next = writeSet.next_cursor;
  if (
    !isNonNegativeInteger(writeSet.expected_revision) ||
    writeSet.expected_revision !== image.storage_revision ||
    !samePlayerLocalBoundary(image.boundary, expected.boundary) ||
    !samePlayerLocalBoundary(image.boundary, next.boundary) ||
    expected.source_id.length === 0 ||
    expected.source_id.length > 256 ||
    expected.source_id !== next.source_id ||
    !Number.isSafeInteger(expected.sequence) ||
    expected.sequence < -1 ||
    !isNonNegativeInteger(next.sequence) ||
    next.sequence !== expected.sequence + 1 ||
    expected.message_digest.length === 0 ||
    expected.message_digest.length > 4_096 ||
    next.message_digest.length === 0 ||
    next.message_digest.length > 4_096 ||
    next.message_digest === expected.message_digest ||
    writeSet.message_id.length === 0
  ) return false;
  const current = image.evidence_inbox_cursors.find((cursor) =>
    cursor.source_id === expected.source_id
  );
  if (current) {
    if (!samePlayerLocalEvidenceInboxCursor(current, expected)) return false;
  } else if (expected.sequence !== -1) return false;

  if (writeSet.operation.kind === "place") {
    const hold = writeSet.operation.hold;
    if (
      writeSet.message_id !== hold.hold_id ||
      !playerLocalEvidenceHoldValid(image.boundary, hold) ||
      hold.state.kind !== "active"
    ) return false;
    const checkpoint = image.checkpoints.find((value) =>
      value.epoch === hold.epoch
    );
    if (!checkpoint || checkpoint.checkpoint_digest !== hold.checkpoint_digest) {
      return false;
    }
    const existing = image.evidence_holds.find((value) =>
      value.hold_id === hold.hold_id
    );
    return !existing ||
      (existing.epoch === hold.epoch &&
        existing.checkpoint_digest === hold.checkpoint_digest &&
        existing.kind === hold.kind &&
        existing.reference_digest === hold.reference_digest &&
        existing.state.kind === "active");
  }

  const resolution = writeSet.operation.resolution;
  if (
    writeSet.message_id !== resolution.hold_id ||
    !playerLocalEvidenceHoldResolutionValid(image.boundary, resolution)
  ) return false;
  const existing = image.evidence_holds.find((value) =>
    value.hold_id === resolution.hold_id
  );
  if (
    !existing ||
    existing.epoch !== resolution.epoch ||
    existing.checkpoint_digest !== resolution.checkpoint_digest ||
    existing.reference_digest !== resolution.reference_digest
  ) return false;
  return existing.state.kind === "active" ||
    (existing.state.decision === resolution.decision &&
      existing.state.resolution_digest === resolution.resolution_digest);
}

export function samePlayerLocalSnapshot(
  left: CheckpointSealStorageSnapshot,
  right: CheckpointSealStorageSnapshot,
): boolean {
  return samePlayerLocalBoundary(left.boundary, right.boundary) &&
    left.current_epoch === right.current_epoch &&
    left.current_digest === right.current_digest &&
    left.incoming_epoch_known === right.incoming_epoch_known &&
    left.known_digest_matches === right.known_digest_matches &&
    left.known_seal_complete === right.known_seal_complete &&
    left.closure_consumed === right.closure_consumed &&
    left.outbox_entry_count === right.outbox_entry_count &&
    left.outbox_capacity === right.outbox_capacity &&
    left.next_created_order === right.next_created_order;
}

export function playerLocalEventValid(
  boundary: AuditBoundary,
  event: PlayerLocalAuditEvent,
): boolean {
  return samePlayerLocalBoundary(boundary, event.boundary) &&
    event.author_id.length > 0 &&
    isNonNegativeInteger(event.counter) &&
    isNonNegativeInteger(event.epoch) &&
    event.event_digest.length > 0 &&
    event.canonical_event.length > 0;
}

export function playerLocalCheckpointValid(
  boundary: AuditBoundary,
  checkpoint: CheckpointSealDraft,
): boolean {
  return samePlayerLocalBoundary(boundary, checkpoint.boundary) &&
    isNonNegativeInteger(checkpoint.epoch) &&
    checkpoint.previous_checkpoint.length > 0 &&
    checkpoint.checkpoint_digest.length > 0 &&
    checkpoint.canonical_envelope.length > 0;
}

export function playerLocalClosureValid(
  boundary: AuditBoundary,
  closure: EpochClosureEvidence,
): boolean {
  return samePlayerLocalBoundary(boundary, closure.boundary) &&
    isNonNegativeInteger(closure.epoch) &&
    closure.roster_digest.length > 0 &&
    closure.frontier_digest.length > 0 &&
    closure.certificate_digest.length > 0;
}

export function playerLocalSealWriteSetValid(
  configuration: PlayerLocalStoreConfiguration,
  writeSet: PlayerLocalSealWriteSet,
): boolean {
  const boundary = configuration.boundary;
  const checkpoint = writeSet.checkpoint;
  const snapshot = writeSet.expected_snapshot;
  if (
    !isNonNegativeInteger(writeSet.expected_revision) ||
    !playerLocalCheckpointValid(boundary, checkpoint) ||
    !playerLocalClosureValid(boundary, writeSet.consumed_closure) ||
    checkpoint.epoch !== snapshot.current_epoch + 1 ||
    checkpoint.previous_checkpoint !== snapshot.current_digest ||
    writeSet.consumed_closure.epoch !== checkpoint.epoch ||
    !samePlayerLocalHead(writeSet.next_head, {
      boundary,
      epoch: checkpoint.epoch,
      checkpoint_digest: checkpoint.checkpoint_digest,
    }) ||
    writeSet.outbox_entries.length === 0 ||
    writeSet.next_outbox_entry_count !==
      snapshot.outbox_entry_count + writeSet.outbox_entries.length ||
    writeSet.next_outbox_entry_count > configuration.outbox_capacity ||
    writeSet.next_created_order !==
      snapshot.next_created_order + writeSet.outbox_entries.length ||
    !Number.isSafeInteger(writeSet.next_created_order)
  ) return false;
  const destinations = new Set<string>();
  for (const [index, entry] of writeSet.outbox_entries.entries()) {
    if (
      !samePlayerLocalBoundary(boundary, entry.boundary) ||
      entry.destination_id.length === 0 ||
      destinations.has(entry.destination_id) ||
      entry.epoch !== checkpoint.epoch ||
      entry.checkpoint_digest !== checkpoint.checkpoint_digest ||
      entry.canonical_envelope !== checkpoint.canonical_envelope ||
      entry.created_order !== snapshot.next_created_order + index ||
      entry.state.kind !== "pending"
    ) return false;
    destinations.add(entry.destination_id);
  }
  return true;
}

export function playerLocalSealSnapshot(
  image: PlayerLocalAuditImage,
  checkpoint: CheckpointSealDraft,
  destinations: string[],
): CheckpointSealStorageSnapshot {
  const known = image.checkpoints.find((value) =>
    value.epoch === checkpoint.epoch
  );
  const closureConsumed = image.consumed_closures.some((value) =>
    value.epoch === checkpoint.epoch
  );
  const allOutboxPresent = destinations.length > 0 && destinations.every(
    (destination) => image.outbox.some((entry) =>
      entry.destination_id === destination &&
      entry.epoch === checkpoint.epoch &&
      entry.checkpoint_digest === checkpoint.checkpoint_digest &&
      entry.canonical_envelope === checkpoint.canonical_envelope
    ),
  );
  const knownDigestMatches = known?.checkpoint_digest ===
      checkpoint.checkpoint_digest &&
    known.canonical_envelope === checkpoint.canonical_envelope;
  return {
    boundary: image.boundary,
    current_epoch: image.head.epoch,
    current_digest: image.head.checkpoint_digest,
    incoming_epoch_known: known !== undefined,
    known_digest_matches: knownDigestMatches,
    known_seal_complete: knownDigestMatches && closureConsumed && allOutboxPresent,
    closure_consumed: closureConsumed,
    outbox_entry_count: image.outbox.filter(
      (entry) => entry.state.kind !== "acknowledged",
    ).length,
    outbox_capacity: image.outbox_capacity,
    next_created_order: image.next_created_order,
  };
}

export function playerLocalPruneWriteSetValid(
  image: PlayerLocalAuditImage,
  writeSet: PlayerLocalPruneWriteSet,
): boolean {
  if (
    !isNonNegativeInteger(writeSet.expected_revision) ||
    writeSet.expected_revision !== image.storage_revision ||
    !samePlayerLocalRetentionAnchor(
      writeSet.expected_anchor,
      image.retention_anchor,
    ) ||
    !samePlayerLocalBoundary(image.boundary, writeSet.next_anchor.boundary) ||
    !isNonNegativeInteger(writeSet.retain_from_epoch) ||
    writeSet.retain_from_epoch > image.head.epoch + 1 ||
    writeSet.next_anchor.epoch <= writeSet.expected_anchor.epoch ||
    writeSet.next_anchor.epoch >= writeSet.retain_from_epoch ||
    writeSet.next_anchor.epoch > image.head.epoch
  ) return false;

  const protectedEpochs = new Set<number>();
  for (const epoch of writeSet.protected_epochs) {
    if (
      !isNonNegativeInteger(epoch) ||
      protectedEpochs.has(epoch) ||
      epoch <= image.retention_anchor.epoch
    ) return false;
    protectedEpochs.add(epoch);
  }
  for (const hold of image.evidence_holds) {
    if (hold.state.kind === "active") protectedEpochs.add(hold.epoch);
  }
  const equivocationEpochs = new Set(
    image.equivocations.flatMap((evidence) => [
      evidence.accepted.epoch,
      evidence.conflicting.epoch,
    ]),
  );
  let expectedEpoch = image.retention_anchor.epoch + 1;
  let expectedParent = image.retention_anchor.checkpoint_digest;
  for (const checkpoint of image.checkpoints) {
    if (checkpoint.epoch > writeSet.next_anchor.epoch) break;
    const epochOutbox = image.outbox.filter((entry) =>
      entry.epoch === checkpoint.epoch &&
      entry.checkpoint_digest === checkpoint.checkpoint_digest
    );
    if (
      checkpoint.epoch !== expectedEpoch ||
      checkpoint.previous_checkpoint !== expectedParent ||
      checkpoint.epoch >= writeSet.retain_from_epoch ||
      protectedEpochs.has(checkpoint.epoch) ||
      equivocationEpochs.has(checkpoint.epoch) ||
      epochOutbox.length === 0 ||
      epochOutbox.some((entry) => entry.state.kind !== "acknowledged")
    ) return false;
    expectedEpoch += 1;
    expectedParent = checkpoint.checkpoint_digest;
  }
  return expectedEpoch === writeSet.next_anchor.epoch + 1 &&
    expectedParent === writeSet.next_anchor.checkpoint_digest;
}

export function playerLocalAuditImageError(
  image: PlayerLocalAuditImage,
): string | undefined {
  if (
    !playerLocalBoundaryValid(image.boundary) ||
    image.genesis_digest.length === 0 ||
    !isNonNegativeInteger(image.outbox_capacity) ||
    !isNonNegativeInteger(image.storage_revision) ||
    !isNonNegativeInteger(image.next_created_order) ||
    image.outbox.filter((entry) => entry.state.kind !== "acknowledged").length >
      image.outbox_capacity
  ) return "invalid configuration";

  if (
    !samePlayerLocalBoundary(image.boundary, image.retention_anchor.boundary) ||
    !Number.isSafeInteger(image.retention_anchor.epoch) ||
    image.retention_anchor.epoch < -1 ||
    image.retention_anchor.epoch > image.head.epoch ||
    image.retention_anchor.checkpoint_digest.length === 0 ||
    (image.retention_anchor.epoch === -1 &&
      image.retention_anchor.checkpoint_digest !== image.genesis_digest)
  ) return "invalid retention anchor";

  const eventKeys = new Set<string>();
  for (const event of image.events) {
    const key = `${event.author_id}\u0000${event.counter}`;
    if (
      !playerLocalEventValid(image.boundary, event) ||
      event.epoch <= image.retention_anchor.epoch ||
      eventKeys.has(key)
    ) {
      return "invalid event relation";
    }
    eventKeys.add(key);
  }
  const conflictKeys = new Set<string>();
  for (const evidence of image.equivocations) {
    const key = `${evidence.accepted.author_id}\u0000${evidence.accepted.counter}`;
    const conflictKey = `${key}\u0000${evidence.conflicting.event_digest}`;
    if (
      !eventKeys.has(key) ||
      !playerLocalEventValid(image.boundary, evidence.conflicting) ||
      evidence.conflicting.epoch <= image.retention_anchor.epoch ||
      evidence.accepted.author_id !== evidence.conflicting.author_id ||
      evidence.accepted.counter !== evidence.conflicting.counter ||
      evidence.accepted.event_digest === evidence.conflicting.event_digest ||
      conflictKeys.has(conflictKey)
    ) return "invalid equivocation relation";
    conflictKeys.add(conflictKey);
  }

  let expectedParent = image.retention_anchor.checkpoint_digest;
  let expectedEpoch = image.retention_anchor.epoch + 1;
  for (const [index, checkpoint] of image.checkpoints.entries()) {
    if (
      !playerLocalCheckpointValid(image.boundary, checkpoint) ||
      checkpoint.epoch !== expectedEpoch ||
      checkpoint.previous_checkpoint !== expectedParent ||
      image.consumed_closures[index]?.epoch !== expectedEpoch ||
      !playerLocalClosureValid(image.boundary, image.consumed_closures[index])
    ) return "invalid checkpoint chain";
    expectedParent = checkpoint.checkpoint_digest;
    expectedEpoch += 1;
  }
  if (image.consumed_closures.length !== image.checkpoints.length) {
    return "orphan closure footprint";
  }
  const expectedHead: CheckpointSealHead = image.checkpoints.length > 0
    ? {
        boundary: image.boundary,
        epoch: expectedEpoch - 1,
        checkpoint_digest: expectedParent,
      }
    : image.retention_anchor;
  if (!samePlayerLocalHead(image.head, expectedHead)) return "orphan local head";

  const checkpointByEpoch = new Map(
    image.checkpoints.map((checkpoint) => [checkpoint.epoch, checkpoint]),
  );
  const holdIds = new Set<string>();
  for (const hold of image.evidence_holds) {
    const checkpoint = checkpointByEpoch.get(hold.epoch);
    if (
      !playerLocalEvidenceHoldValid(image.boundary, hold) ||
      !checkpoint ||
      checkpoint.checkpoint_digest !== hold.checkpoint_digest ||
      holdIds.has(hold.hold_id)
    ) return "invalid evidence hold relation";
    holdIds.add(hold.hold_id);
  }
  const inboxSources = new Set<string>();
  for (const cursor of image.evidence_inbox_cursors) {
    if (
      !samePlayerLocalBoundary(image.boundary, cursor.boundary) ||
      cursor.source_id.length === 0 ||
      cursor.source_id.length > 256 ||
      !isNonNegativeInteger(cursor.sequence) ||
      cursor.message_digest.length === 0 ||
      cursor.message_digest.length > 4_096 ||
      inboxSources.has(cursor.source_id)
    ) return "invalid evidence inbox cursor relation";
    inboxSources.add(cursor.source_id);
  }
  const pollSources = new Set<string>();
  for (const job of image.evidence_poll_jobs) {
    if (
      !playerLocalEvidencePollJobValid(image.boundary, job) ||
      pollSources.has(job.source_id)
    ) return "invalid evidence poll job relation";
    pollSources.add(job.source_id);
  }
  const outboxOrders = new Set<number>();
  const epochsWithOutbox = new Set<number>();
  let maxCreatedOrder = -1;
  for (const entry of image.outbox) {
    const checkpoint = checkpointByEpoch.get(entry.epoch);
    const validState = entry.state.kind === "pending" ||
      entry.state.kind === "acknowledged" ||
      (entry.state.kind === "in_flight" &&
        isNonNegativeInteger(entry.state.lease_expires_at_ms));
    if (
      !checkpoint ||
      !samePlayerLocalBoundary(image.boundary, entry.boundary) ||
      entry.destination_id.length === 0 ||
      entry.checkpoint_digest !== checkpoint.checkpoint_digest ||
      entry.canonical_envelope !== checkpoint.canonical_envelope ||
      !isNonNegativeInteger(entry.created_order) ||
      outboxOrders.has(entry.created_order) ||
      !validState
    ) return "invalid outbox relation";
    epochsWithOutbox.add(entry.epoch);
    outboxOrders.add(entry.created_order);
    maxCreatedOrder = Math.max(maxCreatedOrder, entry.created_order);
  }
  if (
    image.checkpoints.some((checkpoint) => !epochsWithOutbox.has(checkpoint.epoch)) ||
    image.next_created_order <= maxCreatedOrder
  ) return "incomplete outbox footprint";

  const outboxAckKey = (
    authorityId: string,
    epoch: number,
    checkpointDigest: string,
  ) => `${authorityId}\u0000${epoch}\u0000${checkpointDigest}`;
  const acknowledgedKeys = new Set(
    image.outbox
      .filter((entry) => entry.state.kind === "acknowledged")
      .map((entry) =>
        outboxAckKey(
          entry.destination_id,
          entry.epoch,
          entry.checkpoint_digest,
        )
      ),
  );
  const ackKeys = new Set<string>();
  for (const evidence of image.ack_history) {
    const key = outboxAckKey(
      evidence.authority_id,
      evidence.epoch,
      evidence.checkpoint_digest,
    );
    if (
      !samePlayerLocalBoundary(image.boundary, evidence.boundary) ||
      evidence.authority_id.length === 0 ||
      !isNonNegativeInteger(evidence.epoch) ||
      evidence.checkpoint_digest.length === 0 ||
      (evidence.decision !== "accepted" && evidence.decision !== "duplicate") ||
      !acknowledgedKeys.has(key) ||
      ackKeys.has(key)
    ) {
      return "invalid ACK history";
    }
    ackKeys.add(key);
  }
  for (const key of acknowledgedKeys) {
    if (!ackKeys.has(key)) return "ACK footprint missing";
  }
  return undefined;
}
