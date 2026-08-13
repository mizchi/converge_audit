import type { AsyncDependentDigestVerificationBackend } from "../../player-local-runtime/dependent-digest-verification-plan";
import {
  openWorldEncounterRegistrationKey,
  openWorldMissingSlotConflict,
  openWorldMissingSlotPersistAllowed,
  type OpenWorldMissingSlotConflictInput,
  type OpenWorldMissingSlotEvidenceSource,
} from "./moonbit";
import { verifyOpenWorldMissingSlotSemantics } from "./open-world-missing-slot-semantics";

export type { OpenWorldMissingSlotConflictInput } from "./moonbit";

export interface VerifiedOpenWorldMissingSlotConflict {
  decision: "persist_conflict";
  kind: "missing_slot";
  source: OpenWorldMissingSlotEvidenceSource;
  audit_checkpoint_digest: string;
  seal_checkpoint_digest: string;
  encounter_digest: string;
  registration_index: number;
  registered_count: number;
  registry_root: string;
  observer_approvals: number | null;
  standard_hash_check_count: number;
}

export type PersistOpenWorldMissingSlotConflictResult<T> =
  | {
      ok: true;
      conflict: VerifiedOpenWorldMissingSlotConflict;
      persisted: T;
    }
  | { ok: false; error: string };

function digestValid(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
}

/**
 * Single pre-mutation gate for an omitted open-world registration.
 *
 * `persist` is never called unless MoonBit has issued the opaque conflict
 * capability and standard host crypto has independently recomputed the exact
 * sealed AuthMap root.
 */
export async function persistOpenWorldMissingSlotConflictIfVerified<T>(
  input: OpenWorldMissingSlotConflictInput,
  backend: AsyncDependentDigestVerificationBackend,
  persist: (conflict: VerifiedOpenWorldMissingSlotConflict) => Promise<T> | T,
): Promise<PersistOpenWorldMissingSlotConflictResult<T>> {
  const opened = await openWorldMissingSlotConflict(input);
  if (!opened.ok) return opened;
  if (
    opened.complete !== true || opened.decision !== "persist_conflict" ||
    opened.kind !== "missing_slot" || opened.source !== input.evidenceSource ||
    opened.audit_checkpoint_digest !== input.expectedAuditCheckpointDigest ||
    opened.seal_checkpoint_digest !== input.expectedSealCheckpointDigest ||
    opened.encounter_digest !== input.expectedEncounterCheckpointDigest ||
    opened.registration_index !== input.expectedRegistrationIndex ||
    !digestValid(opened.expected_root) ||
    (opened.source === "authority_signed_encounter"
      ? opened.observer_approvals !== null
      : !Number.isSafeInteger(opened.observer_approvals) ||
        (opened.observer_approvals as number) <= 0)
  ) {
    return { ok: false, error: "invalid_missing_slot_conflict_transcript" };
  }
  const expectedProofKey = await openWorldEncounterRegistrationKey(
    input.expectedRegistrationIndex,
  );
  if (expectedProofKey.length === 0) {
    return { ok: false, error: "invalid_missing_slot_conflict_transcript" };
  }
  const standard = await verifyOpenWorldMissingSlotSemantics(
    opened,
    backend,
    opened.expected_root,
    opened.registered_count,
    input.expectedRegistrationIndex,
    expectedProofKey,
  );
  if (!standard.ok) {
    return { ok: false, error: `standard_crypto_${standard.reason}` };
  }
  const persistAllowed = await openWorldMissingSlotPersistAllowed({
    conflictCapabilityIssued: true,
    standardNonMembershipVerified: true,
    exactTranscriptBinding: true,
  });
  if (!persistAllowed) {
    return { ok: false, error: "missing_slot_persistence_refused" };
  }
  const conflict: VerifiedOpenWorldMissingSlotConflict = Object.freeze({
    decision: "persist_conflict",
    kind: "missing_slot",
    source: opened.source,
    audit_checkpoint_digest: opened.audit_checkpoint_digest,
    seal_checkpoint_digest: opened.seal_checkpoint_digest,
    encounter_digest: opened.encounter_digest,
    registration_index: opened.registration_index,
    registered_count: opened.registered_count,
    registry_root: opened.expected_root,
    observer_approvals: opened.observer_approvals,
    standard_hash_check_count: standard.checkCount,
  });
  return { ok: true, conflict, persisted: await persist(conflict) };
}
