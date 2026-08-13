import {
  type VerifiedInventoryOrigin,
  verifiedInventoryOriginValid,
} from "./inventory-origin-semantics";
import {
  type AsyncDigestVerificationBackend,
  type DigestVerificationPlan,
  verifyDigestVerificationPlan,
} from "../../player-local-runtime/digest-verification-plan";

export interface InventoryLineageSemanticTransition {
  asset_id: string;
  origin_receipt_digest: string;
  from_owner: string;
  to_owner: string;
  expected_version: number;
  previous_event: string;
  source_event: string;
  previous_lineage_root: string;
  next_lineage_root: string;
}

export interface InventoryLineageSemanticTranscript
  extends DigestVerificationPlan {
  asset_id: string;
  current_owner_id: string;
  initial_owner_id: string;
  initial_version: number;
  initial_last_event: string;
  initial_lineage_root: string;
  initial_origin_receipt_digest: string;
  transfer_count: number;
  transitions: InventoryLineageSemanticTransition[];
  final_owner_id: string;
  final_version: number;
  final_last_event: string;
  final_lineage_root: string;
}

export type AsyncInventoryLineageSemanticDigest =
  AsyncDigestVerificationBackend;

export type VerifyInventoryLineageSemanticsResult =
  | { ok: true; transitionCount: number }
  | {
      ok: false;
      reason:
        | "invalid_transcript"
        | "origin_mismatch"
        | "transition_mismatch"
        | "root_mismatch";
      transitionIndex: number;
    };

function textFieldValid(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 4096;
}

function digestValid(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
}

function versionValid(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function transitionStructurallyValid(
  transition: InventoryLineageSemanticTransition | null | undefined,
): transition is InventoryLineageSemanticTransition {
  return typeof transition === "object" && transition !== null &&
    textFieldValid(transition.asset_id) &&
    digestValid(transition.origin_receipt_digest) &&
    textFieldValid(transition.from_owner) &&
    textFieldValid(transition.to_owner) &&
    transition.from_owner !== transition.to_owner &&
    versionValid(transition.expected_version) &&
    textFieldValid(transition.previous_event) &&
    textFieldValid(transition.source_event) &&
    digestValid(transition.previous_lineage_root) &&
    digestValid(transition.next_lineage_root);
}

export async function verifyInventoryLineageSemantics(
  transcript: InventoryLineageSemanticTranscript,
  digest: AsyncInventoryLineageSemanticDigest,
  verifiedOrigin: VerifiedInventoryOrigin,
): Promise<VerifyInventoryLineageSemanticsResult> {
  const origin = verifiedOrigin?.receipt;
  if (
    typeof transcript !== "object" || transcript === null ||
    !textFieldValid(transcript.asset_id) ||
    !textFieldValid(transcript.current_owner_id) ||
    !textFieldValid(transcript.initial_owner_id) ||
    !versionValid(transcript.initial_version) ||
    !textFieldValid(transcript.initial_last_event) ||
    !digestValid(transcript.initial_lineage_root) ||
    !digestValid(transcript.initial_origin_receipt_digest) ||
    !verifiedInventoryOriginValid(verifiedOrigin) ||
    !Number.isSafeInteger(transcript.transfer_count) ||
    transcript.transfer_count <= 0 ||
    transcript.transfer_count > 64 ||
    !Array.isArray(transcript.transitions) ||
    transcript.transitions.length !== transcript.transfer_count ||
    transcript.hash_check_count !== transcript.transfer_count ||
    !Array.isArray(transcript.hash_checks) ||
    transcript.hash_checks.length !== transcript.transfer_count ||
    !textFieldValid(transcript.final_owner_id) ||
    !versionValid(transcript.final_version) ||
    !textFieldValid(transcript.final_last_event) ||
    !digestValid(transcript.final_lineage_root)
  ) {
    return { ok: false, reason: "invalid_transcript", transitionIndex: 0 };
  }

  if (
    origin.asset_id !== transcript.asset_id ||
    transcript.initial_origin_receipt_digest !==
      verifiedOrigin.receiptDigest ||
    (transcript.initial_version === 0 &&
      (transcript.initial_owner_id !== origin.recipient_id ||
        transcript.initial_last_event !== origin.source_event ||
        transcript.initial_lineage_root !== verifiedOrigin.lineageRoot))
  ) {
    return { ok: false, reason: "origin_mismatch", transitionIndex: 0 };
  }

  let owner = transcript.initial_owner_id;
  let version = transcript.initial_version;
  let lastEvent = transcript.initial_last_event;
  let lineageRoot = transcript.initial_lineage_root;
  for (let index = 0; index < transcript.transitions.length; index++) {
    const transition = transcript.transitions[index];
    const hashCheck = transcript.hash_checks[index];
    if (
      hashCheck?.kind !== "inventory_lineage_transition" ||
      hashCheck?.check_index !== index ||
      hashCheck.expected_digest !== transition?.next_lineage_root
    ) {
      return {
        ok: false,
        reason: "invalid_transcript",
        transitionIndex: index,
      };
    }
    if (
      !transitionStructurallyValid(transition) ||
      transition.asset_id !== transcript.asset_id ||
      transition.origin_receipt_digest !== verifiedOrigin.receiptDigest ||
      transition.from_owner !== owner ||
      transition.expected_version !== version ||
      transition.previous_event !== lastEvent ||
      transition.previous_lineage_root !== lineageRoot
    ) {
      return {
        ok: false,
        reason: "transition_mismatch",
        transitionIndex: index,
      };
    }
    owner = transition.to_owner;
    version += 1;
    lastEvent = transition.source_event;
    lineageRoot = transition.next_lineage_root;
  }
  if (
    owner !== transcript.final_owner_id ||
    owner !== transcript.current_owner_id ||
    version !== transcript.final_version ||
    lastEvent !== transcript.final_last_event ||
    lineageRoot !== transcript.final_lineage_root
  ) {
    return {
      ok: false,
      reason: "transition_mismatch",
      transitionIndex: transcript.transfer_count,
    };
  }

  const verifiedPlan = await verifyDigestVerificationPlan(transcript, digest);
  if (!verifiedPlan.ok) {
    return {
      ok: false,
      reason: verifiedPlan.reason === "invalid_plan"
        ? "invalid_transcript"
        : "root_mismatch",
      transitionIndex: verifiedPlan.checkIndex,
    };
  }
  return { ok: true, transitionCount: transcript.transitions.length };
}
