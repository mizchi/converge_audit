import {
  type AsyncDependentDigestVerificationBackend,
  type DependentDigestVerificationPlan,
  verifyDependentDigestVerificationPlan,
} from "../../player-local-runtime/dependent-digest-verification-plan";

export interface OpenWorldMissingSlotPathStep {
  direction: "left" | "right";
  parent_key: string;
  parent_value: string;
  sibling_digest: string;
}

export interface OpenWorldMissingSlotTranscript
  extends DependentDigestVerificationPlan {
  ok: true;
  complete: true;
  expected_root: string;
  registered_count: number;
  registration_index: number;
  proof_key: string;
  proof_entry_count: number;
  path: OpenWorldMissingSlotPathStep[];
  root_check_index: number;
}

export type VerifyOpenWorldMissingSlotSemanticsResult =
  | { ok: true; checkCount: number }
  | {
      ok: false;
      reason:
        | "invalid_transcript"
        | "boundary_mismatch"
        | "path_mismatch"
        | "root_mismatch";
    };

function boundedText(
  value: unknown,
  maxLength = 4096,
): value is string {
  return typeof value === "string" && value.length > 0 &&
    value.length <= maxLength;
}

function digestValid(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
}

function int32(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0 &&
    (value as number) <= 2_147_483_647;
}

function compareKeys(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/**
 * Recompute a locally MoonBit-validated absence proof with host crypto.
 * This proves only absence under `expectedRoot`; the caller still needs a
 * signed seal and authenticated evidence that the slot should have existed.
 */
export async function verifyOpenWorldMissingSlotSemantics(
  transcript: OpenWorldMissingSlotTranscript,
  backend: AsyncDependentDigestVerificationBackend,
  expectedRoot: string,
  expectedRegisteredCount: number,
  expectedRegistrationIndex: number,
  expectedProofKey: string,
): Promise<VerifyOpenWorldMissingSlotSemanticsResult> {
  if (
    !digestValid(expectedRoot) ||
    !int32(expectedRegisteredCount) || expectedRegisteredCount <= 0 ||
    !int32(expectedRegistrationIndex) ||
    expectedRegistrationIndex >= expectedRegisteredCount ||
    !boundedText(expectedProofKey)
  ) {
    return { ok: false, reason: "boundary_mismatch" };
  }
  if (
    typeof transcript !== "object" || transcript === null ||
    transcript.ok !== true || transcript.complete !== true ||
    !digestValid(transcript.expected_root) ||
    !int32(transcript.registered_count) || transcript.registered_count <= 0 ||
    !int32(transcript.registration_index) ||
    transcript.registration_index >= transcript.registered_count ||
    !boundedText(transcript.proof_key) ||
    !int32(transcript.proof_entry_count) ||
    !Array.isArray(transcript.path) || transcript.path.length > 64 ||
    (transcript.proof_entry_count === 0 && transcript.path.length !== 0) ||
    (transcript.proof_entry_count > 0 && transcript.path.length === 0) ||
    !Number.isSafeInteger(transcript.root_check_index) ||
    transcript.root_check_index < 0 ||
    !Number.isSafeInteger(transcript.hash_check_count) ||
    transcript.hash_check_count !== transcript.path.length + 2 ||
    !Array.isArray(transcript.hash_checks) ||
    transcript.hash_checks.length !== transcript.hash_check_count ||
    transcript.root_check_index !== transcript.hash_check_count - 1
  ) {
    return { ok: false, reason: "invalid_transcript" };
  }
  if (
    transcript.expected_root !== expectedRoot ||
    transcript.registered_count !== expectedRegisteredCount ||
    transcript.registration_index !== expectedRegistrationIndex ||
    transcript.proof_key !== expectedProofKey
  ) {
    return { ok: false, reason: "boundary_mismatch" };
  }
  for (const step of transcript.path) {
    if (
      typeof step !== "object" || step === null ||
      (step.direction !== "left" && step.direction !== "right") ||
      !boundedText(step.parent_key) ||
      !digestValid(step.parent_value) ||
      !digestValid(step.sibling_digest) ||
      (step.direction === "left" &&
        compareKeys(transcript.proof_key, step.parent_key) >= 0) ||
      (step.direction === "right" &&
        compareKeys(transcript.proof_key, step.parent_key) <= 0)
    ) {
      return { ok: false, reason: "path_mismatch" };
    }
  }

  const empty = transcript.hash_checks[0];
  const root = transcript.hash_checks[transcript.root_check_index];
  if (
    empty?.kind !== "authmap_non_membership_empty" ||
    empty.dependency_check_indices?.length !== 0 ||
    root?.kind !== "authmap_non_membership_root" ||
    root.dependency_check_indices?.length !== 1 ||
    root.dependency_check_indices[0] !== transcript.root_check_index - 1 ||
    root.expected_digest !== transcript.expected_root
  ) {
    return { ok: false, reason: "invalid_transcript" };
  }
  for (let index = 1; index < transcript.root_check_index; index++) {
    const parent = transcript.hash_checks[index];
    if (
      parent?.kind !== "authmap_non_membership_parent" ||
      parent.dependency_check_indices?.length !== 1 ||
      parent.dependency_check_indices[0] !== index - 1
    ) {
      return { ok: false, reason: "invalid_transcript" };
    }
  }

  const verified = await verifyDependentDigestVerificationPlan(
    transcript,
    backend,
  );
  if (!verified.ok) {
    return {
      ok: false,
      reason: verified.reason === "invalid_plan"
        ? "invalid_transcript"
        : "root_mismatch",
    };
  }
  return { ok: true, checkCount: verified.checkCount };
}
