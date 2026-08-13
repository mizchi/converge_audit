import {
  type VerifiedInventoryOrigin,
  verifiedInventoryOriginValid,
} from "./inventory-origin-semantics";
import {
  type AsyncDependentDigestVerificationBackend,
  type DependentDigestVerificationPlan,
  verifyDependentDigestVerificationPlan,
} from "../../player-local-runtime/dependent-digest-verification-plan";

export interface InventoryMembershipRecord {
  asset_id: string;
  owner_id: string;
  item_type: string;
  quantity: number;
  origin_source_event: string;
  origin_output_index: number;
  origin_receipt_digest: string;
  version: number;
  last_event: string;
  lineage_root: string;
}

export interface InventoryMembershipPathStep {
  direction: "left" | "right";
  parent_key: string;
  parent_value: string;
  sibling_digest: string;
}

export interface InventoryMembershipProofTranscript {
  record: InventoryMembershipRecord;
  canonical_record: string;
  key: string;
  value: string;
  left_digest: string;
  right_digest: string;
  entry_count: number;
  path: InventoryMembershipPathStep[];
  plan_check_start: number;
  plan_check_count: number;
  root_check_index: number;
}

export interface InventoryMembershipTranscript
  extends DependentDigestVerificationPlan {
  expected_root: string;
  proof_count: number;
  proofs: InventoryMembershipProofTranscript[];
}

export type AsyncInventoryMembershipDigest =
  AsyncDependentDigestVerificationBackend;

export type VerifyInventoryMembershipSemanticsResult =
  | { ok: true; proofCount: number }
  | {
      ok: false;
      reason:
        | "invalid_transcript"
        | "origin_mismatch"
        | "record_mismatch"
        | "path_mismatch"
        | "root_mismatch";
      proofIndex: number;
    };

function textFieldValid(value: unknown, maxLength = 4096): value is string {
  return typeof value === "string" && value.length > 0 &&
    value.length <= maxLength;
}

function digestValid(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
}

function nonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function recordValid(record: InventoryMembershipRecord): boolean {
  return typeof record === "object" && record !== null &&
    textFieldValid(record.asset_id) &&
    textFieldValid(record.owner_id) &&
    textFieldValid(record.item_type) &&
    Number.isSafeInteger(record.quantity) && record.quantity > 0 &&
    textFieldValid(record.origin_source_event) &&
    nonNegativeInteger(record.origin_output_index) &&
    digestValid(record.origin_receipt_digest) &&
    nonNegativeInteger(record.version) &&
    textFieldValid(record.last_event) &&
    digestValid(record.lineage_root);
}

function compareKeys(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function proofStructureError(
  proof: InventoryMembershipProofTranscript,
): "invalid_transcript" | "record_mismatch" | "path_mismatch" | undefined {
  if (
    typeof proof !== "object" || proof === null ||
    !recordValid(proof.record) ||
    !textFieldValid(proof.canonical_record, 65_536) ||
    !textFieldValid(proof.key) ||
    !textFieldValid(proof.value, 65_536) ||
    !digestValid(proof.left_digest) ||
    !digestValid(proof.right_digest) ||
    !Number.isSafeInteger(proof.entry_count) || proof.entry_count <= 0 ||
    !Array.isArray(proof.path) || proof.path.length > 64 ||
    !nonNegativeInteger(proof.plan_check_start) ||
    !Number.isSafeInteger(proof.plan_check_count) ||
    proof.plan_check_count <= 0 ||
    !nonNegativeInteger(proof.root_check_index)
  ) {
    return "invalid_transcript";
  }
  if (
    proof.key !== proof.record.asset_id ||
    proof.value !== proof.canonical_record
  ) {
    return "record_mismatch";
  }
  for (const step of proof.path) {
    if (
      typeof step !== "object" || step === null ||
      (step.direction !== "left" && step.direction !== "right") ||
      !textFieldValid(step.parent_key) ||
      !textFieldValid(step.parent_value, 65_536) ||
      !digestValid(step.sibling_digest) ||
      (step.direction === "left" &&
        compareKeys(proof.key, step.parent_key) >= 0) ||
      (step.direction === "right" &&
        compareKeys(proof.key, step.parent_key) <= 0)
    ) {
      return "path_mismatch";
    }
  }
  return undefined;
}

export async function verifyInventoryMembershipSemantics(
  transcript: InventoryMembershipTranscript,
  digest: AsyncInventoryMembershipDigest,
  expectedRoot: string,
  expectedOrigins: VerifiedInventoryOrigin[],
): Promise<VerifyInventoryMembershipSemanticsResult> {
  if (
    typeof transcript !== "object" || transcript === null ||
    !digestValid(transcript.expected_root) ||
    !digestValid(expectedRoot) ||
    transcript.expected_root !== expectedRoot ||
    !Number.isSafeInteger(transcript.proof_count) ||
    transcript.proof_count <= 0 || transcript.proof_count > 64 ||
    !Array.isArray(transcript.proofs) ||
    transcript.proofs.length !== transcript.proof_count ||
    !Array.isArray(expectedOrigins) ||
    expectedOrigins.length !== transcript.proof_count ||
    expectedOrigins.some((origin) => !verifiedInventoryOriginValid(origin))
  ) {
    return { ok: false, reason: "invalid_transcript", proofIndex: 0 };
  }
  const assetIds = new Set<string>();
  let nextCheckStart = 0;
  for (let index = 0; index < transcript.proofs.length; index++) {
    const proof = transcript.proofs[index];
    const error = proofStructureError(proof);
    if (error) {
      return { ok: false, reason: error, proofIndex: index };
    }
    const expectedCheckCount = proof.path.length + 2;
    if (
      assetIds.has(proof.record.asset_id) ||
      proof.plan_check_start !== nextCheckStart ||
      proof.plan_check_count !== expectedCheckCount ||
      proof.root_check_index !==
        proof.plan_check_start + proof.plan_check_count - 1
    ) {
      return {
        ok: false,
        reason: "invalid_transcript",
        proofIndex: index,
      };
    }
    const leafCheck = transcript.hash_checks?.[proof.plan_check_start];
    const rootCheck = transcript.hash_checks?.[proof.root_check_index];
    if (
      leafCheck?.kind !== "authmap_membership_leaf" ||
      leafCheck?.dependency_check_indices?.length !== 0 ||
      rootCheck?.kind !== "authmap_membership_root" ||
      rootCheck?.dependency_check_indices?.length !== 1 ||
      rootCheck.dependency_check_indices[0] !== proof.root_check_index - 1 ||
      rootCheck.expected_digest !== transcript.expected_root
    ) {
      return { ok: false, reason: "invalid_transcript", proofIndex: index };
    }
    for (
      let checkIndex = proof.plan_check_start + 1;
      checkIndex < proof.root_check_index;
      checkIndex++
    ) {
      const check = transcript.hash_checks?.[checkIndex];
      if (
        check?.kind !== "authmap_membership_parent" ||
        check?.dependency_check_indices?.length !== 1 ||
        check.dependency_check_indices[0] !== checkIndex - 1
      ) {
        return { ok: false, reason: "invalid_transcript", proofIndex: index };
      }
    }
    assetIds.add(proof.record.asset_id);
    nextCheckStart += proof.plan_check_count;
  }
  if (
    nextCheckStart !== transcript.hash_check_count ||
    !Array.isArray(transcript.hash_checks) ||
    transcript.hash_checks.length !== nextCheckStart
  ) {
    return { ok: false, reason: "invalid_transcript", proofIndex: 0 };
  }

  for (let index = 0; index < transcript.proofs.length; index++) {
    const record = transcript.proofs[index].record;
    const verifiedOrigin = expectedOrigins[index];
    const origin = verifiedOrigin.receipt;
    if (
      record.asset_id !== origin.asset_id ||
      record.item_type !== origin.item_type ||
      record.quantity !== origin.quantity ||
      record.origin_source_event !== origin.source_event ||
      record.origin_output_index !== origin.output_index ||
      record.origin_receipt_digest !== verifiedOrigin.receiptDigest ||
      (record.version === 0 &&
        (record.owner_id !== origin.recipient_id ||
          record.last_event !== origin.source_event ||
          record.lineage_root !== verifiedOrigin.lineageRoot))
    ) {
      return { ok: false, reason: "origin_mismatch", proofIndex: index };
    }
  }

  const verifiedPlan = await verifyDependentDigestVerificationPlan(
    transcript,
    digest,
  );
  if (!verifiedPlan.ok) {
    const proofIndex = transcript.proofs.findIndex((proof) =>
      verifiedPlan.checkIndex >= proof.plan_check_start &&
      verifiedPlan.checkIndex < proof.plan_check_start + proof.plan_check_count
    );
    return {
      ok: false,
      reason: verifiedPlan.reason === "invalid_plan"
        ? "invalid_transcript"
        : "root_mismatch",
      proofIndex: proofIndex < 0 ? 0 : proofIndex,
    };
  }
  return { ok: true, proofCount: transcript.proofs.length };
}
