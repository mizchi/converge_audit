import type { AuditBoundary } from "./contracts.ts";

type AuditModule = typeof import(
  "../../../_build/js/release/build/audit/runtime/bridge/bridge.js"
);

let loadedModule: Promise<AuditModule> | undefined;

function loadAuditModule(): Promise<AuditModule> {
  loadedModule ??= import(
    "../../../_build/js/release/build/audit/runtime/bridge/bridge.js"
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
