import {
  type InventoryOriginReceipt,
  inventoryOriginCommitments,
  inventoryOriginReceiptValid,
} from "./inventory-origin-semantics";

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
  key: string;
  value: string;
  left_digest: string;
  right_digest: string;
  entry_count: number;
  path: InventoryMembershipPathStep[];
}

export interface InventoryMembershipTranscript {
  expected_root: string;
  proof_count: number;
  proofs: InventoryMembershipProofTranscript[];
}

export interface AsyncInventoryMembershipDigest {
  hashString(value: string): Promise<string>;
}

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

function appendField(value: string): string {
  return `${value.length}:${value}`;
}

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

export function canonicalInventoryAssetRecord(
  record: InventoryMembershipRecord,
): string {
  return [
    "asset-record-v2",
    record.asset_id,
    record.owner_id,
    record.item_type,
    record.quantity.toString(),
    record.origin_source_event,
    record.origin_output_index.toString(),
    record.origin_receipt_digest,
    record.version.toString(),
    record.last_event,
    record.lineage_root,
  ].map(appendField).join("");
}

function taggedPreimage(tag: string, fields: string[]): string {
  return [tag, ...fields].map(appendField).join("");
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
    !textFieldValid(proof.key) ||
    !textFieldValid(proof.value, 65_536) ||
    !digestValid(proof.left_digest) ||
    !digestValid(proof.right_digest) ||
    !Number.isSafeInteger(proof.entry_count) || proof.entry_count <= 0 ||
    !Array.isArray(proof.path) || proof.path.length > 64
  ) {
    return "invalid_transcript";
  }
  if (
    proof.key !== proof.record.asset_id ||
    proof.value !== canonicalInventoryAssetRecord(proof.record)
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
  expectedOrigins: InventoryOriginReceipt[],
): Promise<VerifyInventoryMembershipSemanticsResult> {
  if (
    !digestValid(transcript.expected_root) ||
    !digestValid(expectedRoot) ||
    transcript.expected_root !== expectedRoot ||
    !Number.isSafeInteger(transcript.proof_count) ||
    transcript.proof_count <= 0 || transcript.proof_count > 64 ||
    !Array.isArray(transcript.proofs) ||
    transcript.proofs.length !== transcript.proof_count ||
    !Array.isArray(expectedOrigins) ||
    expectedOrigins.length !== transcript.proof_count ||
    expectedOrigins.some((origin) => !inventoryOriginReceiptValid(origin))
  ) {
    return { ok: false, reason: "invalid_transcript", proofIndex: 0 };
  }
  const assetIds = new Set<string>();
  for (let index = 0; index < transcript.proofs.length; index++) {
    const proof = transcript.proofs[index];
    const error = proofStructureError(proof);
    if (error || assetIds.has(proof.record.asset_id)) {
      return {
        ok: false,
        reason: error ?? "invalid_transcript",
        proofIndex: index,
      };
    }
    assetIds.add(proof.record.asset_id);
  }

  const originCommitments = await Promise.all(
    expectedOrigins.map((origin) => inventoryOriginCommitments(origin, digest)),
  );
  for (let index = 0; index < transcript.proofs.length; index++) {
    const record = transcript.proofs[index].record;
    const origin = expectedOrigins[index];
    const commitments = originCommitments[index];
    if (
      record.asset_id !== origin.asset_id ||
      record.item_type !== origin.item_type ||
      record.quantity !== origin.quantity ||
      record.origin_source_event !== origin.source_event ||
      record.origin_output_index !== origin.output_index ||
      record.origin_receipt_digest !== commitments.receiptDigest ||
      (record.version === 0 &&
        (record.owner_id !== origin.recipient_id ||
          record.last_event !== origin.source_event ||
          record.lineage_root !== commitments.lineageRoot))
    ) {
      return { ok: false, reason: "origin_mismatch", proofIndex: index };
    }
  }

  const roots = await Promise.all(
    transcript.proofs.map((proof) => inventoryMembershipRoot(proof, digest)),
  );
  for (let index = 0; index < roots.length; index++) {
    if (roots[index] !== transcript.expected_root) {
      return { ok: false, reason: "root_mismatch", proofIndex: index };
    }
  }
  return { ok: true, proofCount: transcript.proofs.length };
}

async function inventoryMembershipRoot(
  proof: InventoryMembershipProofTranscript,
  digest: AsyncInventoryMembershipDigest,
): Promise<string> {
  let current = await digest.hashString(taggedPreimage("authmap-node-v1", [
    proof.key,
    proof.value,
    proof.left_digest,
    proof.right_digest,
  ]));
  for (let index = proof.path.length - 1; index >= 0; index--) {
    const step = proof.path[index];
    current = await digest.hashString(taggedPreimage("authmap-node-v1", [
      step.parent_key,
      step.parent_value,
      ...(step.direction === "left"
        ? [current, step.sibling_digest]
        : [step.sibling_digest, current]),
    ]));
  }
  return digest.hashString(taggedPreimage("authmap-root-v1", [
    proof.entry_count.toString(),
    current,
  ]));
}
