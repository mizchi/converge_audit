import {
  type AsyncDigestVerificationBackend,
  type DigestVerificationPlan,
  verifyDigestVerificationPlan,
} from "../../player-local-runtime/digest-verification-plan";

export interface InventoryOriginReceipt {
  asset_id: string;
  recipient_id: string;
  item_type: string;
  quantity: number;
  source_event: string;
  output_index: number;
}

export interface InventoryOriginSemanticEntry extends InventoryOriginReceipt {
  receipt_digest: string;
  lineage_root: string;
}

export interface InventoryOriginSemanticTranscript
  extends DigestVerificationPlan {
  origin_count: number;
  origins: InventoryOriginSemanticEntry[];
}

export type AsyncInventoryOriginDigest = AsyncDigestVerificationBackend;

const verifiedInventoryOrigin = Symbol("verified-inventory-origin");

/** Capability returned only after the MoonBit plan passes host WebCrypto. */
export interface VerifiedInventoryOrigin {
  readonly [verifiedInventoryOrigin]: true;
  readonly receipt: InventoryOriginReceipt;
  readonly receiptDigest: string;
  readonly lineageRoot: string;
}

export type VerifyInventoryOriginSemanticsResult =
  | { ok: true; origins: VerifiedInventoryOrigin[] }
  | {
      ok: false;
      reason:
        | "invalid_transcript"
        | "origin_mismatch"
        | "commitment_mismatch";
      originIndex: number;
    };

function textFieldValid(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 4096;
}

function digestValid(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
}

export function inventoryOriginReceiptValid(
  receipt: InventoryOriginReceipt | null | undefined,
): receipt is InventoryOriginReceipt {
  return typeof receipt === "object" && receipt !== null &&
    textFieldValid(receipt.asset_id) &&
    textFieldValid(receipt.recipient_id) &&
    textFieldValid(receipt.item_type) &&
    Number.isSafeInteger(receipt.quantity) && receipt.quantity > 0 &&
    textFieldValid(receipt.source_event) &&
    Number.isSafeInteger(receipt.output_index) && receipt.output_index >= 0;
}

function sameOriginReceipt(
  actual: InventoryOriginSemanticEntry,
  expected: InventoryOriginReceipt,
): boolean {
  return actual.asset_id === expected.asset_id &&
    actual.recipient_id === expected.recipient_id &&
    actual.item_type === expected.item_type &&
    actual.quantity === expected.quantity &&
    actual.source_event === expected.source_event &&
    actual.output_index === expected.output_index;
}

export function verifiedInventoryOriginValid(
  origin: VerifiedInventoryOrigin | null | undefined,
): origin is VerifiedInventoryOrigin {
  return typeof origin === "object" && origin !== null &&
    origin[verifiedInventoryOrigin] === true &&
    inventoryOriginReceiptValid(origin.receipt) &&
    digestValid(origin.receiptDigest) &&
    digestValid(origin.lineageRoot);
}

/**
 * Execute a MoonBit-owned origin plan. This adapter checks only the bounded
 * transport shape and delegates every canonical statement to the generic
 * WebCrypto executor.
 */
export async function verifyInventoryOriginSemantics(
  transcript: InventoryOriginSemanticTranscript,
  digest: AsyncInventoryOriginDigest,
  expectedOrigins: InventoryOriginReceipt[],
): Promise<VerifyInventoryOriginSemanticsResult> {
  if (
    typeof transcript !== "object" || transcript === null ||
    !Number.isSafeInteger(transcript.origin_count) ||
    transcript.origin_count <= 0 || transcript.origin_count > 64 ||
    !Array.isArray(transcript.origins) ||
    transcript.origins.length !== transcript.origin_count ||
    !Array.isArray(expectedOrigins) ||
    expectedOrigins.length !== transcript.origin_count ||
    transcript.hash_check_count !== transcript.origin_count * 2
  ) {
    return { ok: false, reason: "invalid_transcript", originIndex: 0 };
  }
  const assetIds = new Set<string>();
  for (let index = 0; index < transcript.origin_count; index++) {
    const origin = transcript.origins[index];
    const expected = expectedOrigins[index];
    const receiptCheck = transcript.hash_checks?.[index * 2];
    const lineageCheck = transcript.hash_checks?.[index * 2 + 1];
    if (
      !inventoryOriginReceiptValid(origin) ||
      !inventoryOriginReceiptValid(expected) ||
      !digestValid(origin.receipt_digest) ||
      !digestValid(origin.lineage_root) ||
      assetIds.has(origin.asset_id) ||
      receiptCheck?.kind !== "inventory_origin_receipt" ||
      receiptCheck?.check_index !== index * 2 ||
      receiptCheck.expected_digest !== origin.receipt_digest ||
      lineageCheck?.kind !== "inventory_origin_lineage" ||
      lineageCheck?.check_index !== index * 2 + 1 ||
      lineageCheck.expected_digest !== origin.lineage_root
    ) {
      return { ok: false, reason: "invalid_transcript", originIndex: index };
    }
    assetIds.add(origin.asset_id);
    if (!sameOriginReceipt(origin, expected)) {
      return { ok: false, reason: "origin_mismatch", originIndex: index };
    }
  }
  const verified = await verifyDigestVerificationPlan(transcript, digest);
  if (!verified.ok) {
    return {
      ok: false,
      reason: verified.reason === "invalid_plan"
        ? "invalid_transcript"
        : "commitment_mismatch",
      originIndex: Math.floor(verified.checkIndex / 2),
    };
  }
  return {
    ok: true,
    origins: transcript.origins.map((origin, index) => ({
      [verifiedInventoryOrigin]: true,
      receipt: expectedOrigins[index],
      receiptDigest: origin.receipt_digest,
      lineageRoot: origin.lineage_root,
    })),
  };
}
