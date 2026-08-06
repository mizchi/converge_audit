import {
  playerLocalAuditImageError,
  playerLocalPruneWriteSetValid,
  playerLocalSealSnapshot,
  playerLocalSealWriteSetValid,
  type AuditBoundary,
  type CheckpointSealDraft,
  type EpochClosureEvidence,
  type PlayerLocalAuditImage,
  type PlayerLocalPruneRequest,
  type PlayerLocalPruneWriteSet,
  type PlayerLocalSealWriteSet,
} from "./contracts.ts";

type AuditModule = typeof import(
  "../../_build/js/release/build/audit/runtime/bridge/bridge.js"
);

let loadedModule: Promise<AuditModule> | undefined;

const MOONBIT_INT_MIN = -2_147_483_648;
const MOONBIT_INT_MAX = 2_147_483_647;

function moonBitRelativeTime(
  absoluteMs: number,
  originMs: number,
): number | undefined {
  if (
    !Number.isSafeInteger(absoluteMs) ||
    !Number.isSafeInteger(originMs) ||
    absoluteMs < 0 ||
    originMs < 0
  ) return undefined;
  const delta = absoluteMs - originMs;
  if (!Number.isSafeInteger(delta)) return undefined;
  return Math.max(MOONBIT_INT_MIN, Math.min(MOONBIT_INT_MAX, delta));
}

function moonBitDuration(value: number): number | undefined {
  return Number.isSafeInteger(value) && value > 0 && value <= MOONBIT_INT_MAX
    ? value
    : undefined;
}

function loadAuditModule(): Promise<AuditModule> {
  loadedModule ??= import(
    "../../_build/js/release/build/audit/runtime/bridge/bridge.js"
  );
  return loadedModule;
}

export type CheckpointHeadDecision =
  | "advance"
  | "duplicate"
  | "same_epoch_fork"
  | "wrong_parent_fork"
  | "gap"
  | "stale"
  | "boundary_rejected";

export interface PreparedCheckpointOutboxEntry {
  destination_id: string;
  epoch: number;
  checkpoint_digest: string;
  canonical_envelope: string;
  created_order: number;
}

export type AtomicCheckpointSealPreparation =
  | {
      decision: "prepared";
      epoch: number;
      digest: string;
      closure_epoch: number;
      next_outbox_entry_count: number;
      next_created_order: number;
      outbox: PreparedCheckpointOutboxEntry[];
    }
  | { decision: "duplicate" }
  | { decision: "conflict" | "refused"; reason: string };

export interface PrepareCheckpointSealInput {
  boundary: AuditBoundary;
  closure: {
    epoch: number;
    roster_digest: string;
    frontier_digest: string;
    certificate_digest: string;
  };
  current_epoch: number;
  current_digest: string;
  incoming_epoch_known: boolean;
  known_digest_matches: boolean;
  known_seal_complete: boolean;
  closure_consumed: boolean;
  outbox_entry_count: number;
  outbox_capacity: number;
  next_created_order: number;
  checkpoint_epoch: number;
  previous_checkpoint: string;
  checkpoint_digest: string;
  canonical_envelope: string;
  destinations: string[];
}

export interface AcknowledgeCheckpointOutboxInput {
  boundary: AuditBoundary;
  destination_id: string;
  epoch: number;
  checkpoint_digest: string;
  canonical_envelope: string;
  created_order: number;
  ack_boundary: AuditBoundary;
  ack_authority_id: string;
  ack_epoch: number;
  ack_checkpoint_digest: string;
  ack_decision: "accepted" | "duplicate";
  authentication_succeeded: boolean;
}

export type PlayerLocalSealWriteSetPreparation =
  | { decision: "prepared"; write_set: PlayerLocalSealWriteSet }
  | { decision: "duplicate" }
  | { decision: "conflict" | "refused"; reason: string };

export type PlayerLocalPruneWriteSetPreparation =
  | { decision: "prepared"; write_set: PlayerLocalPruneWriteSet }
  | {
      decision: "no_change";
      reason: "retention_window" | "protected_epoch" | "unacknowledged";
    }
  | { decision: "refused"; reason: string };

/** Typed host wrapper around the generic proof-facing checkpoint bridge. */
export class MoonBitCheckpointPolicy {
  private readonly module: AuditModule;

  static async load(): Promise<MoonBitCheckpointPolicy> {
    return new MoonBitCheckpointPolicy(await loadAuditModule());
  }

  private constructor(module: AuditModule) {
    this.module = module;
  }

  classifyHead(input: {
    boundary_matches: boolean;
    epoch_known: boolean;
    known_digest_matches: boolean;
    current_epoch: number;
    incoming_epoch: number;
    parent_matches: boolean;
  }): CheckpointHeadDecision {
    return this.module.audit_classify_checkpoint_head(
      input.boundary_matches,
      input.epoch_known,
      input.known_digest_matches,
      input.current_epoch,
      input.incoming_epoch,
      input.parent_matches,
    ) as CheckpointHeadDecision;
  }

  prepareSeal(
    input: PrepareCheckpointSealInput,
  ): AtomicCheckpointSealPreparation {
    const boundary = input.boundary;
    const closure = input.closure;
    return JSON.parse(
      this.module.audit_prepare_atomic_checkpoint_seal(
        boundary.protocol_version,
        boundary.purpose,
        boundary.manifest_digest,
        boundary.scope_id,
        boundary.unit_id,
        closure.epoch,
        closure.roster_digest,
        closure.frontier_digest,
        closure.certificate_digest,
        input.current_epoch,
        input.current_digest,
        input.incoming_epoch_known,
        input.known_digest_matches,
        input.known_seal_complete,
        input.closure_consumed,
        input.outbox_entry_count,
        input.outbox_capacity,
        input.next_created_order,
        input.checkpoint_epoch,
        input.previous_checkpoint,
        input.checkpoint_digest,
        input.canonical_envelope,
        input.destinations,
      ),
    ) as AtomicCheckpointSealPreparation;
  }

  prepareWriteSet(
    image: PlayerLocalAuditImage,
    checkpoint: CheckpointSealDraft,
    closure: EpochClosureEvidence,
    destinations: string[],
  ): PlayerLocalSealWriteSetPreparation {
    const snapshot = playerLocalSealSnapshot(image, checkpoint, destinations);
    const prepared = this.prepareSeal({
      boundary: image.boundary,
      closure,
      current_epoch: snapshot.current_epoch,
      current_digest: snapshot.current_digest,
      incoming_epoch_known: snapshot.incoming_epoch_known,
      known_digest_matches: snapshot.known_digest_matches,
      known_seal_complete: snapshot.known_seal_complete,
      closure_consumed: snapshot.closure_consumed,
      outbox_entry_count: snapshot.outbox_entry_count,
      outbox_capacity: snapshot.outbox_capacity,
      next_created_order: snapshot.next_created_order,
      checkpoint_epoch: checkpoint.epoch,
      previous_checkpoint: checkpoint.previous_checkpoint,
      checkpoint_digest: checkpoint.checkpoint_digest,
      canonical_envelope: checkpoint.canonical_envelope,
      destinations,
    });
    if (prepared.decision !== "prepared") return prepared;
    if (
      prepared.epoch !== checkpoint.epoch ||
      prepared.digest !== checkpoint.checkpoint_digest ||
      prepared.closure_epoch !== closure.epoch
    ) return { decision: "refused", reason: "bridge_boundary_mismatch" };
    const write_set: PlayerLocalSealWriteSet = {
      expected_revision: image.storage_revision,
      expected_snapshot: snapshot,
      checkpoint,
      next_head: {
        boundary: image.boundary,
        epoch: prepared.epoch,
        checkpoint_digest: prepared.digest,
      },
      outbox_entries: prepared.outbox.map((entry) => ({
        boundary: image.boundary,
        ...entry,
        state: { kind: "pending" },
      })),
      consumed_closure: closure,
      next_outbox_entry_count: prepared.next_outbox_entry_count,
      next_created_order: prepared.next_created_order,
    };
    return playerLocalSealWriteSetValid(
        {
          boundary: image.boundary,
          genesis_digest: image.genesis_digest,
          outbox_capacity: image.outbox_capacity,
        },
        write_set,
      )
      ? { decision: "prepared", write_set }
      : { decision: "refused", reason: "bridge_write_set_invalid" };
  }

  preparePruneWriteSet(
    image: PlayerLocalAuditImage,
    request: PlayerLocalPruneRequest,
  ): PlayerLocalPruneWriteSetPreparation {
    const imageError = playerLocalAuditImageError(image);
    if (imageError) {
      return { decision: "refused", reason: `invalid_image:${imageError}` };
    }
    if (
      !Number.isSafeInteger(request.retain_from_epoch) ||
      request.retain_from_epoch < 0 ||
      request.retain_from_epoch > image.head.epoch + 1 ||
      request.protected_epochs.some((epoch) =>
        !Number.isSafeInteger(epoch) || epoch < 0
      )
    ) return { decision: "refused", reason: "invalid_prune_request" };

    const protected_epochs = [...new Set(request.protected_epochs)]
      .sort((left, right) => left - right);
    if (protected_epochs.some((epoch) => epoch <= image.retention_anchor.epoch)) {
      return {
        decision: "refused",
        reason: "protected_epoch_already_pruned",
      };
    }
    const protectedSet = new Set(protected_epochs);
    for (const hold of image.evidence_holds) {
      if (hold.state.kind === "active") protectedSet.add(hold.epoch);
    }
    const equivocationEpochs = new Set(
      image.equivocations.flatMap((evidence) => [
        evidence.accepted.epoch,
        evidence.conflicting.epoch,
      ]),
    );
    let nextAnchor = image.retention_anchor;
    let stopReason: "retention_window" | "protected_epoch" | "unacknowledged" =
      "retention_window";
    for (const checkpoint of image.checkpoints) {
      if (checkpoint.epoch >= request.retain_from_epoch) {
        stopReason = "retention_window";
        break;
      }
      const unresolvedReference = protectedSet.has(checkpoint.epoch) ||
        equivocationEpochs.has(checkpoint.epoch);
      const outbox = image.outbox.filter((entry) =>
        entry.epoch === checkpoint.epoch &&
        entry.checkpoint_digest === checkpoint.checkpoint_digest
      );
      const allOutboxAcknowledged = outbox.length > 0 &&
        outbox.every((entry) => entry.state.kind === "acknowledged");
      const prunable = this.module.audit_player_local_checkpoint_prunable(
        checkpoint.epoch,
        nextAnchor.epoch,
        request.retain_from_epoch,
        allOutboxAcknowledged,
        unresolvedReference,
      );
      if (!prunable) {
        stopReason = unresolvedReference ? "protected_epoch" : "unacknowledged";
        break;
      }
      nextAnchor = {
        boundary: image.boundary,
        epoch: checkpoint.epoch,
        checkpoint_digest: checkpoint.checkpoint_digest,
      };
    }
    if (nextAnchor.epoch === image.retention_anchor.epoch) {
      return { decision: "no_change", reason: stopReason };
    }
    const write_set: PlayerLocalPruneWriteSet = {
      expected_revision: image.storage_revision,
      expected_anchor: image.retention_anchor,
      next_anchor: nextAnchor,
      retain_from_epoch: request.retain_from_epoch,
      protected_epochs,
    };
    return playerLocalPruneWriteSetValid(image, write_set)
      ? { decision: "prepared", write_set }
      : { decision: "refused", reason: "bridge_prune_write_set_invalid" };
  }

  evidenceHoldAdmissionAllowed(input: {
    boundary_matches: boolean;
    checkpoint_matches: boolean;
    authentication_succeeded: boolean;
  }): boolean {
    return this.module.audit_player_local_evidence_hold_admission_allowed(
      input.boundary_matches,
      input.checkpoint_matches,
      input.authentication_succeeded,
    );
  }

  evidenceHoldResolutionAllowed(input: {
    boundary_matches: boolean;
    epoch_matches: boolean;
    checkpoint_matches: boolean;
    reference_matches: boolean;
    active: boolean;
    authentication_succeeded: boolean;
  }): boolean {
    return this.module.audit_player_local_evidence_hold_resolution_allowed(
      input.boundary_matches,
      input.epoch_matches,
      input.checkpoint_matches,
      input.reference_matches,
      input.active,
      input.authentication_succeeded,
    );
  }

  evidenceInboxAdvanceAllowed(input: {
    current_sequence: number;
    next_sequence: number;
    previous_digest_matches: boolean;
    message_digest_advances: boolean;
    authentication_succeeded: boolean;
    operation_allowed: boolean;
  }): boolean {
    return this.module.audit_player_local_evidence_inbox_advance_allowed(
      input.current_sequence,
      input.next_sequence,
      input.previous_digest_matches,
      input.message_digest_advances,
      input.authentication_succeeded,
      input.operation_allowed,
    );
  }

  evidenceInboxPageAllowed(input: {
    received_at_ms: number;
    deadline_at_ms: number;
    message_count: number;
    max_messages: number;
    response_bytes: number;
    max_response_bytes: number;
    source_matches: boolean;
    cursor_matches: boolean;
  }): boolean {
    const relativeDeadline = moonBitRelativeTime(
      input.deadline_at_ms,
      input.received_at_ms,
    );
    if (relativeDeadline === undefined || relativeDeadline <= 0) return false;
    return this.module.audit_player_local_evidence_inbox_page_allowed(
      0,
      relativeDeadline,
      input.message_count,
      input.max_messages,
      input.response_bytes,
      input.max_response_bytes,
      input.source_matches,
      input.cursor_matches,
    );
  }

  evidencePollClaimAllowed(input: {
    now_ms: number;
    deadline_at_ms: number;
    next_poll_at_ms: number;
    lease_available: boolean;
  }): boolean {
    const relativeDeadline = moonBitRelativeTime(
      input.deadline_at_ms,
      input.now_ms,
    );
    const relativeNextPoll = moonBitRelativeTime(
      input.next_poll_at_ms,
      input.now_ms,
    );
    if (relativeDeadline === undefined || relativeNextPoll === undefined) {
      return false;
    }
    return this.module.audit_player_local_evidence_poll_claim_allowed(
      0,
      relativeDeadline,
      relativeNextPoll,
      input.lease_available,
    );
  }

  evidencePollLeaseExpiry(input: {
    now_ms: number;
    deadline_at_ms: number;
    lease_duration_ms: number;
  }): number {
    const relativeDeadline = moonBitRelativeTime(
      input.deadline_at_ms,
      input.now_ms,
    );
    const leaseDuration = moonBitDuration(input.lease_duration_ms);
    if (
      relativeDeadline === undefined ||
      relativeDeadline <= 0 ||
      leaseDuration === undefined
    ) return -1;
    const relativeExpiry =
      this.module.audit_player_local_evidence_poll_lease_expiry(
        0,
        relativeDeadline,
        leaseDuration,
      );
    const absoluteExpiry = input.now_ms + relativeExpiry;
    return relativeExpiry > 0 && Number.isSafeInteger(absoluteExpiry)
      ? absoluteExpiry
      : -1;
  }

  evidencePollNextRetryAt(input: {
    now_ms: number;
    deadline_at_ms: number;
    failures: number;
    base_backoff_ms: number;
    max_backoff_ms: number;
  }): number {
    const relativeDeadline = moonBitRelativeTime(
      input.deadline_at_ms,
      input.now_ms,
    );
    const baseBackoff = moonBitDuration(input.base_backoff_ms);
    const maxBackoff = moonBitDuration(input.max_backoff_ms);
    if (
      relativeDeadline === undefined ||
      relativeDeadline <= 0 ||
      baseBackoff === undefined ||
      maxBackoff === undefined ||
      maxBackoff < baseBackoff ||
      !Number.isSafeInteger(input.failures) ||
      input.failures < 0
    ) return -1;
    const relativeRetry =
      this.module.audit_player_local_evidence_poll_next_retry_at(
        0,
        relativeDeadline,
        Math.min(input.failures, MOONBIT_INT_MAX),
        baseBackoff,
        maxBackoff,
      );
    const absoluteRetry = input.now_ms + relativeRetry;
    return relativeRetry > 0 && Number.isSafeInteger(absoluteRetry)
      ? absoluteRetry
      : -1;
  }

  acknowledgeOutbox(input: AcknowledgeCheckpointOutboxInput): string {
    const boundary = input.boundary;
    const ackBoundary = input.ack_boundary;
    return this.module.audit_acknowledge_checkpoint_outbox(
      boundary.protocol_version,
      boundary.purpose,
      boundary.manifest_digest,
      boundary.scope_id,
      boundary.unit_id,
      input.destination_id,
      input.epoch,
      input.checkpoint_digest,
      input.canonical_envelope,
      input.created_order,
      ackBoundary.protocol_version,
      ackBoundary.purpose,
      ackBoundary.manifest_digest,
      ackBoundary.scope_id,
      ackBoundary.unit_id,
      input.ack_authority_id,
      input.ack_epoch,
      input.ack_checkpoint_digest,
      input.ack_decision,
      input.authentication_succeeded,
    );
  }
}
