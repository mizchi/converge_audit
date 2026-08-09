import type {
  GameCheckpointVerificationRequest,
  GameItemVerificationRequest,
} from "../../../game/authority/item-verification";
import type { ItemVerificationReceipt } from "../../../game/kernel";

export type AuthorityFetch = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

export type RequestGameItemVerificationResult =
  | {
      ok: true;
      decision: "verified" | "duplicate";
      receipt: ItemVerificationReceipt;
    }
  | { ok: false; reason: "network_error" | "invalid_response" }
  | {
      ok: false;
      reason: "authority_refused";
      error: string;
      status: number;
      retryAfterSeconds?: number;
    };

export interface GameCheckpointAuthorityReceipt {
  authorityCheckpointReceiptId: string;
  playerId: string;
  ownerPublicKey: string;
  seed: number;
  epoch: number;
  lastTick: number;
  checkpointDigest: string;
  createdAssetIds: string[];
}

export type RequestGameCheckpointVerificationResult =
  | {
      ok: true;
      decision: "verified" | "duplicate";
      receipt: GameCheckpointAuthorityReceipt;
    }
  | { ok: false; reason: "network_error" | "invalid_response" }
  | {
      ok: false;
      reason: "authority_refused";
      error: string;
      status: number;
      retryAfterSeconds?: number;
    };

export interface GameItemTransferRequest {
  assetId: string;
  authorityReceiptId: string;
  previousHeadId: string;
  fromOwnerId: string;
  fromOwnerPublicKey: string;
  toOwnerId: string;
  toOwnerPublicKey: string;
  previousVersion: number;
  nextVersion: number;
  senderSignature: string;
  recipientSignature: string;
}

export interface GameItemTransfer {
  transferId: string;
  assetId: string;
  authorityReceiptId: string;
  previousHeadId: string;
  nextHeadId: string;
  fromOwnerId: string;
  fromOwnerPublicKey: string;
  toOwnerId: string;
  toOwnerPublicKey: string;
  previousVersion: number;
  nextVersion: number;
  senderSignature: string;
  recipientSignature: string;
  transferredAt: number;
}

export interface GameAssetOwnershipHead {
  assetId: string;
  authorityReceiptId: string;
  ownerId: string;
  ownerPublicKey: string;
  ownerVersion: number;
  ownerHeadId: string;
  lastTransferId: string;
  updatedAt: number;
}

export type GameAssetSettlementStatus =
  | "provisional"
  | "quarantined"
  | "finalized"
  | "expired";

export interface GameAssetLineageCase {
  ancestorId: string;
  ancestorKind: "origin" | "transfer" | "current_head";
  revision: number;
  decisionId: string;
  reasonCode: string;
  lifecycle: "appeal_open" | "expired";
  appealDeadlineAtMs: number | null;
  finalizedAtMs: number | null;
  updatedAtMs: number;
}

export interface GameAssetLineageStatus {
  assetId: string;
  eligibility: "unverified" | "eligible" | "revoked";
  settlementStatus: GameAssetSettlementStatus;
  openRevocations: number;
  lineageCases: GameAssetLineageCase[];
}

export type RequestGameAssetLineageStatusResult =
  | { ok: true; status: GameAssetLineageStatus }
  | { ok: false; reason: "network_error" | "invalid_response" }
  | {
      ok: false;
      reason: "authority_refused";
      error: string;
      status: number;
      retryAfterSeconds?: number;
    };

export type RequestGameItemTransferResult =
  | {
      ok: true;
      decision: "transferred" | "duplicate";
      transfer: GameItemTransfer;
      ownerHead: GameAssetOwnershipHead;
    }
  | { ok: false; reason: "network_error" | "invalid_response" }
  | {
      ok: false;
      reason: "transfer_refused";
      decision: string;
      status: number;
    }
  | {
      ok: false;
      reason: "authority_refused";
      error: string;
      status: number;
      retryAfterSeconds?: number;
    };

export interface GameMarketListingRequest {
  assetId: string;
  sellerId: string;
  authorityReceiptId: string;
  ownerPublicKey: string;
  ownerVersion: number;
  ownerHeadId: string;
  listingNonce: string;
  ownerSignature: string;
}

export interface GameMarketListing {
  listingId: string;
  assetId: string;
  sellerId: string;
  authorityReceiptId: string;
  ownerPublicKey: string;
  ownerVersion: number;
  ownerHeadId: string;
  listingNonce: string;
  ownerSignature: string;
  checkpointDigest: string;
  inventoryEpoch: number;
  itemType: string;
  power: number;
  status: "active";
  listedAt: number;
}

export type RequestGameMarketListingResult =
  | {
      ok: true;
      decision: "listed" | "duplicate";
      listing: GameMarketListing;
    }
  | { ok: false; reason: "network_error" | "invalid_response" }
  | {
      ok: false;
      reason: "listing_refused";
      decision: string;
      status: number;
      lineageStatus?: GameAssetLineageStatus;
    }
  | {
      ok: false;
      reason: "authority_refused";
      error: string;
      status: number;
      retryAfterSeconds?: number;
    };

export interface GameMarketListingCancellationRequest {
  listingId: string;
  assetId: string;
  sellerId: string;
  authorityReceiptId: string;
  ownerPublicKey: string;
  ownerVersion: number;
  ownerHeadId: string;
  listingNonce: string;
  cancelSignature: string;
}

export interface CanceledGameMarketListing {
  listingId: string;
  assetId: string;
  sellerId: string;
  authorityReceiptId: string;
  ownerPublicKey: string;
  ownerVersion: number;
  ownerHeadId: string;
  listingNonce: string;
  ownerSignature: string;
  checkpointDigest: string;
  inventoryEpoch: number;
  itemType: string;
  power: number;
  status: "canceled";
  listedAt: number;
  cancelSignature: string;
  canceledAt: number;
}

export type RequestGameMarketListingCancellationResult =
  | {
      ok: true;
      decision: "canceled" | "duplicate";
      listing: CanceledGameMarketListing;
    }
  | { ok: false; reason: "network_error" | "invalid_response" }
  | {
      ok: false;
      reason: "cancellation_refused";
      decision: string;
      status: number;
    }
  | {
      ok: false;
      reason: "authority_refused";
      error: string;
      status: number;
      retryAfterSeconds?: number;
    };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function retryAfterSeconds(response: Response): number | undefined {
  const value = Number(response.headers.get("retry-after"));
  return Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

function nullableTimestamp(value: unknown): value is number | null {
  return value === null ||
    (typeof value === "number" && Number.isSafeInteger(value) && value >= 0);
}

function lineageStatusFromResponse(
  value: unknown,
  expectedAssetId: string,
): GameAssetLineageStatus | undefined {
  if (!isRecord(value) || value.ok !== true ||
    value.asset_id !== expectedAssetId ||
    (value.eligibility !== "unverified" && value.eligibility !== "eligible" &&
      value.eligibility !== "revoked") ||
    (value.settlement_status !== "provisional" &&
      value.settlement_status !== "quarantined" &&
      value.settlement_status !== "finalized" &&
      value.settlement_status !== "expired") ||
    typeof value.open_revocations !== "number" ||
    !Number.isSafeInteger(value.open_revocations) ||
    value.open_revocations < 0 || !Array.isArray(value.lineage_cases)) {
    return undefined;
  }
  const lineageCases: GameAssetLineageCase[] = [];
  for (const item of value.lineage_cases) {
    if (!isRecord(item) || typeof item.ancestor_id !== "string" ||
      (item.ancestor_kind !== "origin" && item.ancestor_kind !== "transfer" &&
        item.ancestor_kind !== "current_head") ||
      typeof item.revision !== "number" || !Number.isSafeInteger(item.revision) ||
      item.revision <= 0 || typeof item.decision_id !== "string" ||
      !/^[0-9a-f]{64}$/.test(item.decision_id) ||
      typeof item.reason_code !== "string" || item.reason_code.length === 0 ||
      (item.lifecycle !== "appeal_open" && item.lifecycle !== "expired") ||
      !nullableTimestamp(item.appeal_deadline_at_ms) ||
      !nullableTimestamp(item.finalized_at_ms) ||
      typeof item.updated_at_ms !== "number" ||
      !Number.isSafeInteger(item.updated_at_ms) || item.updated_at_ms < 0) {
      return undefined;
    }
    lineageCases.push({
      ancestorId: item.ancestor_id,
      ancestorKind: item.ancestor_kind,
      revision: item.revision,
      decisionId: item.decision_id,
      reasonCode: item.reason_code,
      lifecycle: item.lifecycle,
      appealDeadlineAtMs: item.appeal_deadline_at_ms,
      finalizedAtMs: item.finalized_at_ms,
      updatedAtMs: item.updated_at_ms,
    });
  }
  const openRevocations = value.open_revocations;
  const statusIsConsistent =
    (value.settlement_status === "provisional" &&
      value.eligibility === "unverified" && openRevocations === 0 &&
      lineageCases.length === 0) ||
    (value.settlement_status === "finalized" &&
      value.eligibility === "eligible" && openRevocations === 0 &&
      lineageCases.length === 0) ||
    (value.settlement_status === "quarantined" &&
      value.eligibility === "revoked" && openRevocations > 0 &&
      lineageCases.length === openRevocations &&
      lineageCases.some((item) => item.lifecycle === "appeal_open")) ||
    (value.settlement_status === "expired" &&
      value.eligibility === "revoked" && openRevocations > 0 &&
      lineageCases.length === openRevocations &&
      lineageCases.every((item) => item.lifecycle === "expired"));
  if (!statusIsConsistent) return undefined;
  return {
    assetId: expectedAssetId,
    eligibility: value.eligibility,
    settlementStatus: value.settlement_status,
    openRevocations,
    lineageCases,
  };
}

export async function requestGameAssetLineageStatus(
  fetcher: AuthorityFetch,
  unit: string,
  assetId: string,
): Promise<RequestGameAssetLineageStatusResult> {
  let response: Response;
  try {
    response = await fetcher(
      `/v1/pve/${encodeURIComponent(unit)}/game-asset-lineage-status?asset_id=${encodeURIComponent(assetId)}`,
      { method: "GET", cache: "no-store" },
    );
  } catch {
    return { ok: false, reason: "network_error" };
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return { ok: false, reason: "invalid_response" };
  }
  if (!response.ok) {
    if (!isRecord(body) || body.ok !== false || typeof body.error !== "string") {
      return { ok: false, reason: "invalid_response" };
    }
    const retryAfter = retryAfterSeconds(response);
    return {
      ok: false,
      reason: "authority_refused",
      error: body.error,
      status: response.status,
      ...(retryAfter === undefined ? {} : { retryAfterSeconds: retryAfter }),
    };
  }
  const status = lineageStatusFromResponse(body, assetId);
  return status
    ? { ok: true, status }
    : { ok: false, reason: "invalid_response" };
}

function receiptFromResponse(
  value: unknown,
  request: GameItemVerificationRequest,
): ItemVerificationReceipt | undefined {
  if (!isRecord(value) || value.version !== 1) return undefined;
  const authorityReceiptId = value.authority_receipt_id;
  const inventoryEpoch = value.inventory_epoch;
  const ownerVersion = value.owner_version;
  if (
    typeof authorityReceiptId !== "string" ||
    !/^[0-9a-f]{64}$/.test(authorityReceiptId) ||
    value.asset_id !== request.asset_id ||
    value.owner_id !== request.player_id ||
    value.owner_public_key !== request.owner_public_key ||
    typeof ownerVersion !== "number" ||
    !Number.isSafeInteger(ownerVersion) ||
    ownerVersion < 0 ||
    typeof value.owner_head_id !== "string" ||
    !/^[0-9a-f]{64}$/.test(value.owner_head_id) ||
    value.checkpoint_digest !== request.checkpoint.checkpoint_digest ||
    typeof inventoryEpoch !== "number" ||
    !Number.isSafeInteger(inventoryEpoch) ||
    inventoryEpoch < 0
  ) {
    return undefined;
  }
  return {
    authorityReceiptId,
    assetId: value.asset_id,
    ownerId: value.owner_id,
    ownerPublicKey: request.owner_public_key,
    ownerVersion,
    ownerHeadId: value.owner_head_id,
    checkpointDigest: value.checkpoint_digest,
    inventoryEpoch,
  };
}

function checkpointReceiptFromResponse(
  value: unknown,
  request: GameCheckpointVerificationRequest,
): GameCheckpointAuthorityReceipt | undefined {
  if (!isRecord(value) || value.version !== 1) return undefined;
  const authorityCheckpointReceiptId = value.authority_checkpoint_receipt_id;
  if (
    typeof authorityCheckpointReceiptId !== "string" ||
    !/^[0-9a-f]{64}$/.test(authorityCheckpointReceiptId) ||
    value.player_id !== request.player_id ||
    value.owner_public_key !== request.owner_public_key ||
    value.seed !== request.seed ||
    value.epoch !== request.checkpoint.epoch ||
    value.last_tick !== request.checkpoint.last_tick ||
    value.checkpoint_digest !== request.checkpoint.checkpoint_digest ||
    !Array.isArray(value.created_asset_ids) ||
    JSON.stringify(value.created_asset_ids) !==
      JSON.stringify(request.checkpoint.created_asset_ids)
  ) {
    return undefined;
  }
  return {
    authorityCheckpointReceiptId,
    playerId: request.player_id,
    ownerPublicKey: request.owner_public_key,
    seed: request.seed,
    epoch: request.checkpoint.epoch,
    lastTick: request.checkpoint.last_tick,
    checkpointDigest: request.checkpoint.checkpoint_digest,
    createdAssetIds: [...request.checkpoint.created_asset_ids],
  };
}

export async function requestGameCheckpointVerification(
  fetcher: AuthorityFetch,
  unit: string,
  request: GameCheckpointVerificationRequest,
): Promise<RequestGameCheckpointVerificationResult> {
  let response: Response;
  try {
    response = await fetcher(
      `/v1/pve/${encodeURIComponent(unit)}/game-checkpoint-verifications`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(request),
      },
    );
  } catch {
    return { ok: false, reason: "network_error" };
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return { ok: false, reason: "invalid_response" };
  }
  if (!isRecord(body)) return { ok: false, reason: "invalid_response" };
  if (!response.ok) {
    if (body.ok !== false || typeof body.error !== "string") {
      return { ok: false, reason: "invalid_response" };
    }
    const retryAfter = retryAfterSeconds(response);
    return {
      ok: false,
      reason: "authority_refused",
      error: body.error,
      status: response.status,
      ...(retryAfter === undefined ? {} : { retryAfterSeconds: retryAfter }),
    };
  }
  if (
    body.ok !== true ||
    (body.decision !== "verified" && body.decision !== "duplicate")
  ) {
    return { ok: false, reason: "invalid_response" };
  }
  const receipt = checkpointReceiptFromResponse(body.receipt, request);
  return receipt
    ? { ok: true, decision: body.decision, receipt }
    : { ok: false, reason: "invalid_response" };
}

export async function requestGameItemTransfer(
  fetcher: AuthorityFetch,
  unit: string,
  request: GameItemTransferRequest,
): Promise<RequestGameItemTransferResult> {
  let response: Response;
  try {
    response = await fetcher(
      `/v1/pve/${encodeURIComponent(unit)}/game-item-transfers`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          asset_id: request.assetId,
          authority_receipt_id: request.authorityReceiptId,
          previous_head_id: request.previousHeadId,
          from_owner_id: request.fromOwnerId,
          from_owner_public_key: request.fromOwnerPublicKey,
          to_owner_id: request.toOwnerId,
          to_owner_public_key: request.toOwnerPublicKey,
          previous_version: request.previousVersion,
          next_version: request.nextVersion,
          sender_signature: request.senderSignature,
          recipient_signature: request.recipientSignature,
        }),
      },
    );
  } catch {
    return { ok: false, reason: "network_error" };
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return { ok: false, reason: "invalid_response" };
  }
  if (!isRecord(body)) return { ok: false, reason: "invalid_response" };
  if (!response.ok) {
    if (
      body.ok === true &&
      body.transferred === false &&
      typeof body.decision === "string"
    ) {
      return {
        ok: false,
        reason: "transfer_refused",
        decision: body.decision,
        status: response.status,
      };
    }
    if (body.ok !== false || typeof body.error !== "string") {
      return { ok: false, reason: "invalid_response" };
    }
    const retryAfter = retryAfterSeconds(response);
    return {
      ok: false,
      reason: "authority_refused",
      error: body.error,
      status: response.status,
      ...(retryAfter === undefined ? {} : { retryAfterSeconds: retryAfter }),
    };
  }
  if (
    body.ok !== true ||
    body.transferred !== true ||
    (body.decision !== "transferred" && body.decision !== "duplicate") ||
    !isRecord(body.transfer) ||
    !isRecord(body.owner_head)
  ) {
    return { ok: false, reason: "invalid_response" };
  }
  const transfer = body.transfer;
  const ownerHead = body.owner_head;
  if (
    transfer.version !== 1 ||
    typeof transfer.transfer_id !== "string" ||
    !/^[0-9a-f]{64}$/.test(transfer.transfer_id) ||
    transfer.asset_id !== request.assetId ||
    transfer.authority_receipt_id !== request.authorityReceiptId ||
    transfer.previous_head_id !== request.previousHeadId ||
    typeof transfer.next_head_id !== "string" ||
    !/^[0-9a-f]{64}$/.test(transfer.next_head_id) ||
    transfer.from_owner_id !== request.fromOwnerId ||
    transfer.from_owner_public_key !== request.fromOwnerPublicKey ||
    transfer.to_owner_id !== request.toOwnerId ||
    transfer.to_owner_public_key !== request.toOwnerPublicKey ||
    transfer.previous_version !== request.previousVersion ||
    transfer.next_version !== request.nextVersion ||
    transfer.sender_signature !== request.senderSignature ||
    transfer.recipient_signature !== request.recipientSignature ||
    typeof transfer.transferred_at !== "number" ||
    !Number.isSafeInteger(transfer.transferred_at) ||
    transfer.transferred_at < 0 ||
    ownerHead.version !== 1 ||
    ownerHead.asset_id !== request.assetId ||
    ownerHead.authority_receipt_id !== request.authorityReceiptId ||
    ownerHead.owner_id !== request.toOwnerId ||
    ownerHead.owner_public_key !== request.toOwnerPublicKey ||
    ownerHead.owner_version !== request.nextVersion ||
    ownerHead.owner_head_id !== transfer.next_head_id ||
    ownerHead.last_transfer_id !== transfer.transfer_id ||
    typeof ownerHead.updated_at !== "number" ||
    !Number.isSafeInteger(ownerHead.updated_at) ||
    ownerHead.updated_at < 0
  ) {
    return { ok: false, reason: "invalid_response" };
  }
  return {
    ok: true,
    decision: body.decision,
    transfer: {
      transferId: transfer.transfer_id,
      assetId: request.assetId,
      authorityReceiptId: request.authorityReceiptId,
      previousHeadId: request.previousHeadId,
      nextHeadId: transfer.next_head_id,
      fromOwnerId: request.fromOwnerId,
      fromOwnerPublicKey: request.fromOwnerPublicKey,
      toOwnerId: request.toOwnerId,
      toOwnerPublicKey: request.toOwnerPublicKey,
      previousVersion: request.previousVersion,
      nextVersion: request.nextVersion,
      senderSignature: request.senderSignature,
      recipientSignature: request.recipientSignature,
      transferredAt: transfer.transferred_at,
    },
    ownerHead: {
      assetId: request.assetId,
      authorityReceiptId: request.authorityReceiptId,
      ownerId: request.toOwnerId,
      ownerPublicKey: request.toOwnerPublicKey,
      ownerVersion: request.nextVersion,
      ownerHeadId: transfer.next_head_id,
      lastTransferId: transfer.transfer_id,
      updatedAt: ownerHead.updated_at,
    },
  };
}

export async function requestGameMarketListing(
  fetcher: AuthorityFetch,
  unit: string,
  request: GameMarketListingRequest,
): Promise<RequestGameMarketListingResult> {
  let response: Response;
  try {
    response = await fetcher(
      `/v1/pve/${encodeURIComponent(unit)}/game-market-listings`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          asset_id: request.assetId,
          seller_id: request.sellerId,
          authority_receipt_id: request.authorityReceiptId,
          owner_public_key: request.ownerPublicKey,
          owner_version: request.ownerVersion,
          owner_head_id: request.ownerHeadId,
          listing_nonce: request.listingNonce,
          owner_signature: request.ownerSignature,
        }),
      },
    );
  } catch {
    return { ok: false, reason: "network_error" };
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return { ok: false, reason: "invalid_response" };
  }
  if (!isRecord(body)) return { ok: false, reason: "invalid_response" };
  if (!response.ok) {
    if (
      body.ok === true &&
      body.allowed === false &&
      typeof body.decision === "string"
    ) {
      const lineageStatus = body.decision === "asset_lineage_revoked"
        ? lineageStatusFromResponse(body.lineage_settlement, request.assetId)
        : undefined;
      if (body.decision === "asset_lineage_revoked" && !lineageStatus) {
        return { ok: false, reason: "invalid_response" };
      }
      return {
        ok: false,
        reason: "listing_refused",
        decision: body.decision,
        status: response.status,
        ...(lineageStatus ? { lineageStatus } : {}),
      };
    }
    if (body.ok !== false || typeof body.error !== "string") {
      return { ok: false, reason: "invalid_response" };
    }
    const retryAfter = retryAfterSeconds(response);
    return {
      ok: false,
      reason: "authority_refused",
      error: body.error,
      status: response.status,
      ...(retryAfter === undefined ? {} : { retryAfterSeconds: retryAfter }),
    };
  }
  if (
    body.ok !== true ||
    body.allowed !== true ||
    (body.decision !== "listed" && body.decision !== "duplicate") ||
    !isRecord(body.listing)
  ) {
    return { ok: false, reason: "invalid_response" };
  }
  const listing = body.listing;
  if (
    listing.version !== 1 ||
    typeof listing.listing_id !== "string" ||
    !/^[0-9a-f]{64}$/.test(listing.listing_id) ||
    listing.asset_id !== request.assetId ||
    listing.seller_id !== request.sellerId ||
    listing.authority_receipt_id !== request.authorityReceiptId ||
    listing.owner_public_key !== request.ownerPublicKey ||
    listing.owner_version !== request.ownerVersion ||
    listing.owner_head_id !== request.ownerHeadId ||
    listing.listing_nonce !== request.listingNonce ||
    listing.owner_signature !== request.ownerSignature ||
    typeof listing.checkpoint_digest !== "string" ||
    typeof listing.inventory_epoch !== "number" ||
    !Number.isSafeInteger(listing.inventory_epoch) ||
    listing.inventory_epoch < 0 ||
    typeof listing.item_type !== "string" ||
    typeof listing.power !== "number" ||
    !Number.isSafeInteger(listing.power) ||
    listing.power <= 0 ||
    listing.status !== "active" ||
    typeof listing.listed_at !== "number" ||
    !Number.isSafeInteger(listing.listed_at) ||
    listing.listed_at < 0
  ) {
    return { ok: false, reason: "invalid_response" };
  }
  return {
    ok: true,
    decision: body.decision,
    listing: {
      listingId: listing.listing_id,
      assetId: request.assetId,
      sellerId: request.sellerId,
      authorityReceiptId: request.authorityReceiptId,
      ownerPublicKey: request.ownerPublicKey,
      ownerVersion: request.ownerVersion,
      ownerHeadId: request.ownerHeadId,
      listingNonce: request.listingNonce,
      ownerSignature: request.ownerSignature,
      checkpointDigest: listing.checkpoint_digest,
      inventoryEpoch: listing.inventory_epoch,
      itemType: listing.item_type,
      power: listing.power,
      status: "active",
      listedAt: listing.listed_at,
    },
  };
}

export async function requestGameMarketListingCancellation(
  fetcher: AuthorityFetch,
  unit: string,
  request: GameMarketListingCancellationRequest,
): Promise<RequestGameMarketListingCancellationResult> {
  let response: Response;
  try {
    response = await fetcher(
      `/v1/pve/${encodeURIComponent(unit)}/game-market-listing-cancellations`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          listing_id: request.listingId,
          asset_id: request.assetId,
          seller_id: request.sellerId,
          authority_receipt_id: request.authorityReceiptId,
          owner_public_key: request.ownerPublicKey,
          owner_version: request.ownerVersion,
          owner_head_id: request.ownerHeadId,
          listing_nonce: request.listingNonce,
          cancel_signature: request.cancelSignature,
        }),
      },
    );
  } catch {
    return { ok: false, reason: "network_error" };
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return { ok: false, reason: "invalid_response" };
  }
  if (!isRecord(body)) return { ok: false, reason: "invalid_response" };
  if (!response.ok) {
    if (
      body.ok === true &&
      body.canceled === false &&
      typeof body.decision === "string"
    ) {
      return {
        ok: false,
        reason: "cancellation_refused",
        decision: body.decision,
        status: response.status,
      };
    }
    if (body.ok !== false || typeof body.error !== "string") {
      return { ok: false, reason: "invalid_response" };
    }
    const retryAfter = retryAfterSeconds(response);
    return {
      ok: false,
      reason: "authority_refused",
      error: body.error,
      status: response.status,
      ...(retryAfter === undefined ? {} : { retryAfterSeconds: retryAfter }),
    };
  }
  if (
    body.ok !== true ||
    body.canceled !== true ||
    (body.decision !== "canceled" && body.decision !== "duplicate") ||
    !isRecord(body.listing)
  ) {
    return { ok: false, reason: "invalid_response" };
  }
  const listing = body.listing;
  if (
    listing.version !== 1 ||
    listing.listing_id !== request.listingId ||
    listing.asset_id !== request.assetId ||
    listing.seller_id !== request.sellerId ||
    listing.authority_receipt_id !== request.authorityReceiptId ||
    listing.owner_public_key !== request.ownerPublicKey ||
    listing.owner_version !== request.ownerVersion ||
    listing.owner_head_id !== request.ownerHeadId ||
    listing.listing_nonce !== request.listingNonce ||
    typeof listing.owner_signature !== "string" ||
    !/^[0-9a-f]{128}$/.test(listing.owner_signature) ||
    typeof listing.checkpoint_digest !== "string" ||
    typeof listing.inventory_epoch !== "number" ||
    !Number.isSafeInteger(listing.inventory_epoch) ||
    listing.inventory_epoch < 0 ||
    typeof listing.item_type !== "string" ||
    typeof listing.power !== "number" ||
    !Number.isSafeInteger(listing.power) ||
    listing.power <= 0 ||
    listing.status !== "canceled" ||
    typeof listing.listed_at !== "number" ||
    !Number.isSafeInteger(listing.listed_at) ||
    listing.listed_at < 0 ||
    listing.cancel_signature !== request.cancelSignature ||
    typeof listing.canceled_at !== "number" ||
    !Number.isSafeInteger(listing.canceled_at) ||
    listing.canceled_at < listing.listed_at
  ) {
    return { ok: false, reason: "invalid_response" };
  }
  return {
    ok: true,
    decision: body.decision,
    listing: {
      listingId: request.listingId,
      assetId: request.assetId,
      sellerId: request.sellerId,
      authorityReceiptId: request.authorityReceiptId,
      ownerPublicKey: request.ownerPublicKey,
      ownerVersion: request.ownerVersion,
      ownerHeadId: request.ownerHeadId,
      listingNonce: request.listingNonce,
      ownerSignature: listing.owner_signature,
      checkpointDigest: listing.checkpoint_digest,
      inventoryEpoch: listing.inventory_epoch,
      itemType: listing.item_type,
      power: listing.power,
      status: "canceled",
      listedAt: listing.listed_at,
      cancelSignature: request.cancelSignature,
      canceledAt: listing.canceled_at,
    },
  };
}

export async function requestGameItemVerification(
  fetcher: AuthorityFetch,
  unit: string,
  request: GameItemVerificationRequest,
): Promise<RequestGameItemVerificationResult> {
  let response: Response;
  try {
    response = await fetcher(
      `/v1/pve/${encodeURIComponent(unit)}/game-item-verifications`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(request),
      },
    );
  } catch {
    return { ok: false, reason: "network_error" };
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return { ok: false, reason: "invalid_response" };
  }
  if (!isRecord(body)) return { ok: false, reason: "invalid_response" };
  if (!response.ok) {
    if (body.ok !== false || typeof body.error !== "string") {
      return { ok: false, reason: "invalid_response" };
    }
    const retryAfter = retryAfterSeconds(response);
    return {
      ok: false,
      reason: "authority_refused",
      error: body.error,
      status: response.status,
      ...(retryAfter === undefined ? {} : { retryAfterSeconds: retryAfter }),
    };
  }
  if (
    body.ok !== true ||
    (body.decision !== "verified" && body.decision !== "duplicate")
  ) {
    return { ok: false, reason: "invalid_response" };
  }
  const receipt = receiptFromResponse(body.receipt, request);
  return receipt
    ? { ok: true, decision: body.decision, receipt }
    : { ok: false, reason: "invalid_response" };
}
