import {
  samePlayerLocalBoundary,
  type CheckpointSealDraft,
  type EpochClosureEvidence,
  type PlayerLocalAuditImage,
  type PlayerLocalEvidenceHold,
  type PlayerLocalEvidenceHoldAdmission,
  type PlayerLocalEvidenceHoldResolution,
  type PlayerLocalEvidenceHoldResolutionResult,
  type PlayerLocalEvidenceInboxApplyResult,
  type PlayerLocalEvidencePollJobAdmission,
  type PlayerLocalEvidencePollJobClaimResult,
  type PlayerLocalEvidencePollJobCompletion,
  type PlayerLocalEvidencePollJobCompletionResult,
  type PlayerLocalEvidencePollJobDraft,
  type PlayerLocalEvidencePollJobEscalationResult,
  type PlayerLocalPruneRequest,
  type PlayerLocalPruneResult,
  type PlayerLocalStoreConfiguration,
} from "../../../../player-local-runtime/contracts.ts";
import {
  decodePlayerLocalEvidenceHoldEnvelope,
  playerLocalEvidenceHoldEnvelopeStatement,
  type PlayerLocalEvidenceHoldAuthenticator,
} from "../../../../player-local-runtime/evidence-hold-wire.ts";
import {
  MoonBitCheckpointPolicy,
} from "../../../../player-local-runtime/moonbit-checkpoint-policy.ts";
import { IndexedDbPlayerLocalStore } from "./player-local-indexeddb.ts";

export type PlayerLocalCheckpointSealResult =
  | { decision: "committed" | "duplicate" }
  | { decision: "concurrent_write" | "conflict" | "refused"; reason: string };

export type PlayerLocalEvidenceHoldIngestResult =
  | PlayerLocalEvidenceInboxApplyResult
  | { decision: "no_change" }
  | { decision: "refused"; reason: string };

export class BrowserPlayerLocalCheckpointRuntime {
  static async open(input: {
    factory: IDBFactory;
    databaseName: string;
    configuration: PlayerLocalStoreConfiguration;
  }): Promise<BrowserPlayerLocalCheckpointRuntime> {
    const [store, policy] = await Promise.all([
      IndexedDbPlayerLocalStore.open(
        input.factory,
        input.databaseName,
        input.configuration,
      ),
      MoonBitCheckpointPolicy.load(),
    ]);
    return new BrowserPlayerLocalCheckpointRuntime(store, policy);
  }

  private readonly store: IndexedDbPlayerLocalStore;
  private readonly policy: MoonBitCheckpointPolicy;

  private constructor(
    store: IndexedDbPlayerLocalStore,
    policy: MoonBitCheckpointPolicy,
  ) {
    this.store = store;
    this.policy = policy;
  }

  async seal(
    checkpoint: CheckpointSealDraft,
    closure: EpochClosureEvidence,
    destinations: string[],
  ): Promise<PlayerLocalCheckpointSealResult> {
    const image = await this.store.image();
    const prepared = this.policy.prepareWriteSet(
      image,
      checkpoint,
      closure,
      destinations,
    );
    if (prepared.decision === "duplicate") return prepared;
    if (prepared.decision !== "prepared") return prepared;
    const committed = await this.store.commitSeal(prepared.write_set);
    if (committed.decision === "refused") return committed;
    if (committed.decision === "concurrent_write") {
      return { decision: "concurrent_write", reason: "storage_revision_changed" };
    }
    return { decision: "committed" };
  }

  async acknowledge(input: {
    authorityId: string;
    checkpointDigest: string;
    decision: "accepted" | "duplicate";
    authenticationSucceeded: boolean;
  }): Promise<"acknowledged" | "already_acknowledged" | "not_found"> {
    const image = await this.store.image();
    const entry = image.outbox.find((candidate) =>
      candidate.destination_id === input.authorityId &&
      candidate.checkpoint_digest === input.checkpointDigest
    );
    if (!entry) return "not_found";
    const policyDecision = this.policy.acknowledgeOutbox({
      boundary: image.boundary,
      destination_id: entry.destination_id,
      epoch: entry.epoch,
      checkpoint_digest: entry.checkpoint_digest,
      canonical_envelope: entry.canonical_envelope,
      created_order: entry.created_order,
      ack_boundary: image.boundary,
      ack_authority_id: input.authorityId,
      ack_epoch: entry.epoch,
      ack_checkpoint_digest: input.checkpointDigest,
      ack_decision: input.decision,
      authentication_succeeded: input.authenticationSucceeded,
    });
    if (policyDecision === "already_acknowledged") {
      return "already_acknowledged";
    }
    if (policyDecision !== "acknowledged") {
      throw new Error(`checkpoint ACK policy refused: ${policyDecision}`);
    }
    const stored = await this.store.acknowledgeOutbox({
      boundary: image.boundary,
      authority_id: input.authorityId,
      epoch: entry.epoch,
      checkpoint_digest: input.checkpointDigest,
      decision: input.decision,
    });
    if (stored.decision === "updated") return "acknowledged";
    if (stored.decision === "no_change") return "already_acknowledged";
    const reason = "reason" in stored ? stored.reason : "unexpected_decision";
    throw new Error(`checkpoint ACK storage refused: ${reason}`);
  }

  async placeEvidenceHold(input: {
    hold: PlayerLocalEvidenceHold;
    authenticationSucceeded: boolean;
  }): Promise<PlayerLocalEvidenceHoldAdmission> {
    const image = await this.store.image();
    const checkpoint = image.checkpoints.find((candidate) =>
      candidate.epoch === input.hold.epoch
    );
    const allowed = this.policy.evidenceHoldAdmissionAllowed({
      boundary_matches: samePlayerLocalBoundary(
        image.boundary,
        input.hold.boundary,
      ),
      checkpoint_matches: checkpoint?.checkpoint_digest ===
        input.hold.checkpoint_digest,
      authentication_succeeded: input.authenticationSucceeded,
    });
    if (!allowed) return { decision: "refused", reason: "policy_rejected" };
    return this.store.placeEvidenceHold(input.hold);
  }

  async resolveEvidenceHold(input: {
    resolution: PlayerLocalEvidenceHoldResolution;
    authenticationSucceeded: boolean;
  }): Promise<PlayerLocalEvidenceHoldResolutionResult> {
    const image = await this.store.image();
    const hold = image.evidence_holds.find((candidate) =>
      candidate.hold_id === input.resolution.hold_id
    );
    const allowed = this.policy.evidenceHoldResolutionAllowed({
      boundary_matches: samePlayerLocalBoundary(
        image.boundary,
        input.resolution.boundary,
      ),
      epoch_matches: hold?.epoch === input.resolution.epoch,
      checkpoint_matches: hold?.checkpoint_digest ===
        input.resolution.checkpoint_digest,
      reference_matches: hold?.reference_digest ===
        input.resolution.reference_digest,
      active: hold?.state.kind === "active",
      authentication_succeeded: input.authenticationSucceeded,
    });
    if (!allowed) return { decision: "refused", reason: "policy_rejected" };
    return this.store.resolveEvidenceHold(input.resolution);
  }

  async ingestEvidenceHoldEnvelope(input: {
    envelope: unknown;
    expectedSourceId: string;
    initialMessageDigest: string;
    authenticator: PlayerLocalEvidenceHoldAuthenticator;
  }): Promise<PlayerLocalEvidenceHoldIngestResult> {
    if (
      input.initialMessageDigest.length === 0 ||
      input.initialMessageDigest.length > 4_096
    ) return { decision: "refused", reason: "invalid_initial_cursor" };
    const image = await this.store.image();
    const decoded = decodePlayerLocalEvidenceHoldEnvelope(
      input.envelope,
      image.boundary,
      input.expectedSourceId,
    );
    if (!decoded.ok) {
      return { decision: "refused", reason: decoded.reason };
    }
    let authenticated = false;
    try {
      authenticated = await input.authenticator.verify({
        source_id: decoded.envelope.source_id,
        canonical_statement: playerLocalEvidenceHoldEnvelopeStatement(
          decoded.envelope,
        ),
        message_digest: decoded.envelope.message_digest,
        authentication: decoded.envelope.authentication,
      });
    } catch {
      authenticated = false;
    }
    const storedCursor = image.evidence_inbox_cursors.find((cursor) =>
      cursor.source_id === input.expectedSourceId
    );
    const expectedCursor = storedCursor ?? {
      boundary: image.boundary,
      source_id: input.expectedSourceId,
      sequence: -1,
      message_digest: input.initialMessageDigest,
    };
    if (
      decoded.envelope.sequence === expectedCursor.sequence &&
      decoded.envelope.message_digest === expectedCursor.message_digest
    ) {
      return authenticated
        ? { decision: "no_change" }
        : { decision: "refused", reason: "authentication_failed" };
    }

    const operation = decoded.envelope.operation;
    let operationAllowed: boolean;
    if (operation.kind === "place") {
      const checkpoint = image.checkpoints.find((candidate) =>
        candidate.epoch === operation.hold.epoch
      );
      const existing = image.evidence_holds.find((hold) =>
        hold.hold_id === operation.hold.hold_id
      );
      const existingAllowsPlace = !existing ||
        (existing.epoch === operation.hold.epoch &&
          existing.checkpoint_digest === operation.hold.checkpoint_digest &&
          existing.kind === operation.hold.kind &&
          existing.reference_digest === operation.hold.reference_digest &&
          existing.state.kind === "active");
      operationAllowed = existingAllowsPlace &&
        this.policy.evidenceHoldAdmissionAllowed({
          boundary_matches: samePlayerLocalBoundary(
            image.boundary,
            operation.hold.boundary,
          ),
          checkpoint_matches: checkpoint?.checkpoint_digest ===
            operation.hold.checkpoint_digest,
          authentication_succeeded: true,
        });
    } else {
      const hold = image.evidence_holds.find((candidate) =>
        candidate.hold_id === operation.resolution.hold_id
      );
      const alreadyResolved = hold?.epoch === operation.resolution.epoch &&
        hold.checkpoint_digest === operation.resolution.checkpoint_digest &&
        hold.reference_digest === operation.resolution.reference_digest &&
        hold.state.kind === "resolved" &&
        hold.state.decision === operation.resolution.decision &&
        hold.state.resolution_digest ===
          operation.resolution.resolution_digest;
      operationAllowed = alreadyResolved ||
        this.policy.evidenceHoldResolutionAllowed({
          boundary_matches: samePlayerLocalBoundary(
            image.boundary,
            operation.resolution.boundary,
          ),
          epoch_matches: hold?.epoch === operation.resolution.epoch,
          checkpoint_matches: hold?.checkpoint_digest ===
            operation.resolution.checkpoint_digest,
          reference_matches: hold?.reference_digest ===
            operation.resolution.reference_digest,
          active: hold?.state.kind === "active",
          authentication_succeeded: true,
        });
    }
    const advanceAllowed = this.policy.evidenceInboxAdvanceAllowed({
      current_sequence: expectedCursor.sequence,
      next_sequence: decoded.envelope.sequence,
      previous_digest_matches: decoded.envelope.previous_message_digest ===
        expectedCursor.message_digest,
      message_digest_advances: decoded.envelope.message_digest !==
        expectedCursor.message_digest,
      authentication_succeeded: authenticated,
      operation_allowed: operationAllowed,
    });
    if (!advanceAllowed) {
      if (!authenticated) {
        return { decision: "refused", reason: "authentication_failed" };
      }
      if (!operationAllowed) {
        return { decision: "refused", reason: "policy_rejected" };
      }
      return { decision: "refused", reason: "cursor_mismatch" };
    }
    return this.store.applyEvidenceInbox({
      expected_revision: image.storage_revision,
      expected_cursor: expectedCursor,
      next_cursor: {
        boundary: image.boundary,
        source_id: input.expectedSourceId,
        sequence: decoded.envelope.sequence,
        message_digest: decoded.envelope.message_digest,
      },
      message_id: decoded.envelope.message_id,
      operation,
    });
  }

  async prune(request: PlayerLocalPruneRequest): Promise<PlayerLocalPruneResult> {
    const prepared = this.policy.preparePruneWriteSet(
      await this.store.image(),
      request,
    );
    if (prepared.decision === "no_change") {
      return { decision: "no_change" };
    }
    if (prepared.decision === "refused") return prepared;
    return this.store.pruneEvidence(prepared.write_set);
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
    return this.policy.evidenceInboxPageAllowed(input);
  }

  scheduleEvidencePollJob(
    draft: PlayerLocalEvidencePollJobDraft,
  ): Promise<PlayerLocalEvidencePollJobAdmission> {
    return this.store.scheduleEvidencePollJob(draft);
  }

  claimEvidencePollJob(
    sourceId: string,
    nowMs: number,
    leaseDurationMs: number,
  ): Promise<PlayerLocalEvidencePollJobClaimResult> {
    return this.store.claimEvidencePollJob(sourceId, nowMs, leaseDurationMs);
  }

  completeEvidencePollJob(
    completion: PlayerLocalEvidencePollJobCompletion,
  ): Promise<PlayerLocalEvidencePollJobCompletionResult> {
    return this.store.completeEvidencePollJob(completion);
  }

  escalateEvidencePollJob(
    sourceId: string,
    nowMs: number,
    reasonDigest: string,
  ): Promise<PlayerLocalEvidencePollJobEscalationResult> {
    return this.store.escalateEvidencePollJob(
      sourceId,
      nowMs,
      reasonDigest,
    );
  }

  evidencePollClaimAllowed(input: {
    now_ms: number;
    deadline_at_ms: number;
    next_poll_at_ms: number;
    lease_available: boolean;
  }): boolean {
    return this.policy.evidencePollClaimAllowed(input);
  }

  evidencePollLeaseExpiry(input: {
    now_ms: number;
    deadline_at_ms: number;
    lease_duration_ms: number;
  }): number {
    return this.policy.evidencePollLeaseExpiry(input);
  }

  evidencePollNextRetryAt(input: {
    now_ms: number;
    deadline_at_ms: number;
    failures: number;
    base_backoff_ms: number;
    max_backoff_ms: number;
  }): number {
    return this.policy.evidencePollNextRetryAt(input);
  }

  image(): Promise<PlayerLocalAuditImage> {
    return this.store.image();
  }

  close(): void {
    this.store.close();
  }
}
