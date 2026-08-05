import {
  gameItemTransferProofDigest,
  verifyGameItemTransferProof,
  type GameItemTransferProofBoundary,
  type GameOwnerDigestAdapter,
  type GameOwnerSignatureVerifier,
} from "./owner-authentication";

export interface GameAssetOrigin {
  assetId: string;
  authorityReceiptId: string;
  ownerId: string;
  ownerPublicKey: string;
}

export interface GameAssetOwnershipHead extends GameAssetOrigin {
  version: number;
  lastTransferId: string;
  headId: string;
}

export interface GameItemTransferRequest extends GameItemTransferProofBoundary {
  senderSignature: string;
  recipientSignature: string;
}

export type VerifyAndApplyGameItemTransferResult =
  | {
      ok: true;
      transferId: string;
      head: GameAssetOwnershipHead;
    }
  | {
      ok: false;
      reason:
        | "invalid_transfer"
        | "authority_receipt_mismatch"
        | "stale_owner_head"
        | "invalid_owner_version"
        | "unchanged_owner"
        | "sender_authentication_refused"
        | "recipient_authentication_refused";
    };

function isBounded(value: string, maximum: number): boolean {
  return value.length > 0 && value.length <= maximum;
}

function isDigest(value: string): boolean {
  return /^[0-9a-f]{64}$/.test(value);
}

function isPublicKey(value: string): boolean {
  return /^[0-9a-f]{64}$/.test(value);
}

function isSignature(value: string): boolean {
  return /^[0-9a-f]{128}$/.test(value);
}

function isSafeVersion(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

export function canonicalGameAssetOwnershipHead(
  unit: string,
  head: Omit<GameAssetOwnershipHead, "headId">,
): string {
  return JSON.stringify([
    "audit-survivors-asset-owner-head-v1",
    unit,
    head.assetId,
    head.authorityReceiptId,
    head.ownerId,
    head.ownerPublicKey,
    head.version,
    head.lastTransferId,
  ]);
}

function ownershipHeadWithId(
  unit: string,
  head: Omit<GameAssetOwnershipHead, "headId">,
  digest: GameOwnerDigestAdapter,
): GameAssetOwnershipHead {
  return {
    ...head,
    headId: digest.hashString(canonicalGameAssetOwnershipHead(unit, head)),
  };
}

export function createInitialGameAssetOwnershipHead(
  unit: string,
  origin: GameAssetOrigin,
  digest: GameOwnerDigestAdapter,
): GameAssetOwnershipHead {
  if (
    !isBounded(unit, 128) ||
    !isBounded(origin.assetId, 1_024) ||
    !isDigest(origin.authorityReceiptId) ||
    !isBounded(origin.ownerId, 256) ||
    !isPublicKey(origin.ownerPublicKey)
  ) {
    throw new Error("invalid game asset origin");
  }
  return ownershipHeadWithId(unit, {
    ...origin,
    version: 0,
    lastTransferId: origin.authorityReceiptId,
  }, digest);
}

export function verifyAndApplyGameItemTransfer(
  unit: string,
  current: GameAssetOwnershipHead,
  request: GameItemTransferRequest,
  digest: GameOwnerDigestAdapter,
  verifier: GameOwnerSignatureVerifier,
): VerifyAndApplyGameItemTransferResult {
  if (
    !isBounded(unit, 128) ||
    !isBounded(request.assetId, 1_024) ||
    !isDigest(request.authorityReceiptId) ||
    !isDigest(request.previousHeadId) ||
    !isBounded(request.fromOwnerId, 256) ||
    !isPublicKey(request.fromOwnerPublicKey) ||
    !isBounded(request.toOwnerId, 256) ||
    !isPublicKey(request.toOwnerPublicKey) ||
    !isSafeVersion(request.previousVersion) ||
    !isSafeVersion(request.nextVersion) ||
    !isSignature(request.senderSignature) ||
    !isSignature(request.recipientSignature)
  ) {
    return { ok: false, reason: "invalid_transfer" };
  }
  if (
    current.authorityReceiptId !== request.authorityReceiptId ||
    current.assetId !== request.assetId
  ) {
    return { ok: false, reason: "authority_receipt_mismatch" };
  }
  if (
    current.headId !== request.previousHeadId ||
    current.ownerId !== request.fromOwnerId ||
    current.ownerPublicKey !== request.fromOwnerPublicKey ||
    current.version !== request.previousVersion
  ) {
    return { ok: false, reason: "stale_owner_head" };
  }
  if (
    request.previousVersion === Number.MAX_SAFE_INTEGER ||
    request.nextVersion !== request.previousVersion + 1
  ) {
    return { ok: false, reason: "invalid_owner_version" };
  }
  if (
    request.fromOwnerId === request.toOwnerId &&
    request.fromOwnerPublicKey === request.toOwnerPublicKey
  ) {
    return { ok: false, reason: "unchanged_owner" };
  }
  const proof = verifyGameItemTransferProof(
    unit,
    request,
    request.senderSignature,
    request.recipientSignature,
    digest,
    verifier,
  );
  if (!proof.ok) return proof;
  const transferId = gameItemTransferProofDigest(unit, request, digest);
  return {
    ok: true,
    transferId,
    head: ownershipHeadWithId(unit, {
      assetId: request.assetId,
      authorityReceiptId: request.authorityReceiptId,
      ownerId: request.toOwnerId,
      ownerPublicKey: request.toOwnerPublicKey,
      version: request.nextVersion,
      lastTransferId: transferId,
    }, digest),
  };
}
