import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import {
  playerLocalAuditImageError,
  playerLocalEvidenceInboxWriteSetValid,
  playerLocalEvidenceHoldValid,
  playerLocalEvidencePollJobDraftValid,
  playerLocalPruneWriteSetValid,
  samePlayerLocalEvidencePollJobDraft,
} from "./contracts.ts";
import type {
  AuditBoundary,
  CheckpointAckEvidence,
  CheckpointOutboxState,
  CheckpointSealDraft,
  CheckpointSealHead,
  CheckpointSealStorageSnapshot,
  EpochClosureEvidence,
  PlayerLocalAuditEvent,
  PlayerLocalAuditImage,
  PlayerLocalAuditStorage,
  PlayerLocalCheckpointOutboxRecord,
  PlayerLocalEventAdmission,
  PlayerLocalEvidenceHold,
  PlayerLocalEvidenceHoldAdmission,
  PlayerLocalEvidenceHoldResolution,
  PlayerLocalEvidenceHoldResolutionResult,
  PlayerLocalEvidenceInboxApplyResult,
  PlayerLocalEvidenceInboxCursor,
  PlayerLocalEvidenceInboxFaultPoint,
  PlayerLocalEvidenceInboxWriteSet,
  PlayerLocalEvidencePollJob,
  PlayerLocalEvidencePollJobAdmission,
  PlayerLocalEvidencePollJobClaimResult,
  PlayerLocalEvidencePollJobCompletion,
  PlayerLocalEvidencePollJobCompletionResult,
  PlayerLocalEvidencePollJobDraft,
  PlayerLocalEvidencePollJobEscalationResult,
  PlayerLocalOutboxAckResult,
  PlayerLocalPruneFaultPoint,
  PlayerLocalPruneResult,
  PlayerLocalPruneWriteSet,
  PlayerLocalSealCommitResult,
  PlayerLocalSealFaultPoint,
  PlayerLocalSealWriteSet,
  PlayerLocalStoreConfiguration,
} from "./contracts.ts";

export type * from "./contracts.ts";

export class InjectedPlayerLocalSealFault extends Error {
  readonly faultPoint: PlayerLocalSealFaultPoint;

  constructor(faultPoint: PlayerLocalSealFaultPoint) {
    super(`injected player-local seal fault: ${faultPoint}`);
    this.faultPoint = faultPoint;
  }
}

export class InjectedPlayerLocalPruneFault extends Error {
  readonly faultPoint: PlayerLocalPruneFaultPoint;

  constructor(faultPoint: PlayerLocalPruneFaultPoint) {
    super(`injected player-local prune fault: ${faultPoint}`);
    this.faultPoint = faultPoint;
  }
}

export class InjectedPlayerLocalEvidenceInboxFault extends Error {
  readonly faultPoint: PlayerLocalEvidenceInboxFaultPoint;

  constructor(faultPoint: PlayerLocalEvidenceInboxFaultPoint) {
    super(`injected player-local evidence inbox fault: ${faultPoint}`);
    this.faultPoint = faultPoint;
  }
}

export class PlayerLocalStoreCorruptError extends Error {
  constructor(message = "player-local SQLite image violates its contract") {
    super(message);
  }
}

interface ConfigurationRow {
  protocol_version: number;
  purpose: string;
  manifest_digest: string;
  scope_id: string;
  unit_id: string;
  genesis_digest: string;
  outbox_capacity: number;
  next_created_order: number;
  storage_revision: number;
}

interface EventRow {
  author_id: string;
  counter: number;
  epoch: number;
  event_digest: string;
  canonical_event: string;
}

interface EquivocationRow {
  author_id: string;
  counter: number;
  epoch: number;
  conflicting_digest: string;
  canonical_event: string;
}

interface CheckpointRow {
  epoch: number;
  previous_checkpoint: string;
  checkpoint_digest: string;
  canonical_envelope: string;
}

interface HeadRow {
  epoch: number;
  checkpoint_digest: string;
}

interface RetentionAnchorRow {
  epoch: number;
  checkpoint_digest: string;
}

interface EvidenceHoldRow {
  hold_id: string;
  epoch: number;
  checkpoint_digest: string;
  kind: "fork" | "challenge" | "appeal";
  reference_digest: string;
  state: "active" | "resolved";
  decision: "upheld" | "dismissed" | null;
  resolution_digest: string | null;
}

interface EvidenceInboxCursorRow {
  source_id: string;
  sequence: number;
  message_digest: string;
}

interface EvidencePollJobRow {
  source_id: string;
  endpoint: string;
  initial_message_digest: string;
  deadline_at_ms: number;
  next_poll_at_ms: number;
  failures: number;
  attempt_count: number;
  state: "scheduled" | "in_flight" | "expired" | "escalated";
  lease_expires_at_ms: number | null;
  expired_at_ms: number | null;
  escalated_at_ms: number | null;
  reason_digest: string | null;
}

interface ClosureRow {
  epoch: number;
  roster_digest: string;
  frontier_digest: string;
  certificate_digest: string;
}

interface OutboxRow {
  destination_id: string;
  epoch: number;
  checkpoint_digest: string;
  canonical_envelope: string;
  created_order: number;
  state: "pending" | "in_flight" | "acknowledged";
  lease_expires_at_ms: number | null;
}

interface AckRow {
  authority_id: string;
  epoch: number;
  checkpoint_digest: string;
  decision: "accepted" | "duplicate";
}

class PlayerLocalSealCasConflict extends Error {}
class PlayerLocalPruneCasConflict extends Error {}

function isNonNegativeInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

function boundaryValid(boundary: AuditBoundary): boolean {
  return (
    Number.isSafeInteger(boundary.protocol_version) &&
    boundary.protocol_version > 0 &&
    boundary.purpose.length > 0 &&
    boundary.manifest_digest.length > 0 &&
    boundary.scope_id.length > 0 &&
    boundary.unit_id.length > 0
  );
}

function sameBoundary(left: AuditBoundary, right: AuditBoundary): boolean {
  return (
    left.protocol_version === right.protocol_version &&
    left.purpose === right.purpose &&
    left.manifest_digest === right.manifest_digest &&
    left.scope_id === right.scope_id &&
    left.unit_id === right.unit_id
  );
}

function sameHead(left: CheckpointSealHead, right: CheckpointSealHead): boolean {
  return (
    sameBoundary(left.boundary, right.boundary) &&
    left.epoch === right.epoch &&
    left.checkpoint_digest === right.checkpoint_digest
  );
}

function sameSnapshot(
  left: CheckpointSealStorageSnapshot,
  right: CheckpointSealStorageSnapshot,
): boolean {
  return (
    sameBoundary(left.boundary, right.boundary) &&
    left.current_epoch === right.current_epoch &&
    left.current_digest === right.current_digest &&
    left.incoming_epoch_known === right.incoming_epoch_known &&
    left.known_digest_matches === right.known_digest_matches &&
    left.known_seal_complete === right.known_seal_complete &&
    left.closure_consumed === right.closure_consumed &&
    left.outbox_entry_count === right.outbox_entry_count &&
    left.outbox_capacity === right.outbox_capacity &&
    left.next_created_order === right.next_created_order
  );
}

function eventValid(
  boundary: AuditBoundary,
  event: PlayerLocalAuditEvent,
): boolean {
  return (
    sameBoundary(boundary, event.boundary) &&
    event.author_id.length > 0 &&
    isNonNegativeInteger(event.counter) &&
    isNonNegativeInteger(event.epoch) &&
    event.event_digest.length > 0 &&
    event.canonical_event.length > 0
  );
}

function checkpointValid(
  boundary: AuditBoundary,
  checkpoint: CheckpointSealDraft,
): boolean {
  return (
    sameBoundary(boundary, checkpoint.boundary) &&
    isNonNegativeInteger(checkpoint.epoch) &&
    checkpoint.previous_checkpoint.length > 0 &&
    checkpoint.checkpoint_digest.length > 0 &&
    checkpoint.canonical_envelope.length > 0
  );
}

function closureValid(
  boundary: AuditBoundary,
  closure: EpochClosureEvidence,
): boolean {
  return (
    sameBoundary(boundary, closure.boundary) &&
    isNonNegativeInteger(closure.epoch) &&
    closure.roster_digest.length > 0 &&
    closure.frontier_digest.length > 0 &&
    closure.certificate_digest.length > 0
  );
}

export class PlayerLocalSqliteStore implements PlayerLocalAuditStorage {
  private readonly database: DatabaseSync;

  static open(
    path: string,
    configuration: PlayerLocalStoreConfiguration,
  ): PlayerLocalSqliteStore {
    if (
      !boundaryValid(configuration.boundary) ||
      configuration.genesis_digest.length === 0 ||
      !isNonNegativeInteger(configuration.outbox_capacity)
    ) {
      throw new TypeError("invalid player-local store configuration");
    }
    const database = new DatabaseSync(path);
    try {
      const store = new PlayerLocalSqliteStore(database);
      store.createSchema();
      store.configure(configuration);
      store.assertValidImage();
      return store;
    } catch (error) {
      database.close();
      throw error;
    }
  }

  private constructor(database: DatabaseSync) {
    this.database = database;
  }

  close(): void {
    this.database.close();
  }

  admitEvent(event: PlayerLocalAuditEvent): PlayerLocalEventAdmission {
    const boundary = this.boundary();
    if (!eventValid(boundary, event)) {
      return { decision: "refused", reason: "invalid_event" };
    }
    return this.transaction(() => {
      const anchor = this.get<RetentionAnchorRow>(
        `SELECT epoch, checkpoint_digest FROM player_local_retention_anchor
         WHERE singleton = 1`,
      );
      if (!anchor) {
        throw new PlayerLocalStoreCorruptError("missing retention anchor");
      }
      if (event.epoch <= anchor.epoch) {
        return { decision: "refused", reason: "pruned_epoch" };
      }
      const accepted = this.get<EventRow>(
        `SELECT author_id, counter, epoch, event_digest, canonical_event
         FROM player_local_events WHERE author_id = ? AND counter = ?`,
        event.author_id,
        event.counter,
      );
      if (!accepted) {
        this.run(
          `INSERT INTO player_local_events
           (author_id, counter, epoch, event_digest, canonical_event)
           VALUES (?, ?, ?, ?, ?)`,
          event.author_id,
          event.counter,
          event.epoch,
          event.event_digest,
          event.canonical_event,
        );
        this.incrementRevision();
        return { decision: "stored" };
      }
      if (accepted.event_digest === event.event_digest) {
        return accepted.epoch === event.epoch &&
            accepted.canonical_event === event.canonical_event
          ? { decision: "duplicate" }
          : { decision: "refused", reason: "digest_collision" };
      }
      const knownConflict = this.get<{ epoch: number; canonical_event: string }>(
        `SELECT epoch, canonical_event FROM player_local_equivocations
         WHERE author_id = ? AND counter = ? AND conflicting_digest = ?`,
        event.author_id,
        event.counter,
        event.event_digest,
      );
      if (knownConflict) {
        return knownConflict.epoch === event.epoch &&
            knownConflict.canonical_event === event.canonical_event
          ? { decision: "equivocation" }
          : { decision: "refused", reason: "digest_collision" };
      } else {
        this.run(
          `INSERT INTO player_local_equivocations
           (author_id, counter, epoch, conflicting_digest, canonical_event)
           VALUES (?, ?, ?, ?, ?)`,
          event.author_id,
          event.counter,
          event.epoch,
          event.event_digest,
          event.canonical_event,
        );
        this.incrementRevision();
      }
      return { decision: "equivocation" };
    });
  }

  commitSeal(
    writeSet: PlayerLocalSealWriteSet,
    faultPoint?: PlayerLocalSealFaultPoint,
  ): PlayerLocalSealCommitResult {
    try {
      return this.transaction(() => {
        const config = this.configuration();
        if (config.storage_revision !== writeSet.expected_revision) {
          return { decision: "concurrent_write" };
        }
        const actualSnapshot = this.sealSnapshot(
          writeSet.checkpoint,
          writeSet.outbox_entries.map((entry) => entry.destination_id),
        );
      if (!sameSnapshot(actualSnapshot, writeSet.expected_snapshot)) {
          return { decision: "concurrent_write" };
        }
        if (!this.writeSetValid(writeSet, config)) {
          return { decision: "refused", reason: "invalid_write_set" };
        }

        const checkpoint = writeSet.checkpoint;
        this.run(
          `INSERT INTO player_local_checkpoints
           (epoch, previous_checkpoint, checkpoint_digest, canonical_envelope)
           VALUES (?, ?, ?, ?)`,
          checkpoint.epoch,
          checkpoint.previous_checkpoint,
          checkpoint.checkpoint_digest,
          checkpoint.canonical_envelope,
        );
        this.inject(faultPoint, "after_history");

        const headWrite = this.run(
          `UPDATE player_local_head SET epoch = ?, checkpoint_digest = ?
           WHERE singleton = 1 AND epoch = ? AND checkpoint_digest = ?`,
          writeSet.next_head.epoch,
          writeSet.next_head.checkpoint_digest,
          writeSet.expected_snapshot.current_epoch,
          writeSet.expected_snapshot.current_digest,
        );
        if (headWrite !== 1) throw new PlayerLocalSealCasConflict();
        this.inject(faultPoint, "after_head");

        for (const entry of writeSet.outbox_entries) {
          this.run(
            `INSERT INTO player_local_outbox
             (destination_id, epoch, checkpoint_digest, canonical_envelope,
              created_order, state, lease_expires_at_ms)
             VALUES (?, ?, ?, ?, ?, 'pending', NULL)`,
            entry.destination_id,
            entry.epoch,
            entry.checkpoint_digest,
            entry.canonical_envelope,
            entry.created_order,
          );
        }
        this.inject(faultPoint, "after_outbox");

        const closure = writeSet.consumed_closure;
        this.run(
          `INSERT INTO player_local_consumed_closures
           (epoch, roster_digest, frontier_digest, certificate_digest)
           VALUES (?, ?, ?, ?)`,
          closure.epoch,
          closure.roster_digest,
          closure.frontier_digest,
          closure.certificate_digest,
        );
        this.inject(faultPoint, "after_closure");

        const configWrite = this.run(
          `UPDATE player_local_config
           SET next_created_order = ?, storage_revision = storage_revision + 1
           WHERE singleton = 1 AND storage_revision = ?
             AND next_created_order = ?`,
          writeSet.next_created_order,
          writeSet.expected_revision,
          writeSet.expected_snapshot.next_created_order,
        );
        if (configWrite !== 1) throw new PlayerLocalSealCasConflict();
        return { decision: "committed" };
      });
    } catch (error) {
      if (error instanceof InjectedPlayerLocalSealFault) throw error;
      if (error instanceof PlayerLocalSealCasConflict) {
        return { decision: "concurrent_write" };
      }
      throw error;
    }
  }

  claimOutbox(
    createdOrder: number,
    nowMs: number,
    leaseDurationMs: number,
  ): PlayerLocalCheckpointOutboxRecord | undefined {
    if (
      !isNonNegativeInteger(createdOrder) ||
      !isNonNegativeInteger(nowMs) ||
      !Number.isSafeInteger(leaseDurationMs) ||
      leaseDurationMs <= 0
    ) {
      return undefined;
    }
    const leaseExpiresAt = nowMs + leaseDurationMs;
    if (!Number.isSafeInteger(leaseExpiresAt) || leaseExpiresAt < nowMs) {
      return undefined;
    }
    return this.transaction(() => {
      const row = this.outboxAt(createdOrder);
      if (
        !row ||
        row.state === "acknowledged" ||
        (row.state === "in_flight" &&
          row.lease_expires_at_ms !== null &&
          row.lease_expires_at_ms > nowMs)
      ) {
        return undefined;
      }
      const changed = this.run(
        `UPDATE player_local_outbox
         SET state = 'in_flight', lease_expires_at_ms = ?
         WHERE created_order = ? AND (
           state = 'pending' OR
           (state = 'in_flight' AND lease_expires_at_ms <= ?)
         )`,
        leaseExpiresAt,
        createdOrder,
        nowMs,
      );
      if (changed !== 1) return undefined;
      this.incrementRevision();
      return this.outboxRecord(
        {
          ...row,
          state: "in_flight",
          lease_expires_at_ms: leaseExpiresAt,
        },
        this.boundary(),
      );
    });
  }

  releaseOutbox(createdOrder: number): boolean {
    if (!isNonNegativeInteger(createdOrder)) return false;
    return this.transaction(() => {
      const changed = this.run(
        `UPDATE player_local_outbox
         SET state = 'pending', lease_expires_at_ms = NULL
         WHERE created_order = ? AND state = 'in_flight'`,
        createdOrder,
      );
      if (changed !== 1) return false;
      this.incrementRevision();
      return true;
    });
  }

  acknowledgeOutbox(
    evidence: CheckpointAckEvidence,
  ): PlayerLocalOutboxAckResult {
    const boundary = this.boundary();
    if (
      !sameBoundary(boundary, evidence.boundary) ||
      evidence.authority_id.length === 0 ||
      !isNonNegativeInteger(evidence.epoch) ||
      evidence.checkpoint_digest.length === 0 ||
      (evidence.decision !== "accepted" && evidence.decision !== "duplicate")
    ) {
      return { decision: "refused", reason: "invalid_ack" };
    }
    return this.transaction(() => {
      const row = this.get<OutboxRow>(
        `SELECT destination_id, epoch, checkpoint_digest, canonical_envelope,
                created_order, state, lease_expires_at_ms
         FROM player_local_outbox
         WHERE destination_id = ? AND epoch = ? AND checkpoint_digest = ?`,
        evidence.authority_id,
        evidence.epoch,
        evidence.checkpoint_digest,
      );
      if (!row) return { decision: "refused", reason: "ack_mismatch" };
      if (row.state === "acknowledged") return { decision: "no_change" };
      this.run(
        `INSERT INTO player_local_ack_history
         (authority_id, epoch, checkpoint_digest, decision)
         VALUES (?, ?, ?, ?)`,
        evidence.authority_id,
        evidence.epoch,
        evidence.checkpoint_digest,
        evidence.decision,
      );
      const changed = this.run(
        `UPDATE player_local_outbox
         SET state = 'acknowledged', lease_expires_at_ms = NULL
         WHERE created_order = ? AND state != 'acknowledged'`,
        row.created_order,
      );
      if (changed !== 1) throw new PlayerLocalSealCasConflict();
      this.incrementRevision();
      return { decision: "updated" };
    });
  }

  placeEvidenceHold(
    hold: PlayerLocalEvidenceHold,
  ): PlayerLocalEvidenceHoldAdmission {
    const boundary = this.boundary();
    if (
      !playerLocalEvidenceHoldValid(boundary, hold) ||
      hold.state.kind !== "active"
    ) {
      return { decision: "refused", reason: "invalid_hold" };
    }
    return this.transaction(() => {
      const existing = this.evidenceHoldRow(hold.hold_id);
      if (existing) {
        return this.sameEvidenceHoldIdentity(existing, hold)
          ? { decision: "duplicate" }
          : { decision: "refused", reason: "hold_conflict" };
      }
      const anchor = this.get<RetentionAnchorRow>(
        `SELECT epoch, checkpoint_digest FROM player_local_retention_anchor
         WHERE singleton = 1`,
      );
      if (!anchor) {
        throw new PlayerLocalStoreCorruptError("missing retention anchor");
      }
      if (hold.epoch <= anchor.epoch) {
        return { decision: "refused", reason: "pruned_epoch" };
      }
      const checkpoint = this.get<CheckpointRow>(
        `SELECT epoch, previous_checkpoint, checkpoint_digest, canonical_envelope
         FROM player_local_checkpoints WHERE epoch = ?`,
        hold.epoch,
      );
      if (!checkpoint || checkpoint.checkpoint_digest !== hold.checkpoint_digest) {
        return { decision: "refused", reason: "checkpoint_mismatch" };
      }
      this.run(
        `INSERT INTO player_local_evidence_holds
         (hold_id, epoch, checkpoint_digest, kind, reference_digest, state,
          decision, resolution_digest)
         VALUES (?, ?, ?, ?, ?, 'active', NULL, NULL)`,
        hold.hold_id,
        hold.epoch,
        hold.checkpoint_digest,
        hold.kind,
        hold.reference_digest,
      );
      this.incrementRevision();
      return { decision: "stored" };
    });
  }

  resolveEvidenceHold(
    resolution: PlayerLocalEvidenceHoldResolution,
  ): PlayerLocalEvidenceHoldResolutionResult {
    const boundary = this.boundary();
    if (
      !sameBoundary(boundary, resolution.boundary) ||
      resolution.hold_id.length === 0 ||
      !isNonNegativeInteger(resolution.epoch) ||
      resolution.checkpoint_digest.length === 0 ||
      resolution.reference_digest.length === 0 ||
      (resolution.decision !== "upheld" &&
        resolution.decision !== "dismissed") ||
      resolution.resolution_digest.length === 0
    ) {
      return { decision: "refused", reason: "invalid_resolution" };
    }
    return this.transaction(() => {
      const existing = this.evidenceHoldRow(resolution.hold_id);
      if (!existing) return { decision: "refused", reason: "hold_missing" };
      if (
        existing.epoch !== resolution.epoch ||
        existing.checkpoint_digest !== resolution.checkpoint_digest ||
        existing.reference_digest !== resolution.reference_digest
      ) {
        return { decision: "refused", reason: "hold_mismatch" };
      }
      if (existing.state === "resolved") {
        return existing.decision === resolution.decision &&
            existing.resolution_digest === resolution.resolution_digest
          ? { decision: "no_change" }
          : { decision: "refused", reason: "resolution_conflict" };
      }
      const changed = this.run(
        `UPDATE player_local_evidence_holds
         SET state = 'resolved', decision = ?, resolution_digest = ?
         WHERE hold_id = ? AND state = 'active'`,
        resolution.decision,
        resolution.resolution_digest,
        resolution.hold_id,
      );
      if (changed !== 1) throw new PlayerLocalPruneCasConflict();
      this.incrementRevision();
      return { decision: "resolved" };
    });
  }

  applyEvidenceInbox(
    writeSet: PlayerLocalEvidenceInboxWriteSet,
    faultPoint?: PlayerLocalEvidenceInboxFaultPoint,
  ): PlayerLocalEvidenceInboxApplyResult {
    return this.transaction(() => {
      const current = this.image();
      if (current.storage_revision !== writeSet.expected_revision) {
        return { decision: "concurrent_write" };
      }
      if (!playerLocalEvidenceInboxWriteSetValid(current, writeSet)) {
        return { decision: "refused", reason: "invalid_write_set" };
      }
      const operation = writeSet.operation;
      if (operation.kind === "place") {
        const hold = operation.hold;
        if (!this.evidenceHoldRow(hold.hold_id)) {
          this.run(
            `INSERT INTO player_local_evidence_holds
             (hold_id, epoch, checkpoint_digest, kind, reference_digest, state,
              decision, resolution_digest)
             VALUES (?, ?, ?, ?, ?, 'active', NULL, NULL)`,
            hold.hold_id,
            hold.epoch,
            hold.checkpoint_digest,
            hold.kind,
            hold.reference_digest,
          );
        }
      } else {
        const resolution = operation.resolution;
        const existing = this.evidenceHoldRow(resolution.hold_id)!;
        if (existing.state === "active") {
          const changed = this.run(
            `UPDATE player_local_evidence_holds
             SET state = 'resolved', decision = ?, resolution_digest = ?
             WHERE hold_id = ? AND state = 'active'`,
            resolution.decision,
            resolution.resolution_digest,
            resolution.hold_id,
          );
          if (changed !== 1) throw new PlayerLocalPruneCasConflict();
        }
      }
      this.injectEvidenceInbox(faultPoint, "after_hold");

      const expected = writeSet.expected_cursor;
      const next = writeSet.next_cursor;
      let cursorChanged: number;
      if (expected.sequence === -1) {
        cursorChanged = this.run(
          `INSERT OR IGNORE INTO player_local_evidence_inbox_cursors
           (source_id, sequence, message_digest) VALUES (?, ?, ?)`,
          next.source_id,
          next.sequence,
          next.message_digest,
        );
      } else {
        cursorChanged = this.run(
          `UPDATE player_local_evidence_inbox_cursors
           SET sequence = ?, message_digest = ?
           WHERE source_id = ? AND sequence = ? AND message_digest = ?`,
          next.sequence,
          next.message_digest,
          expected.source_id,
          expected.sequence,
          expected.message_digest,
        );
      }
      if (cursorChanged !== 1) throw new PlayerLocalPruneCasConflict();
      this.injectEvidenceInbox(faultPoint, "after_cursor");
      this.incrementRevision();
      return { decision: "applied" };
    });
  }

  scheduleEvidencePollJob(
    draft: PlayerLocalEvidencePollJobDraft,
  ): PlayerLocalEvidencePollJobAdmission {
    const boundary = this.boundary();
    if (!playerLocalEvidencePollJobDraftValid(boundary, draft)) {
      return { decision: "refused", reason: "invalid_job" };
    }
    return this.transaction(() => {
      const existing = this.evidencePollJobRow(draft.source_id);
      if (existing) {
        return samePlayerLocalEvidencePollJobDraft(
            this.evidencePollJob(existing, boundary),
            draft,
          )
          ? { decision: "duplicate" }
          : { decision: "refused", reason: "source_conflict" };
      }
      this.run(
        `INSERT INTO player_local_evidence_poll_jobs
         (source_id, endpoint, initial_message_digest, deadline_at_ms,
          next_poll_at_ms, failures, attempt_count, state,
          lease_expires_at_ms, expired_at_ms, escalated_at_ms, reason_digest)
         VALUES (?, ?, ?, ?, ?, 0, 0, 'scheduled', NULL, NULL, NULL, NULL)`,
        draft.source_id,
        draft.endpoint,
        draft.initial_message_digest,
        draft.deadline_at_ms,
        draft.next_poll_at_ms,
      );
      this.incrementRevision();
      return { decision: "stored" };
    });
  }

  claimEvidencePollJob(
    sourceId: string,
    nowMs: number,
    leaseDurationMs: number,
  ): PlayerLocalEvidencePollJobClaimResult {
    if (
      sourceId.length === 0 ||
      sourceId.length > 256 ||
      !isNonNegativeInteger(nowMs) ||
      !Number.isSafeInteger(leaseDurationMs) ||
      leaseDurationMs <= 0
    ) return { decision: "refused", reason: "invalid_claim" };
    const requestedLeaseExpiry = nowMs + leaseDurationMs;
    if (
      !Number.isSafeInteger(requestedLeaseExpiry) ||
      requestedLeaseExpiry <= nowMs
    ) return { decision: "refused", reason: "invalid_claim" };
    return this.transaction(() => {
      const row = this.evidencePollJobRow(sourceId);
      if (!row) return { decision: "not_found" };
      if (row.state === "expired" || row.state === "escalated") {
        return { decision: "terminal", state: row.state };
      }
      if (nowMs >= row.deadline_at_ms) {
        this.run(
          `UPDATE player_local_evidence_poll_jobs
           SET state = 'expired', lease_expires_at_ms = NULL,
               expired_at_ms = ?, escalated_at_ms = NULL, reason_digest = NULL
           WHERE source_id = ?`,
          nowMs,
          sourceId,
        );
        this.incrementRevision();
        return { decision: "terminal", state: "expired" };
      }
      if (
        (row.state === "scheduled" && row.next_poll_at_ms > nowMs) ||
        (row.state === "in_flight" &&
          row.lease_expires_at_ms !== null &&
          row.lease_expires_at_ms > nowMs)
      ) return { decision: "not_due" };
      const attemptCount = row.attempt_count + 1;
      if (!Number.isSafeInteger(attemptCount)) {
        return { decision: "refused", reason: "attempt_overflow" };
      }
      const leaseExpiresAt = Math.min(
        requestedLeaseExpiry,
        row.deadline_at_ms,
      );
      this.run(
        `UPDATE player_local_evidence_poll_jobs
         SET state = 'in_flight', attempt_count = ?, lease_expires_at_ms = ?,
             expired_at_ms = NULL, escalated_at_ms = NULL, reason_digest = NULL
         WHERE source_id = ?`,
        attemptCount,
        leaseExpiresAt,
        sourceId,
      );
      this.incrementRevision();
      return {
        decision: "claimed",
        job: this.evidencePollJob(
          {
            ...row,
            state: "in_flight",
            attempt_count: attemptCount,
            lease_expires_at_ms: leaseExpiresAt,
            expired_at_ms: null,
            escalated_at_ms: null,
            reason_digest: null,
          },
          this.boundary(),
        ),
      };
    });
  }

  completeEvidencePollJob(
    completion: PlayerLocalEvidencePollJobCompletion,
  ): PlayerLocalEvidencePollJobCompletionResult {
    if (
      completion.source_id.length === 0 ||
      completion.source_id.length > 256 ||
      !isNonNegativeInteger(completion.expected_attempt_count) ||
      completion.expected_attempt_count === 0 ||
      !isNonNegativeInteger(completion.expected_lease_expires_at_ms) ||
      !isNonNegativeInteger(completion.completed_at_ms) ||
      !isNonNegativeInteger(completion.next_poll_at_ms) ||
      !isNonNegativeInteger(completion.failures)
    ) return { decision: "refused", reason: "invalid_completion" };
    return this.transaction(() => {
      const row = this.evidencePollJobRow(completion.source_id);
      if (!row) return { decision: "refused", reason: "job_not_found" };
      if (
        row.state !== "in_flight" ||
        row.attempt_count !== completion.expected_attempt_count ||
        row.lease_expires_at_ms !== completion.expected_lease_expires_at_ms
      ) return { decision: "concurrent_write" };
      const failuresAdvance = completion.failures === 0 ||
        completion.failures === row.failures + 1;
      if (
        completion.completed_at_ms > completion.expected_lease_expires_at_ms ||
        completion.completed_at_ms >= row.deadline_at_ms ||
        completion.next_poll_at_ms < completion.completed_at_ms ||
        completion.next_poll_at_ms > row.deadline_at_ms ||
        !failuresAdvance ||
        !Number.isSafeInteger(row.failures + 1)
      ) return { decision: "refused", reason: "invalid_completion" };
      this.run(
        `UPDATE player_local_evidence_poll_jobs
         SET state = 'scheduled', next_poll_at_ms = ?, failures = ?,
             lease_expires_at_ms = NULL, expired_at_ms = NULL,
             escalated_at_ms = NULL, reason_digest = NULL
         WHERE source_id = ?`,
        completion.next_poll_at_ms,
        completion.failures,
        completion.source_id,
      );
      this.incrementRevision();
      return { decision: "updated" };
    });
  }

  escalateEvidencePollJob(
    sourceId: string,
    nowMs: number,
    reasonDigest: string,
  ): PlayerLocalEvidencePollJobEscalationResult {
    if (
      sourceId.length === 0 ||
      sourceId.length > 256 ||
      !isNonNegativeInteger(nowMs) ||
      reasonDigest.length === 0 ||
      reasonDigest.length > 4_096
    ) return { decision: "refused", reason: "invalid_escalation" };
    return this.transaction(() => {
      const row = this.evidencePollJobRow(sourceId);
      if (!row) return { decision: "not_found" };
      if (row.state === "escalated") {
        return row.reason_digest === reasonDigest
          ? { decision: "no_change" }
          : { decision: "refused", reason: "escalation_conflict" };
      }
      this.run(
        `UPDATE player_local_evidence_poll_jobs
         SET state = 'escalated', lease_expires_at_ms = NULL,
             expired_at_ms = NULL, escalated_at_ms = ?, reason_digest = ?
         WHERE source_id = ?`,
        nowMs,
        reasonDigest,
        sourceId,
      );
      this.incrementRevision();
      return { decision: "updated" };
    });
  }

  pruneEvidence(
    writeSet: PlayerLocalPruneWriteSet,
    faultPoint?: PlayerLocalPruneFaultPoint,
  ): PlayerLocalPruneResult {
    try {
      return this.transaction(() => {
        const current = this.image();
        if (current.storage_revision !== writeSet.expected_revision) {
          return { decision: "concurrent_write" };
        }
        if (!playerLocalPruneWriteSetValid(current, writeSet)) {
          return { decision: "refused", reason: "invalid_write_set" };
        }
        const through = writeSet.next_anchor.epoch;
        this.run(
          "DELETE FROM player_local_equivocations WHERE epoch <= ?",
          through,
        );
        this.run("DELETE FROM player_local_events WHERE epoch <= ?", through);
        this.injectPrune(faultPoint, "after_events");

        this.run("DELETE FROM player_local_ack_history WHERE epoch <= ?", through);
        this.run("DELETE FROM player_local_outbox WHERE epoch <= ?", through);
        this.injectPrune(faultPoint, "after_outbox");

        this.run(
          "DELETE FROM player_local_consumed_closures WHERE epoch <= ?",
          through,
        );
        this.run(
          `DELETE FROM player_local_evidence_holds
           WHERE epoch <= ? AND state = 'resolved'`,
          through,
        );
        this.run(
          "DELETE FROM player_local_checkpoints WHERE epoch <= ?",
          through,
        );
        this.injectPrune(faultPoint, "after_checkpoints");

        const anchorChanged = this.run(
          `UPDATE player_local_retention_anchor
           SET epoch = ?, checkpoint_digest = ?
           WHERE singleton = 1 AND epoch = ? AND checkpoint_digest = ?`,
          writeSet.next_anchor.epoch,
          writeSet.next_anchor.checkpoint_digest,
          writeSet.expected_anchor.epoch,
          writeSet.expected_anchor.checkpoint_digest,
        );
        if (anchorChanged !== 1) throw new PlayerLocalPruneCasConflict();
        this.injectPrune(faultPoint, "after_anchor");
        this.incrementRevision();
        return { decision: "pruned", pruned_through_epoch: through };
      });
    } catch (error) {
      if (error instanceof PlayerLocalPruneCasConflict) {
        return { decision: "concurrent_write" };
      }
      throw error;
    }
  }

  image(): PlayerLocalAuditImage {
    const config = this.configuration();
    const boundary = this.boundaryFromRow(config);
    const eventRows = this.all<EventRow>(
      `SELECT author_id, counter, epoch, event_digest, canonical_event
       FROM player_local_events ORDER BY author_id, counter`,
    );
    const events = eventRows.map((row) => this.eventFromRow(boundary, row));
    const accepted = new Map(
      events.map((event) => [`${event.author_id}\u0000${event.counter}`, event]),
    );
    const equivocations = this.all<EquivocationRow>(
      `SELECT author_id, counter, epoch, conflicting_digest, canonical_event
       FROM player_local_equivocations
       ORDER BY author_id, counter, conflicting_digest`,
    ).map((row) => {
      const acceptedEvent = accepted.get(`${row.author_id}\u0000${row.counter}`);
      if (!acceptedEvent) {
        throw new PlayerLocalStoreCorruptError("orphan equivocation row");
      }
      return {
        accepted: acceptedEvent,
        conflicting: this.eventFromRow(boundary, {
          author_id: row.author_id,
          counter: row.counter,
          epoch: row.epoch,
          event_digest: row.conflicting_digest,
          canonical_event: row.canonical_event,
        }),
      };
    });
    const checkpoints = this.all<CheckpointRow>(
      `SELECT epoch, previous_checkpoint, checkpoint_digest, canonical_envelope
       FROM player_local_checkpoints ORDER BY epoch`,
    ).map((row) => ({ boundary, ...row }));
    const headRow = this.get<HeadRow>(
      `SELECT epoch, checkpoint_digest FROM player_local_head
       WHERE singleton = 1`,
    );
    if (!headRow) throw new PlayerLocalStoreCorruptError("missing local head");
    const retentionAnchorRow = this.get<RetentionAnchorRow>(
      `SELECT epoch, checkpoint_digest FROM player_local_retention_anchor
       WHERE singleton = 1`,
    );
    if (!retentionAnchorRow) {
      throw new PlayerLocalStoreCorruptError("missing retention anchor");
    }
    const consumed_closures = this.all<ClosureRow>(
      `SELECT epoch, roster_digest, frontier_digest, certificate_digest
       FROM player_local_consumed_closures ORDER BY epoch`,
    ).map((row) => ({ boundary, ...row }));
    const evidence_holds = this.all<EvidenceHoldRow>(
      `SELECT hold_id, epoch, checkpoint_digest, kind, reference_digest, state,
              decision, resolution_digest
       FROM player_local_evidence_holds ORDER BY epoch, hold_id`,
    ).map((row): PlayerLocalEvidenceHold => ({
      boundary,
      hold_id: row.hold_id,
      epoch: row.epoch,
      checkpoint_digest: row.checkpoint_digest,
      kind: row.kind,
      reference_digest: row.reference_digest,
      state: row.state === "active"
        ? { kind: "active" }
        : {
            kind: "resolved",
            decision: row.decision!,
            resolution_digest: row.resolution_digest!,
          },
    }));
    const evidence_inbox_cursors = this.all<EvidenceInboxCursorRow>(
      `SELECT source_id, sequence, message_digest
       FROM player_local_evidence_inbox_cursors ORDER BY source_id`,
    ).map((row): PlayerLocalEvidenceInboxCursor => ({ boundary, ...row }));
    const evidence_poll_jobs = this.all<EvidencePollJobRow>(
      `SELECT source_id, endpoint, initial_message_digest, deadline_at_ms,
              next_poll_at_ms, failures, attempt_count, state,
              lease_expires_at_ms, expired_at_ms, escalated_at_ms, reason_digest
       FROM player_local_evidence_poll_jobs ORDER BY source_id`,
    ).map((row) => this.evidencePollJob(row, boundary));
    const outbox = this.all<OutboxRow>(
      `SELECT destination_id, epoch, checkpoint_digest, canonical_envelope,
              created_order, state, lease_expires_at_ms
       FROM player_local_outbox ORDER BY created_order`,
    ).map((row) => this.outboxRecord(row, boundary));
    const ack_history = this.all<AckRow>(
      `SELECT authority_id, epoch, checkpoint_digest, decision
       FROM player_local_ack_history
       ORDER BY authority_id, epoch, checkpoint_digest`,
    ).map((row) => ({ boundary, ...row }));
    return {
      boundary,
      genesis_digest: config.genesis_digest,
      outbox_capacity: config.outbox_capacity,
      events,
      equivocations,
      checkpoints,
      head: { boundary, ...headRow },
      retention_anchor: { boundary, ...retentionAnchorRow },
      evidence_holds,
      evidence_inbox_cursors,
      evidence_poll_jobs,
      consumed_closures,
      outbox,
      ack_history,
      next_created_order: config.next_created_order,
      storage_revision: config.storage_revision,
    };
  }

  private createSchema(): void {
    this.database.exec(`
      PRAGMA foreign_keys = ON;
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS player_local_config (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        protocol_version INTEGER NOT NULL CHECK (protocol_version > 0),
        purpose TEXT NOT NULL CHECK (length(purpose) > 0),
        manifest_digest TEXT NOT NULL CHECK (length(manifest_digest) > 0),
        scope_id TEXT NOT NULL CHECK (length(scope_id) > 0),
        unit_id TEXT NOT NULL CHECK (length(unit_id) > 0),
        genesis_digest TEXT NOT NULL CHECK (length(genesis_digest) > 0),
        outbox_capacity INTEGER NOT NULL CHECK (outbox_capacity >= 0),
        next_created_order INTEGER NOT NULL CHECK (next_created_order >= 0),
        storage_revision INTEGER NOT NULL CHECK (storage_revision >= 0)
      );
      CREATE TABLE IF NOT EXISTS player_local_events (
        author_id TEXT NOT NULL CHECK (length(author_id) > 0),
        counter INTEGER NOT NULL CHECK (counter >= 0),
        epoch INTEGER NOT NULL CHECK (epoch >= 0),
        event_digest TEXT NOT NULL CHECK (length(event_digest) > 0),
        canonical_event TEXT NOT NULL CHECK (length(canonical_event) > 0),
        PRIMARY KEY (author_id, counter)
      );
      CREATE TABLE IF NOT EXISTS player_local_equivocations (
        author_id TEXT NOT NULL,
        counter INTEGER NOT NULL,
        epoch INTEGER NOT NULL CHECK (epoch >= 0),
        conflicting_digest TEXT NOT NULL CHECK (length(conflicting_digest) > 0),
        canonical_event TEXT NOT NULL CHECK (length(canonical_event) > 0),
        PRIMARY KEY (author_id, counter, conflicting_digest),
        FOREIGN KEY (author_id, counter)
          REFERENCES player_local_events(author_id, counter)
      );
      CREATE TABLE IF NOT EXISTS player_local_checkpoints (
        epoch INTEGER PRIMARY KEY CHECK (epoch >= 0),
        previous_checkpoint TEXT NOT NULL CHECK (length(previous_checkpoint) > 0),
        checkpoint_digest TEXT NOT NULL CHECK (length(checkpoint_digest) > 0),
        canonical_envelope TEXT NOT NULL CHECK (length(canonical_envelope) > 0)
      );
      CREATE TABLE IF NOT EXISTS player_local_head (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        epoch INTEGER NOT NULL CHECK (epoch >= -1),
        checkpoint_digest TEXT NOT NULL CHECK (length(checkpoint_digest) > 0)
      );
      CREATE TABLE IF NOT EXISTS player_local_retention_anchor (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        epoch INTEGER NOT NULL CHECK (epoch >= -1),
        checkpoint_digest TEXT NOT NULL CHECK (length(checkpoint_digest) > 0)
      );
      CREATE TABLE IF NOT EXISTS player_local_evidence_holds (
        hold_id TEXT PRIMARY KEY CHECK (length(hold_id) > 0),
        epoch INTEGER NOT NULL CHECK (epoch >= 0),
        checkpoint_digest TEXT NOT NULL CHECK (length(checkpoint_digest) > 0),
        kind TEXT NOT NULL CHECK (kind IN ('fork', 'challenge', 'appeal')),
        reference_digest TEXT NOT NULL CHECK (length(reference_digest) > 0),
        state TEXT NOT NULL CHECK (state IN ('active', 'resolved')),
        decision TEXT CHECK (decision IN ('upheld', 'dismissed')),
        resolution_digest TEXT,
        FOREIGN KEY (epoch) REFERENCES player_local_checkpoints(epoch),
        CHECK (
          (state = 'active' AND decision IS NULL AND resolution_digest IS NULL)
          OR
          (state = 'resolved' AND decision IS NOT NULL AND
           resolution_digest IS NOT NULL AND length(resolution_digest) > 0)
        )
      );
      CREATE TABLE IF NOT EXISTS player_local_evidence_inbox_cursors (
        source_id TEXT PRIMARY KEY CHECK (length(source_id) > 0),
        sequence INTEGER NOT NULL CHECK (sequence >= 0),
        message_digest TEXT NOT NULL CHECK (length(message_digest) > 0)
      );
      CREATE TABLE IF NOT EXISTS player_local_evidence_poll_jobs (
        source_id TEXT PRIMARY KEY
          CHECK (length(source_id) > 0 AND length(source_id) <= 256),
        endpoint TEXT NOT NULL
          CHECK (length(endpoint) > 0 AND length(endpoint) <= 4096),
        initial_message_digest TEXT NOT NULL
          CHECK (length(initial_message_digest) > 0 AND
                 length(initial_message_digest) <= 4096),
        deadline_at_ms INTEGER NOT NULL CHECK (deadline_at_ms >= 0),
        next_poll_at_ms INTEGER NOT NULL
          CHECK (next_poll_at_ms >= 0 AND next_poll_at_ms <= deadline_at_ms),
        failures INTEGER NOT NULL CHECK (failures >= 0),
        attempt_count INTEGER NOT NULL CHECK (attempt_count >= 0),
        state TEXT NOT NULL
          CHECK (state IN ('scheduled', 'in_flight', 'expired', 'escalated')),
        lease_expires_at_ms INTEGER,
        expired_at_ms INTEGER,
        escalated_at_ms INTEGER,
        reason_digest TEXT,
        CHECK (
          (state = 'scheduled' AND lease_expires_at_ms IS NULL AND
           expired_at_ms IS NULL AND escalated_at_ms IS NULL AND
           reason_digest IS NULL)
          OR
          (state = 'in_flight' AND attempt_count > 0 AND
           lease_expires_at_ms IS NOT NULL AND lease_expires_at_ms >= 0 AND
           lease_expires_at_ms <= deadline_at_ms AND expired_at_ms IS NULL AND
           escalated_at_ms IS NULL AND reason_digest IS NULL)
          OR
          (state = 'expired' AND lease_expires_at_ms IS NULL AND
           expired_at_ms IS NOT NULL AND expired_at_ms >= deadline_at_ms AND
           escalated_at_ms IS NULL AND reason_digest IS NULL)
          OR
          (state = 'escalated' AND lease_expires_at_ms IS NULL AND
           expired_at_ms IS NULL AND escalated_at_ms IS NOT NULL AND
           escalated_at_ms >= 0 AND reason_digest IS NOT NULL AND
           length(reason_digest) > 0)
        )
      );
      CREATE INDEX IF NOT EXISTS player_local_evidence_poll_due
      ON player_local_evidence_poll_jobs(state, next_poll_at_ms);
      CREATE TABLE IF NOT EXISTS player_local_consumed_closures (
        epoch INTEGER PRIMARY KEY CHECK (epoch >= 0),
        roster_digest TEXT NOT NULL CHECK (length(roster_digest) > 0),
        frontier_digest TEXT NOT NULL CHECK (length(frontier_digest) > 0),
        certificate_digest TEXT NOT NULL CHECK (length(certificate_digest) > 0),
        FOREIGN KEY (epoch) REFERENCES player_local_checkpoints(epoch)
      );
      CREATE TABLE IF NOT EXISTS player_local_outbox (
        destination_id TEXT NOT NULL CHECK (length(destination_id) > 0),
        epoch INTEGER NOT NULL CHECK (epoch >= 0),
        checkpoint_digest TEXT NOT NULL CHECK (length(checkpoint_digest) > 0),
        canonical_envelope TEXT NOT NULL CHECK (length(canonical_envelope) > 0),
        created_order INTEGER NOT NULL UNIQUE CHECK (created_order >= 0),
        state TEXT NOT NULL CHECK (state IN ('pending', 'in_flight', 'acknowledged')),
        lease_expires_at_ms INTEGER,
        PRIMARY KEY (destination_id, epoch, checkpoint_digest),
        FOREIGN KEY (epoch) REFERENCES player_local_checkpoints(epoch),
        CHECK (
          (state = 'in_flight' AND lease_expires_at_ms IS NOT NULL AND lease_expires_at_ms >= 0)
          OR (state != 'in_flight' AND lease_expires_at_ms IS NULL)
        )
      );
      CREATE INDEX IF NOT EXISTS player_local_outbox_retry_order
      ON player_local_outbox(state, created_order);
      CREATE TABLE IF NOT EXISTS player_local_ack_history (
        authority_id TEXT NOT NULL CHECK (length(authority_id) > 0),
        epoch INTEGER NOT NULL CHECK (epoch >= 0),
        checkpoint_digest TEXT NOT NULL CHECK (length(checkpoint_digest) > 0),
        decision TEXT NOT NULL CHECK (decision IN ('accepted', 'duplicate')),
        PRIMARY KEY (authority_id, epoch, checkpoint_digest)
      );
    `);
  }

  private configure(configuration: PlayerLocalStoreConfiguration): void {
    this.transaction(() => {
      const existing = this.get<ConfigurationRow>(
        `SELECT protocol_version, purpose, manifest_digest, scope_id, unit_id,
                genesis_digest, outbox_capacity, next_created_order,
                storage_revision
         FROM player_local_config WHERE singleton = 1`,
      );
      if (existing) {
        if (
          !sameBoundary(
            this.boundaryFromRow(existing),
            configuration.boundary,
          ) ||
          existing.genesis_digest !== configuration.genesis_digest ||
          existing.outbox_capacity !== configuration.outbox_capacity
        ) {
          throw new PlayerLocalStoreCorruptError(
            "player-local database boundary/configuration conflict",
          );
        }
        this.run(
          `INSERT OR IGNORE INTO player_local_retention_anchor
           (singleton, epoch, checkpoint_digest) VALUES (1, -1, ?)`,
          existing.genesis_digest,
        );
        return;
      }
      const boundary = configuration.boundary;
      this.run(
        `INSERT INTO player_local_config
         (singleton, protocol_version, purpose, manifest_digest, scope_id,
          unit_id, genesis_digest, outbox_capacity, next_created_order,
          storage_revision)
         VALUES (1, ?, ?, ?, ?, ?, ?, ?, 0, 0)`,
        boundary.protocol_version,
        boundary.purpose,
        boundary.manifest_digest,
        boundary.scope_id,
        boundary.unit_id,
        configuration.genesis_digest,
        configuration.outbox_capacity,
      );
      this.run(
        `INSERT INTO player_local_head
         (singleton, epoch, checkpoint_digest) VALUES (1, -1, ?)`,
        configuration.genesis_digest,
      );
      this.run(
        `INSERT INTO player_local_retention_anchor
         (singleton, epoch, checkpoint_digest) VALUES (1, -1, ?)`,
        configuration.genesis_digest,
      );
    });
  }

  private writeSetValid(
    writeSet: PlayerLocalSealWriteSet,
    config: ConfigurationRow,
  ): boolean {
    const boundary = this.boundaryFromRow(config);
    const checkpoint = writeSet.checkpoint;
    const snapshot = writeSet.expected_snapshot;
    if (
      !isNonNegativeInteger(writeSet.expected_revision) ||
      !checkpointValid(boundary, checkpoint) ||
      !closureValid(boundary, writeSet.consumed_closure) ||
      checkpoint.epoch !== snapshot.current_epoch + 1 ||
      checkpoint.previous_checkpoint !== snapshot.current_digest ||
      writeSet.consumed_closure.epoch !== checkpoint.epoch ||
      !sameHead(writeSet.next_head, {
        boundary,
        epoch: checkpoint.epoch,
        checkpoint_digest: checkpoint.checkpoint_digest,
      }) ||
      writeSet.outbox_entries.length === 0 ||
      writeSet.next_outbox_entry_count !==
        snapshot.outbox_entry_count + writeSet.outbox_entries.length ||
      writeSet.next_outbox_entry_count > config.outbox_capacity ||
      writeSet.next_created_order !==
        snapshot.next_created_order + writeSet.outbox_entries.length ||
      !Number.isSafeInteger(writeSet.next_created_order)
    ) {
      return false;
    }
    const destinations = new Set<string>();
    for (const [index, entry] of writeSet.outbox_entries.entries()) {
      if (
        !sameBoundary(boundary, entry.boundary) ||
        entry.destination_id.length === 0 ||
        destinations.has(entry.destination_id) ||
        entry.epoch !== checkpoint.epoch ||
        entry.checkpoint_digest !== checkpoint.checkpoint_digest ||
        entry.canonical_envelope !== checkpoint.canonical_envelope ||
        entry.created_order !== snapshot.next_created_order + index ||
        entry.state.kind !== "pending"
      ) {
        return false;
      }
      destinations.add(entry.destination_id);
    }
    return true;
  }

  private sealSnapshot(
    checkpoint: CheckpointSealDraft,
    destinations: string[],
  ): CheckpointSealStorageSnapshot {
    const config = this.configuration();
    const boundary = this.boundaryFromRow(config);
    const head = this.get<HeadRow>(
      `SELECT epoch, checkpoint_digest FROM player_local_head
       WHERE singleton = 1`,
    );
    if (!head) throw new PlayerLocalStoreCorruptError("missing local head");
    const known = this.get<CheckpointRow>(
      `SELECT epoch, previous_checkpoint, checkpoint_digest, canonical_envelope
       FROM player_local_checkpoints WHERE epoch = ?`,
      checkpoint.epoch,
    );
    const closureConsumed = this.get<{ present: number }>(
      `SELECT 1 AS present FROM player_local_consumed_closures WHERE epoch = ?`,
      checkpoint.epoch,
    ) !== undefined;
    const allOutboxPresent =
      destinations.length > 0 &&
      destinations.every(
        (destination) =>
          this.get<{ present: number }>(
            `SELECT 1 AS present FROM player_local_outbox
             WHERE destination_id = ? AND epoch = ? AND checkpoint_digest = ?
               AND canonical_envelope = ?`,
            destination,
            checkpoint.epoch,
            checkpoint.checkpoint_digest,
            checkpoint.canonical_envelope,
          ) !== undefined,
      );
    const knownDigestMatches =
      known?.checkpoint_digest === checkpoint.checkpoint_digest;
    return {
      boundary,
      current_epoch: head.epoch,
      current_digest: head.checkpoint_digest,
      incoming_epoch_known: known !== undefined,
      known_digest_matches: knownDigestMatches,
      known_seal_complete:
        knownDigestMatches && closureConsumed && allOutboxPresent,
      closure_consumed: closureConsumed,
      outbox_entry_count: this.activeOutboxCount(),
      outbox_capacity: config.outbox_capacity,
      next_created_order: config.next_created_order,
    };
  }

  private assertValidImage(): void {
    let image: PlayerLocalAuditImage;
    try {
      image = this.image();
    } catch (error) {
      if (error instanceof PlayerLocalStoreCorruptError) throw error;
      throw new PlayerLocalStoreCorruptError(String(error));
    }
    const reason = playerLocalAuditImageError(image);
    if (reason) throw new PlayerLocalStoreCorruptError(reason);
  }

  private eventFromRow(
    boundary: AuditBoundary,
    row: EventRow,
  ): PlayerLocalAuditEvent {
    return { boundary, ...row };
  }

  private outboxRecord(
    row: OutboxRow,
    boundary: AuditBoundary,
  ): PlayerLocalCheckpointOutboxRecord {
    let state: CheckpointOutboxState;
    if (row.state === "pending") {
      state = { kind: "pending" };
    } else if (row.state === "acknowledged") {
      state = { kind: "acknowledged" };
    } else {
      if (row.lease_expires_at_ms === null) {
        throw new PlayerLocalStoreCorruptError("in-flight lease missing");
      }
      state = {
        kind: "in_flight",
        lease_expires_at_ms: row.lease_expires_at_ms,
      };
    }
    return {
      boundary,
      destination_id: row.destination_id,
      epoch: row.epoch,
      checkpoint_digest: row.checkpoint_digest,
      canonical_envelope: row.canonical_envelope,
      created_order: row.created_order,
      state,
    };
  }

  private outboxAt(createdOrder: number): OutboxRow | undefined {
    return this.get<OutboxRow>(
      `SELECT destination_id, epoch, checkpoint_digest, canonical_envelope,
              created_order, state, lease_expires_at_ms
       FROM player_local_outbox WHERE created_order = ?`,
      createdOrder,
    );
  }

  private evidenceHoldRow(holdId: string): EvidenceHoldRow | undefined {
    return this.get<EvidenceHoldRow>(
      `SELECT hold_id, epoch, checkpoint_digest, kind, reference_digest, state,
              decision, resolution_digest
       FROM player_local_evidence_holds WHERE hold_id = ?`,
      holdId,
    );
  }

  private evidencePollJobRow(sourceId: string): EvidencePollJobRow | undefined {
    return this.get<EvidencePollJobRow>(
      `SELECT source_id, endpoint, initial_message_digest, deadline_at_ms,
              next_poll_at_ms, failures, attempt_count, state,
              lease_expires_at_ms, expired_at_ms, escalated_at_ms, reason_digest
       FROM player_local_evidence_poll_jobs WHERE source_id = ?`,
      sourceId,
    );
  }

  private evidencePollJob(
    row: EvidencePollJobRow,
    boundary: AuditBoundary,
  ): PlayerLocalEvidencePollJob {
    let state: PlayerLocalEvidencePollJob["state"];
    if (row.state === "scheduled") {
      state = { kind: "scheduled" };
    } else if (row.state === "in_flight") {
      if (row.lease_expires_at_ms === null) {
        throw new PlayerLocalStoreCorruptError("poll lease missing");
      }
      state = {
        kind: "in_flight",
        lease_expires_at_ms: row.lease_expires_at_ms,
      };
    } else if (row.state === "expired") {
      if (row.expired_at_ms === null) {
        throw new PlayerLocalStoreCorruptError("poll expiry missing");
      }
      state = { kind: "expired", expired_at_ms: row.expired_at_ms };
    } else {
      if (row.escalated_at_ms === null || row.reason_digest === null) {
        throw new PlayerLocalStoreCorruptError("poll escalation missing");
      }
      state = {
        kind: "escalated",
        escalated_at_ms: row.escalated_at_ms,
        reason_digest: row.reason_digest,
      };
    }
    return {
      boundary,
      source_id: row.source_id,
      endpoint: row.endpoint,
      initial_message_digest: row.initial_message_digest,
      deadline_at_ms: row.deadline_at_ms,
      next_poll_at_ms: row.next_poll_at_ms,
      failures: row.failures,
      attempt_count: row.attempt_count,
      state,
    };
  }

  private sameEvidenceHoldIdentity(
    row: EvidenceHoldRow,
    hold: PlayerLocalEvidenceHold,
  ): boolean {
    return row.epoch === hold.epoch &&
      row.checkpoint_digest === hold.checkpoint_digest &&
      row.kind === hold.kind &&
      row.reference_digest === hold.reference_digest;
  }

  private boundary(): AuditBoundary {
    return this.boundaryFromRow(this.configuration());
  }

  private boundaryFromRow(row: ConfigurationRow): AuditBoundary {
    return {
      protocol_version: row.protocol_version,
      purpose: row.purpose,
      manifest_digest: row.manifest_digest,
      scope_id: row.scope_id,
      unit_id: row.unit_id,
    };
  }

  private configuration(): ConfigurationRow {
    const row = this.get<ConfigurationRow>(
      `SELECT protocol_version, purpose, manifest_digest, scope_id, unit_id,
              genesis_digest, outbox_capacity, next_created_order,
              storage_revision
       FROM player_local_config WHERE singleton = 1`,
    );
    if (!row) throw new PlayerLocalStoreCorruptError("missing configuration");
    return row;
  }

  private incrementRevision(): void {
    const changed = this.run(
      `UPDATE player_local_config
       SET storage_revision = storage_revision + 1 WHERE singleton = 1`,
    );
    if (changed !== 1) throw new PlayerLocalStoreCorruptError();
  }

  private activeOutboxCount(): number {
    return this.get<{ count: number }>(
      `SELECT COUNT(*) AS count FROM player_local_outbox
       WHERE state != 'acknowledged'`,
    )?.count ?? 0;
  }

  private inject(
    requested: PlayerLocalSealFaultPoint | undefined,
    current: PlayerLocalSealFaultPoint,
  ): void {
    if (requested === current) throw new InjectedPlayerLocalSealFault(current);
  }

  private injectPrune(
    requested: PlayerLocalPruneFaultPoint | undefined,
    current: PlayerLocalPruneFaultPoint,
  ): void {
    if (requested === current) throw new InjectedPlayerLocalPruneFault(current);
  }

  private injectEvidenceInbox(
    requested: PlayerLocalEvidenceInboxFaultPoint | undefined,
    current: PlayerLocalEvidenceInboxFaultPoint,
  ): void {
    if (requested === current) {
      throw new InjectedPlayerLocalEvidenceInboxFault(current);
    }
  }

  private transaction<T>(operation: () => T): T {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const result = operation();
      this.database.exec("COMMIT");
      return result;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  private get<Row>(sql: string, ...parameters: SQLInputValue[]): Row | undefined {
    return this.database.prepare(sql).get(...parameters) as Row | undefined;
  }

  private all<Row>(sql: string, ...parameters: SQLInputValue[]): Row[] {
    return this.database.prepare(sql).all(...parameters) as Row[];
  }

  private run(sql: string, ...parameters: SQLInputValue[]): number {
    return Number(this.database.prepare(sql).run(...parameters).changes);
  }
}
