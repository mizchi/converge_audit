///|
/// Canonical authenticated event row owned by the player-local persistence
/// boundary. Signature verification happens before this value is admitted.
pub(all) struct PlayerLocalAuditEvent {
  boundary : AuditBoundary
  author_id : String
  counter : Int
  epoch : Int
  event_digest : @commitment.AuditDigest
  canonical_event : String
} derive(Eq, Debug)

///|
/// Absorbing evidence for two authenticated digests using one author counter.
pub(all) struct PlayerLocalEventEquivocation {
  accepted : PlayerLocalAuditEvent
  conflicting : PlayerLocalAuditEvent
} derive(Eq, Debug)

///|
/// Public logical row used by SQLite/IndexedDB adapters. Restore validates the
/// row before recreating the opaque runtime entry.
pub(all) struct PlayerLocalCheckpointOutboxRecord {
  boundary : AuditBoundary
  destination_id : String
  epoch : Int
  checkpoint_digest : @commitment.AuditDigest
  canonical_envelope : String
  created_order : Int
  state : CheckpointOutboxState
} derive(Eq, Debug)

///|
/// Durable checkpoint-chain boundary after detailed prefix evidence is pruned.
pub(all) struct PlayerLocalRetentionAnchor {
  boundary : AuditBoundary
  epoch : Int
  checkpoint_digest : @commitment.AuditDigest
} derive(Eq, Debug)

///|
pub(all) enum PlayerLocalEvidenceHoldKind {
  EvidenceHoldFork
  EvidenceHoldChallenge
  EvidenceHoldAppeal
} derive(Eq, Debug)

///|
pub(all) enum PlayerLocalEvidenceHoldResolutionDecision {
  EvidenceHoldUpheld
  EvidenceHoldDismissed
} derive(Eq, Debug)

///|
pub(all) enum PlayerLocalEvidenceHoldState {
  EvidenceHoldActive
  EvidenceHoldResolved(
    PlayerLocalEvidenceHoldResolutionDecision,
    @commitment.AuditDigest
  )
} derive(Eq, Debug)

///|
/// Durable authenticated reference that prevents evidence prefix pruning.
pub(all) struct PlayerLocalEvidenceHold {
  boundary : AuditBoundary
  hold_id : String
  epoch : Int
  checkpoint_digest : @commitment.AuditDigest
  kind : PlayerLocalEvidenceHoldKind
  reference_digest : @commitment.AuditDigest
  state : PlayerLocalEvidenceHoldState
} derive(Eq, Debug)

///|
/// Last atomically applied message from one authenticated evidence source.
pub(all) struct PlayerLocalEvidenceInboxCursor {
  boundary : AuditBoundary
  source_id : String
  sequence : Int
  message_digest : @commitment.AuditDigest
} derive(Eq, Debug)

///|
pub(all) enum PlayerLocalEvidencePollJobState {
  EvidencePollScheduled
  EvidencePollInFlight(Int)
  EvidencePollExpired(Int)
  EvidencePollEscalated(Int, @commitment.AuditDigest)
} derive(Eq, Debug)

///|
/// Logical durable scheduler row. `attempt_count` is the fencing token used
/// by physical adapters when completing a claimed HTTP poll.
pub(all) struct PlayerLocalEvidencePollJob {
  boundary : AuditBoundary
  source_id : String
  endpoint : String
  initial_message_digest : @commitment.AuditDigest
  deadline_at_ms : Int
  next_poll_at_ms : Int
  failures : Int
  attempt_count : Int
  state : PlayerLocalEvidencePollJobState
} derive(Eq, Debug)

///|
pub(all) enum PlayerLocalEventRefusal {
  LocalEventInvalidBoundary
  LocalEventBoundaryMismatch
  LocalEventMissingAuthor
  LocalEventNegativeCounter
  LocalEventNegativeEpoch
  LocalEventMissingDigest
  LocalEventMissingCanonicalBytes
  LocalEventDigestCollision
  LocalEventPrunedEpoch
} derive(Eq, Debug)

///|
pub(all) enum PlayerLocalEventAdmission {
  LocalEventStored
  LocalEventDuplicate
  LocalEventEquivocation
  LocalEventRefused(PlayerLocalEventRefusal)
} derive(Eq, Debug)

///|
pub(all) enum PlayerLocalAuditStoreRefusal {
  LocalStoreInvalidBoundary
  LocalStoreMissingGenesis
  LocalStoreInvalidOutboxCapacity
  LocalStoreInvalidImage
} derive(Eq, Debug)

///|
/// Complete logical DB image. Concrete SQLite/IndexedDB adapters may use a
/// different physical schema, but restart must reconstruct an equivalent
/// value and pass `restore_player_local_audit_store`.
pub(all) struct PlayerLocalAuditImage {
  boundary : AuditBoundary
  genesis_digest : @commitment.AuditDigest
  outbox_capacity : Int
  events : Array[PlayerLocalAuditEvent]
  equivocations : Array[PlayerLocalEventEquivocation]
  checkpoints : Array[CheckpointSealDraft]
  head : CheckpointSealHead
  retention_anchor : PlayerLocalRetentionAnchor
  evidence_holds : Array[PlayerLocalEvidenceHold]
  evidence_inbox_cursors : Array[PlayerLocalEvidenceInboxCursor]
  evidence_poll_jobs : Array[PlayerLocalEvidencePollJob]
  consumed_closure_epochs : Array[Int]
  outbox : Array[PlayerLocalCheckpointOutboxRecord]
  ack_history : Array[CheckpointAckEvidence]
  next_created_order : Int
  storage_revision : Int
} derive(Eq, Debug)

///|
/// Reference transactional state for a single player/scope. The mutable value
/// models one DB transaction domain; `durable_image` is the restart boundary.
pub struct PlayerLocalAuditStore {
  boundary_value : AuditBoundary
  genesis_digest_value : @commitment.AuditDigest
  outbox_capacity_value : Int
  events_value : Array[PlayerLocalAuditEvent]
  equivocations_value : Array[PlayerLocalEventEquivocation]
  checkpoints_value : Array[CheckpointSealDraft]
  mut head_value : CheckpointSealHead
  retention_anchor_value : PlayerLocalRetentionAnchor
  evidence_holds_value : Array[PlayerLocalEvidenceHold]
  evidence_inbox_cursors_value : Array[PlayerLocalEvidenceInboxCursor]
  evidence_poll_jobs_value : Array[PlayerLocalEvidencePollJob]
  consumed_closure_epochs_value : Array[Int]
  outbox_value : Array[CheckpointOutboxEntry]
  ack_history_value : Array[CheckpointAckEvidence]
  mut next_created_order_value : Int
  mut storage_revision_value : Int
}

///|
pub(all) enum PlayerLocalAuditStoreOpenResult {
  PlayerLocalAuditStoreReady(PlayerLocalAuditStore)
  PlayerLocalAuditStoreRefused(PlayerLocalAuditStoreRefusal)
}

///|
/// Local CAS wrapper around the generic opaque seal write set.
pub struct PlayerLocalSealPlan {
  runtime_plan : AtomicCheckpointSealPlan
  expected_revision : Int
  required_destinations : Array[String]
  consumed_closure : EpochClosureEvidence
} derive(Eq, Debug)

///|
/// Storage-neutral DTO for concrete SQLite/IndexedDB adapters. It is derived
/// from the opaque validated plan; adapters must still compare-and-swap the
/// expected revision/snapshot and apply every field in one transaction.
pub(all) struct PlayerLocalSealWriteSet {
  expected_revision : Int
  expected_snapshot : CheckpointSealStorageSnapshot
  checkpoint : CheckpointSealDraft
  next_head : CheckpointSealHead
  outbox_entries : Array[PlayerLocalCheckpointOutboxRecord]
  consumed_closure : EpochClosureEvidence
  next_outbox_entry_count : Int
  next_created_order : Int
} derive(Eq, Debug)

///|
pub(all) enum PlayerLocalSealPrepareResult {
  PlayerLocalSealPrepared(PlayerLocalSealPlan)
  PlayerLocalSealAlreadyCommitted
  PlayerLocalSealConflict(CheckpointSealConflictReason)
  PlayerLocalSealRefused(CheckpointSealRefusal)
} derive(Eq, Debug)

///|
pub(all) enum PlayerLocalSealCommitResult {
  PlayerLocalSealCommitted
  PlayerLocalSealConcurrentWrite
} derive(Eq, Debug)

///|
pub(all) enum PlayerLocalOutboxUpdateResult {
  PlayerLocalOutboxUpdated(CheckpointOutboxEntry)
  PlayerLocalOutboxNoChange
  PlayerLocalOutboxRefused
} derive(Eq, Debug)

///|
fn local_event_key(author_id : String, counter : Int) -> String {
  author_id.length().to_string() + ":" + author_id + ":" + counter.to_string()
}

///|
fn player_local_event_refusal(
  expected_boundary : AuditBoundary,
  event : PlayerLocalAuditEvent,
) -> PlayerLocalEventRefusal? {
  if !boundary_valid(event.boundary) {
    Some(LocalEventInvalidBoundary)
  } else if event.boundary != expected_boundary {
    Some(LocalEventBoundaryMismatch)
  } else if event.author_id == "" {
    Some(LocalEventMissingAuthor)
  } else if event.counter < 0 {
    Some(LocalEventNegativeCounter)
  } else if event.epoch < 0 {
    Some(LocalEventNegativeEpoch)
  } else if event.event_digest.0 == "" {
    Some(LocalEventMissingDigest)
  } else if event.canonical_event == "" {
    Some(LocalEventMissingCanonicalBytes)
  } else {
    None
  }
}

///|
pub fn open_player_local_audit_store(
  boundary~ : AuditBoundary,
  genesis_digest~ : @commitment.AuditDigest,
  outbox_capacity~ : Int,
) -> PlayerLocalAuditStoreOpenResult {
  if !boundary_valid(boundary) {
    return PlayerLocalAuditStoreRefused(LocalStoreInvalidBoundary)
  }
  if genesis_digest.0 == "" {
    return PlayerLocalAuditStoreRefused(LocalStoreMissingGenesis)
  }
  if outbox_capacity < 0 {
    return PlayerLocalAuditStoreRefused(LocalStoreInvalidOutboxCapacity)
  }
  PlayerLocalAuditStoreReady(PlayerLocalAuditStore::{
    boundary_value: boundary,
    genesis_digest_value: genesis_digest,
    outbox_capacity_value: outbox_capacity,
    events_value: [],
    equivocations_value: [],
    checkpoints_value: [],
    head_value: { boundary, epoch: -1, checkpoint_digest: genesis_digest },
    retention_anchor_value: {
      boundary,
      epoch: -1,
      checkpoint_digest: genesis_digest,
    },
    evidence_holds_value: [],
    evidence_inbox_cursors_value: [],
    evidence_poll_jobs_value: [],
    consumed_closure_epochs_value: [],
    outbox_value: [],
    ack_history_value: [],
    next_created_order_value: 0,
    storage_revision_value: 0,
  })
}

///|
pub fn PlayerLocalAuditStore::admit_event(
  self : PlayerLocalAuditStore,
  event : PlayerLocalAuditEvent,
) -> PlayerLocalEventAdmission {
  match player_local_event_refusal(self.boundary_value, event) {
    Some(reason) => return LocalEventRefused(reason)
    None => ()
  }
  if event.epoch <= self.retention_anchor_value.epoch {
    return LocalEventRefused(LocalEventPrunedEpoch)
  }
  let key = local_event_key(event.author_id, event.counter)
  for accepted in self.events_value {
    if local_event_key(accepted.author_id, accepted.counter) == key {
      if accepted.event_digest == event.event_digest {
        if accepted == event {
          return LocalEventDuplicate
        }
        return LocalEventRefused(LocalEventDigestCollision)
      }
      for evidence in self.equivocations_value {
        if evidence.accepted == accepted &&
          evidence.conflicting.event_digest == event.event_digest {
          if evidence.conflicting == event {
            return LocalEventEquivocation
          }
          return LocalEventRefused(LocalEventDigestCollision)
        }
      }
      self.equivocations_value.push({ accepted, conflicting: event })
      self.storage_revision_value += 1
      return LocalEventEquivocation
    }
  }
  self.events_value.push(event)
  self.storage_revision_value += 1
  LocalEventStored
}

///|
fn int_array_contains(values : Array[Int], expected : Int) -> Bool {
  for value in values {
    if value == expected {
      return true
    }
  }
  false
}

///|
fn checkpoint_for_epoch(
  checkpoints : Array[CheckpointSealDraft],
  epoch : Int,
) -> CheckpointSealDraft? {
  for checkpoint in checkpoints {
    if checkpoint.epoch == epoch {
      return Some(checkpoint)
    }
  }
  None
}

///|
fn local_outbox_has(
  outbox : Array[CheckpointOutboxEntry],
  draft : CheckpointSealDraft,
  destination_id : String,
) -> Bool {
  for entry in outbox {
    if entry.boundary() == draft.boundary &&
      entry.destination_id() == destination_id &&
      entry.epoch() == draft.epoch &&
      entry.checkpoint_digest() == draft.checkpoint_digest &&
      entry.canonical_envelope() == draft.canonical_envelope {
      return true
    }
  }
  false
}

///|
fn local_outbox_record(
  entry : CheckpointOutboxEntry,
) -> PlayerLocalCheckpointOutboxRecord {
  {
    boundary: entry.boundary(),
    destination_id: entry.destination_id(),
    epoch: entry.epoch(),
    checkpoint_digest: entry.checkpoint_digest(),
    canonical_envelope: entry.canonical_envelope(),
    created_order: entry.created_order(),
    state: entry.state(),
  }
}

///|
/// Export the exact physical write set only after the pure seal classifier has
/// accepted the transition. This keeps host adapters independent of opaque
/// MoonBit implementation fields without letting them construct a plan.
pub fn PlayerLocalSealPlan::write_set(
  self : PlayerLocalSealPlan,
) -> PlayerLocalSealWriteSet {
  let runtime_plan = self.runtime_plan
  {
    expected_revision: self.expected_revision,
    expected_snapshot: runtime_plan.expected_snapshot(),
    checkpoint: runtime_plan.checkpoint(),
    next_head: runtime_plan.next_head(),
    outbox_entries: runtime_plan
    .outbox_entries()
    .map(fn(entry) { local_outbox_record(entry) }),
    consumed_closure: self.consumed_closure,
    next_outbox_entry_count: runtime_plan.next_outbox_entry_count(),
    next_created_order: runtime_plan.next_created_order(),
  }
}

///|
fn local_outbox_record_valid(
  record : PlayerLocalCheckpointOutboxRecord,
) -> Bool {
  boundary_valid(record.boundary) &&
  record.destination_id != "" &&
  record.epoch >= 0 &&
  record.checkpoint_digest.0 != "" &&
  record.canonical_envelope != "" &&
  record.created_order >= 0 &&
  (match record.state {
    OutboxInFlight(lease_expires_at_ms) => lease_expires_at_ms >= 0
    OutboxPending | OutboxAcknowledgedState => true
  })
}

///|
fn restore_local_outbox_entry(
  record : PlayerLocalCheckpointOutboxRecord,
) -> CheckpointOutboxEntry? {
  if !local_outbox_record_valid(record) {
    return None
  }
  Some(CheckpointOutboxEntry::{
    boundary_value: record.boundary,
    destination_id_value: record.destination_id,
    epoch_value: record.epoch,
    checkpoint_digest_value: record.checkpoint_digest,
    canonical_envelope_value: record.canonical_envelope,
    created_order_value: record.created_order,
    state_value: record.state,
  })
}

///|
/// Delivery capacity is bounded independently from retained ACK history.
fn active_local_outbox_count(entries : Array[CheckpointOutboxEntry]) -> Int {
  let mut count = 0
  for entry in entries {
    if entry.state() != OutboxAcknowledgedState {
      count += 1
    }
  }
  count
}

///|
fn active_local_outbox_record_count(
  entries : Array[PlayerLocalCheckpointOutboxRecord],
) -> Int {
  let mut count = 0
  for entry in entries {
    if entry.state != OutboxAcknowledgedState {
      count += 1
    }
  }
  count
}

///|
pub fn PlayerLocalAuditStore::seal_snapshot(
  self : PlayerLocalAuditStore,
  draft : CheckpointSealDraft,
  required_destinations : Array[String],
) -> CheckpointSealStorageSnapshot {
  let known = checkpoint_for_epoch(self.checkpoints_value, draft.epoch)
  let incoming_epoch_known = known is Some(_)
  let known_digest_matches = match known {
    Some(checkpoint) => checkpoint.checkpoint_digest == draft.checkpoint_digest
    None => false
  }
  let closure_consumed = int_array_contains(
    self.consumed_closure_epochs_value,
    draft.epoch,
  )
  let mut all_outbox_present = required_destinations.length() > 0
  for destination in required_destinations {
    if !local_outbox_has(self.outbox_value, draft, destination) {
      all_outbox_present = false
    }
  }
  {
    boundary: self.boundary_value,
    current_epoch: self.head_value.epoch,
    current_digest: self.head_value.checkpoint_digest,
    incoming_epoch_known,
    known_digest_matches,
    known_seal_complete: known_digest_matches &&
    closure_consumed &&
    all_outbox_present,
    closure_consumed,
    outbox_entry_count: active_local_outbox_count(self.outbox_value),
    outbox_capacity: self.outbox_capacity_value,
    next_created_order: self.next_created_order_value,
  }
}

///|
pub fn PlayerLocalAuditStore::prepare_seal(
  self : PlayerLocalAuditStore,
  draft : CheckpointSealDraft,
  closure : TrustedEpochClosure,
  destinations : Array[String],
) -> PlayerLocalSealPrepareResult {
  let snapshot = self.seal_snapshot(draft, destinations)
  match prepare_atomic_checkpoint_seal(snapshot, draft, closure, destinations) {
    AtomicCheckpointSealPrepared(plan) =>
      PlayerLocalSealPrepared(PlayerLocalSealPlan::{
        runtime_plan: plan,
        expected_revision: self.storage_revision_value,
        required_destinations: destinations.copy(),
        consumed_closure: closure.evidence_value,
      })
    CheckpointSealAlreadyCommitted => PlayerLocalSealAlreadyCommitted
    CheckpointSealConflict(reason) => PlayerLocalSealConflict(reason)
    CheckpointSealRefused(reason) => PlayerLocalSealRefused(reason)
  }
}

///|
pub fn PlayerLocalAuditStore::commit_seal(
  self : PlayerLocalAuditStore,
  plan : PlayerLocalSealPlan,
) -> PlayerLocalSealCommitResult {
  if self.storage_revision_value != plan.expected_revision {
    return PlayerLocalSealConcurrentWrite
  }
  let runtime_plan = plan.runtime_plan
  let draft = runtime_plan.checkpoint()
  if self.seal_snapshot(draft, plan.required_destinations) !=
    runtime_plan.expected_snapshot() {
    return PlayerLocalSealConcurrentWrite
  }
  let entries = runtime_plan.outbox_entries()
  if active_local_outbox_count(self.outbox_value) + entries.length() !=
    runtime_plan.next_outbox_entry_count() ||
    runtime_plan.next_outbox_entry_count() > self.outbox_capacity_value {
    return PlayerLocalSealConcurrentWrite
  }
  self.checkpoints_value.push(draft)
  self.head_value = runtime_plan.next_head()
  for entry in entries {
    self.outbox_value.push(entry)
  }
  self.consumed_closure_epochs_value.push(runtime_plan.consumed_closure_epoch())
  self.next_created_order_value = runtime_plan.next_created_order()
  self.storage_revision_value += 1
  PlayerLocalSealCommitted
}

///|
pub fn PlayerLocalAuditStore::durable_image(
  self : PlayerLocalAuditStore,
) -> PlayerLocalAuditImage {
  {
    boundary: self.boundary_value,
    genesis_digest: self.genesis_digest_value,
    outbox_capacity: self.outbox_capacity_value,
    events: self.events_value.copy(),
    equivocations: self.equivocations_value.copy(),
    checkpoints: self.checkpoints_value.copy(),
    head: self.head_value,
    retention_anchor: self.retention_anchor_value,
    evidence_holds: self.evidence_holds_value.copy(),
    evidence_inbox_cursors: self.evidence_inbox_cursors_value.copy(),
    evidence_poll_jobs: self.evidence_poll_jobs_value.copy(),
    consumed_closure_epochs: self.consumed_closure_epochs_value.copy(),
    outbox: self.outbox_value.map(fn(entry) { local_outbox_record(entry) }),
    ack_history: self.ack_history_value.copy(),
    next_created_order: self.next_created_order_value,
    storage_revision: self.storage_revision_value,
  }
}

///|
fn local_image_events_valid(image : PlayerLocalAuditImage) -> Bool {
  let accepted_by_key : Map[String, PlayerLocalAuditEvent] = Map([])
  for event in image.events {
    if player_local_event_refusal(image.boundary, event) is Some(_) ||
      event.epoch <= image.retention_anchor.epoch {
      return false
    }
    let key = local_event_key(event.author_id, event.counter)
    if accepted_by_key.contains(key) {
      return false
    }
    accepted_by_key[key] = event
  }
  let seen_conflicts : Map[String, Bool] = Map([])
  for evidence in image.equivocations {
    let key = local_event_key(
      evidence.accepted.author_id,
      evidence.accepted.counter,
    )
    match accepted_by_key.get(key) {
      Some(accepted) =>
        if accepted != evidence.accepted ||
          evidence.conflicting.boundary != image.boundary ||
          evidence.conflicting.author_id != accepted.author_id ||
          evidence.conflicting.counter != accepted.counter ||
          evidence.conflicting.event_digest == accepted.event_digest ||
          evidence.conflicting.epoch <= image.retention_anchor.epoch ||
          player_local_event_refusal(image.boundary, evidence.conflicting)
          is Some(_) {
          return false
        }
      None => return false
    }
    let conflict_key = key + ":" + evidence.conflicting.event_digest.0
    if seen_conflicts.contains(conflict_key) {
      return false
    }
    seen_conflicts[conflict_key] = true
  }
  true
}

///|
fn local_image_checkpoint_chain_valid(image : PlayerLocalAuditImage) -> Bool {
  let mut expected_epoch = image.retention_anchor.epoch + 1
  let mut expected_parent = image.retention_anchor.checkpoint_digest
  for checkpoint in image.checkpoints {
    if checkpoint.boundary != image.boundary ||
      checkpoint.epoch != expected_epoch ||
      checkpoint.previous_checkpoint != expected_parent ||
      checkpoint.checkpoint_digest.0 == "" ||
      checkpoint.canonical_envelope == "" ||
      !int_array_contains(image.consumed_closure_epochs, checkpoint.epoch) {
      return false
    }
    expected_parent = checkpoint.checkpoint_digest
    expected_epoch += 1
  }
  if image.checkpoints.length() == 0 {
    image.head ==
    {
      boundary: image.retention_anchor.boundary,
      epoch: image.retention_anchor.epoch,
      checkpoint_digest: image.retention_anchor.checkpoint_digest,
    }
  } else {
    let latest = image.checkpoints[image.checkpoints.length() - 1]
    image.head ==
    {
      boundary: image.boundary,
      epoch: latest.epoch,
      checkpoint_digest: latest.checkpoint_digest,
    }
  }
}

///|
fn local_image_outbox_valid(image : PlayerLocalAuditImage) -> Bool {
  if active_local_outbox_record_count(image.outbox) > image.outbox_capacity ||
    image.next_created_order < 0 {
    return false
  }
  let seen_order : Map[Int, Bool] = Map([])
  let checkpoint_has_outbox : Map[Int, Bool] = Map([])
  let mut max_created_order = -1
  for entry in image.outbox {
    if !local_outbox_record_valid(entry) ||
      entry.boundary != image.boundary ||
      seen_order.contains(entry.created_order) {
      return false
    }
    match checkpoint_for_epoch(image.checkpoints, entry.epoch) {
      Some(checkpoint) =>
        if checkpoint.checkpoint_digest != entry.checkpoint_digest ||
          checkpoint.canonical_envelope != entry.canonical_envelope {
          return false
        }
      None => return false
    }
    seen_order[entry.created_order] = true
    checkpoint_has_outbox[entry.epoch] = true
    if entry.created_order > max_created_order {
      max_created_order = entry.created_order
    }
  }
  for checkpoint in image.checkpoints {
    if !checkpoint_has_outbox.contains(checkpoint.epoch) {
      return false
    }
  }
  image.next_created_order > max_created_order
}

///|
fn local_ack_key(evidence : CheckpointAckEvidence) -> String {
  evidence.authority_id.length().to_string() +
  ":" +
  evidence.authority_id +
  ":" +
  evidence.epoch.to_string() +
  ":" +
  evidence.checkpoint_digest.0
}

///|
fn local_ack_matches_outbox(
  evidence : CheckpointAckEvidence,
  entry : PlayerLocalCheckpointOutboxRecord,
) -> Bool {
  evidence.boundary == entry.boundary &&
  evidence.authority_id == entry.destination_id &&
  evidence.epoch == entry.epoch &&
  evidence.checkpoint_digest == entry.checkpoint_digest &&
  (
    evidence.decision == CheckpointAccepted ||
    evidence.decision == CheckpointDuplicate
  )
}

///|
fn local_image_ack_history_valid(image : PlayerLocalAuditImage) -> Bool {
  let seen : Map[String, Bool] = Map([])
  for evidence in image.ack_history {
    if !boundary_valid(evidence.boundary) ||
      evidence.boundary != image.boundary ||
      evidence.authority_id == "" ||
      evidence.epoch < 0 ||
      evidence.checkpoint_digest.0 == "" {
      return false
    }
    let key = local_ack_key(evidence)
    if seen.contains(key) {
      return false
    }
    let mut matching_acknowledged_outbox = false
    for entry in image.outbox {
      if local_ack_matches_outbox(evidence, entry) &&
        entry.state == OutboxAcknowledgedState {
        matching_acknowledged_outbox = true
      }
    }
    if !matching_acknowledged_outbox {
      return false
    }
    seen[key] = true
  }
  for entry in image.outbox {
    if entry.state == OutboxAcknowledgedState {
      let mut matching_ack = false
      for evidence in image.ack_history {
        if local_ack_matches_outbox(evidence, entry) {
          matching_ack = true
        }
      }
      if !matching_ack {
        return false
      }
    }
  }
  true
}

///|
fn local_image_evidence_holds_valid(image : PlayerLocalAuditImage) -> Bool {
  let seen : Map[String, Bool] = Map([])
  for hold in image.evidence_holds {
    if !boundary_valid(hold.boundary) ||
      hold.boundary != image.boundary ||
      hold.hold_id == "" ||
      hold.epoch < 0 ||
      hold.checkpoint_digest.0 == "" ||
      hold.reference_digest.0 == "" ||
      seen.contains(hold.hold_id) {
      return false
    }
    match checkpoint_for_epoch(image.checkpoints, hold.epoch) {
      Some(checkpoint) =>
        if checkpoint.checkpoint_digest != hold.checkpoint_digest {
          return false
        }
      None => return false
    }
    match hold.state {
      EvidenceHoldActive => ()
      EvidenceHoldResolved(_, resolution_digest) =>
        if resolution_digest.0 == "" {
          return false
        }
    }
    seen[hold.hold_id] = true
  }
  true
}

///|
fn local_image_evidence_inbox_cursors_valid(
  image : PlayerLocalAuditImage,
) -> Bool {
  let seen : Map[String, Bool] = Map([])
  for cursor in image.evidence_inbox_cursors {
    if !boundary_valid(cursor.boundary) ||
      cursor.boundary != image.boundary ||
      cursor.source_id == "" ||
      cursor.sequence < 0 ||
      cursor.message_digest.0 == "" ||
      seen.contains(cursor.source_id) {
      return false
    }
    seen[cursor.source_id] = true
  }
  true
}

///|
fn local_image_evidence_poll_jobs_valid(image : PlayerLocalAuditImage) -> Bool {
  let seen : Map[String, Bool] = Map([])
  for job in image.evidence_poll_jobs {
    if !boundary_valid(job.boundary) ||
      job.boundary != image.boundary ||
      job.source_id == "" ||
      job.endpoint == "" ||
      job.initial_message_digest.0 == "" ||
      job.deadline_at_ms < 0 ||
      job.next_poll_at_ms < 0 ||
      job.next_poll_at_ms > job.deadline_at_ms ||
      job.failures < 0 ||
      job.attempt_count < 0 ||
      seen.contains(job.source_id) {
      return false
    }
    match job.state {
      EvidencePollScheduled => ()
      EvidencePollInFlight(lease_expires_at_ms) =>
        if job.attempt_count == 0 ||
          lease_expires_at_ms < 0 ||
          lease_expires_at_ms > job.deadline_at_ms {
          return false
        }
      EvidencePollExpired(expired_at_ms) =>
        if expired_at_ms < job.deadline_at_ms {
          return false
        }
      EvidencePollEscalated(escalated_at_ms, reason_digest) =>
        if escalated_at_ms < 0 || reason_digest.0 == "" {
          return false
        }
    }
    seen[job.source_id] = true
  }
  true
}

///|
pub fn restore_player_local_audit_store(
  image : PlayerLocalAuditImage,
) -> PlayerLocalAuditStoreOpenResult {
  if !boundary_valid(image.boundary) {
    return PlayerLocalAuditStoreRefused(LocalStoreInvalidBoundary)
  }
  if image.genesis_digest.0 == "" {
    return PlayerLocalAuditStoreRefused(LocalStoreMissingGenesis)
  }
  if image.outbox_capacity < 0 {
    return PlayerLocalAuditStoreRefused(LocalStoreInvalidOutboxCapacity)
  }
  if image.storage_revision < 0 ||
    image.retention_anchor.boundary != image.boundary ||
    image.retention_anchor.epoch < -1 ||
    image.retention_anchor.epoch > image.head.epoch ||
    image.retention_anchor.checkpoint_digest.0 == "" ||
    (
      image.retention_anchor.epoch == -1 &&
      image.retention_anchor.checkpoint_digest != image.genesis_digest
    ) ||
    !local_image_events_valid(image) ||
    !local_image_checkpoint_chain_valid(image) ||
    !local_image_evidence_holds_valid(image) ||
    !local_image_evidence_inbox_cursors_valid(image) ||
    !local_image_evidence_poll_jobs_valid(image) ||
    !local_image_outbox_valid(image) ||
    !local_image_ack_history_valid(image) {
    return PlayerLocalAuditStoreRefused(LocalStoreInvalidImage)
  }
  let restored_outbox : Array[CheckpointOutboxEntry] = []
  for record in image.outbox {
    match restore_local_outbox_entry(record) {
      Some(entry) => restored_outbox.push(entry)
      None => return PlayerLocalAuditStoreRefused(LocalStoreInvalidImage)
    }
  }
  PlayerLocalAuditStoreReady(PlayerLocalAuditStore::{
    boundary_value: image.boundary,
    genesis_digest_value: image.genesis_digest,
    outbox_capacity_value: image.outbox_capacity,
    events_value: image.events.copy(),
    equivocations_value: image.equivocations.copy(),
    checkpoints_value: image.checkpoints.copy(),
    head_value: image.head,
    retention_anchor_value: image.retention_anchor,
    evidence_holds_value: image.evidence_holds.copy(),
    evidence_inbox_cursors_value: image.evidence_inbox_cursors.copy(),
    evidence_poll_jobs_value: image.evidence_poll_jobs.copy(),
    consumed_closure_epochs_value: image.consumed_closure_epochs.copy(),
    outbox_value: restored_outbox,
    ack_history_value: image.ack_history.copy(),
    next_created_order_value: image.next_created_order,
    storage_revision_value: image.storage_revision,
  })
}

///|
pub fn PlayerLocalAuditStore::event_count(self : PlayerLocalAuditStore) -> Int {
  self.events_value.length()
}

///|
pub fn PlayerLocalAuditStore::equivocation_count(
  self : PlayerLocalAuditStore,
) -> Int {
  self.equivocations_value.length()
}

///|
pub fn PlayerLocalAuditStore::checkpoint_count(
  self : PlayerLocalAuditStore,
) -> Int {
  self.checkpoints_value.length()
}

///|
pub fn PlayerLocalAuditStore::head(
  self : PlayerLocalAuditStore,
) -> CheckpointSealHead {
  self.head_value
}

///|
pub fn PlayerLocalAuditStore::outbox_entries(
  self : PlayerLocalAuditStore,
) -> Array[CheckpointOutboxEntry] {
  self.outbox_value.copy()
}

///|
/// Claim and persist one lease in the same local transaction domain as the
/// outbox. An invalid index or invalid clock input fails without mutation.
pub fn PlayerLocalAuditStore::claim_outbox_at(
  self : PlayerLocalAuditStore,
  index : Int,
  now_ms~ : Int,
  lease_duration_ms~ : Int,
) -> PlayerLocalOutboxUpdateResult {
  if index < 0 || index >= self.outbox_value.length() {
    return PlayerLocalOutboxRefused
  }
  match
    claim_checkpoint_outbox(
      self.outbox_value[index],
      now_ms~,
      lease_duration_ms~,
    ) {
    OutboxClaimed(entry) => {
      self.outbox_value[index] = entry
      self.storage_revision_value += 1
      PlayerLocalOutboxUpdated(entry)
    }
    OutboxNotRetryable => PlayerLocalOutboxNoChange
    OutboxClaimRefused(_) => PlayerLocalOutboxRefused
  }
}

///|
pub fn PlayerLocalAuditStore::release_outbox_at(
  self : PlayerLocalAuditStore,
  index : Int,
) -> PlayerLocalOutboxUpdateResult {
  if index < 0 || index >= self.outbox_value.length() {
    return PlayerLocalOutboxRefused
  }
  match release_checkpoint_outbox(self.outbox_value[index]) {
    OutboxReleased(entry) => {
      self.outbox_value[index] = entry
      self.storage_revision_value += 1
      PlayerLocalOutboxUpdated(entry)
    }
    OutboxReleaseNoop => PlayerLocalOutboxNoChange
  }
}

///|
pub fn PlayerLocalAuditStore::acknowledge_outbox_at(
  self : PlayerLocalAuditStore,
  index : Int,
  ack : AuthenticatedCheckpointAck,
) -> PlayerLocalOutboxUpdateResult {
  if index < 0 || index >= self.outbox_value.length() {
    return PlayerLocalOutboxRefused
  }
  match acknowledge_checkpoint_outbox(self.outbox_value[index], ack) {
    OutboxAcknowledged(entry) => {
      self.outbox_value[index] = entry
      self.ack_history_value.push(ack.evidence())
      self.storage_revision_value += 1
      PlayerLocalOutboxUpdated(entry)
    }
    OutboxAlreadyAcknowledged => PlayerLocalOutboxNoChange
    OutboxAckRefused(_) => PlayerLocalOutboxRefused
  }
}

///|
pub fn PlayerLocalAuditStore::closure_consumed(
  self : PlayerLocalAuditStore,
  epoch : Int,
) -> Bool {
  int_array_contains(self.consumed_closure_epochs_value, epoch)
}
