import type { AuditDigestAdapter } from "../audit/journal";

export type GameOwnerDigestAdapter = Pick<AuditDigestAdapter, "hashString">;

/** Asynchronous digest boundary for browser and Worker WebCrypto adapters. */
export interface AsyncGameOwnerDigestAdapter {
  hashString(value: string): Promise<string>;
}

export interface GameOwnerSignatureVerifier {
  verify(publicKey: string, digest: string, signature: string): boolean;
}

export interface AsyncGameOwnerSignatureVerifier {
  verify(
    publicKey: string,
    digest: string,
    signature: string,
  ): Promise<boolean>;
}

export interface GameOwnerSigner {
  publicKey: string;
  signDigest(digest: string): string;
}

/** WebCrypto-compatible signer used at browser/Worker I/O boundaries. */
export interface AsyncGameOwnerSigner {
  publicKey: string;
  signDigest(digest: string): Promise<string>;
}

export interface GameItemOwnerProofBoundary {
  playerId: string;
  seed: number;
  checkpointDigest: string;
  assetId: string;
  ownerPublicKey: string;
}

export interface GameMarketListingProofBoundary {
  assetId: string;
  sellerId: string;
  authorityReceiptId: string;
  ownerPublicKey: string;
  ownerVersion: number;
  ownerHeadId: string;
  listingNonce: string;
}

export interface GameMarketListingCancelProofBoundary
  extends GameMarketListingProofBoundary {
  listingId: string;
}

export interface GameItemTransferProofBoundary {
  assetId: string;
  authorityReceiptId: string;
  previousHeadId: string;
  fromOwnerId: string;
  fromOwnerPublicKey: string;
  toOwnerId: string;
  toOwnerPublicKey: string;
  previousVersion: number;
  nextVersion: number;
}

export function canonicalGameItemOwnerProof(
  unit: string,
  boundary: GameItemOwnerProofBoundary,
): string {
  return JSON.stringify([
    "audit-survivors-item-owner-proof-v1",
    unit,
    boundary.playerId,
    boundary.seed >>> 0,
    boundary.checkpointDigest,
    boundary.assetId,
    boundary.ownerPublicKey,
  ]);
}

export function gameItemOwnerProofDigest(
  unit: string,
  boundary: GameItemOwnerProofBoundary,
  digest: GameOwnerDigestAdapter,
): string {
  return digest.hashString(canonicalGameItemOwnerProof(unit, boundary));
}

export function gameItemOwnerProofDigestAsync(
  unit: string,
  boundary: GameItemOwnerProofBoundary,
  digest: AsyncGameOwnerDigestAdapter,
): Promise<string> {
  return digest.hashString(canonicalGameItemOwnerProof(unit, boundary));
}

export function signGameItemOwnerProof(
  unit: string,
  boundary: GameItemOwnerProofBoundary,
  digest: GameOwnerDigestAdapter,
  signer: GameOwnerSigner,
): string {
  if (boundary.ownerPublicKey !== signer.publicKey) {
    throw new Error("item owner proof key does not match signer");
  }
  return signer.signDigest(gameItemOwnerProofDigest(unit, boundary, digest));
}

export async function signGameItemOwnerProofAsync(
  unit: string,
  boundary: GameItemOwnerProofBoundary,
  digest: AsyncGameOwnerDigestAdapter,
  signer: AsyncGameOwnerSigner,
): Promise<string> {
  if (boundary.ownerPublicKey !== signer.publicKey) {
    throw new Error("item owner proof key does not match signer");
  }
  return signer.signDigest(
    await gameItemOwnerProofDigestAsync(unit, boundary, digest),
  );
}

export function verifyGameItemOwnerProof(
  unit: string,
  boundary: GameItemOwnerProofBoundary,
  signature: string,
  digest: GameOwnerDigestAdapter,
  verifier: GameOwnerSignatureVerifier,
): boolean {
  return verifier.verify(
    boundary.ownerPublicKey,
    gameItemOwnerProofDigest(unit, boundary, digest),
    signature,
  );
}

export async function verifyGameItemOwnerProofAsync(
  unit: string,
  boundary: GameItemOwnerProofBoundary,
  signature: string,
  digest: AsyncGameOwnerDigestAdapter,
  verifier: AsyncGameOwnerSignatureVerifier,
): Promise<boolean> {
  return verifier.verify(
    boundary.ownerPublicKey,
    await gameItemOwnerProofDigestAsync(unit, boundary, digest),
    signature,
  );
}

export function canonicalGameMarketListingProof(
  unit: string,
  boundary: GameMarketListingProofBoundary,
): string {
  return JSON.stringify([
    "audit-survivors-market-listing-owner-proof-v2",
    unit,
    boundary.assetId,
    boundary.sellerId,
    boundary.authorityReceiptId,
    boundary.ownerPublicKey,
    boundary.ownerVersion,
    boundary.ownerHeadId,
    boundary.listingNonce,
  ]);
}

export function gameMarketListingProofDigest(
  unit: string,
  boundary: GameMarketListingProofBoundary,
  digest: GameOwnerDigestAdapter,
): string {
  return digest.hashString(canonicalGameMarketListingProof(unit, boundary));
}

export function gameMarketListingProofDigestAsync(
  unit: string,
  boundary: GameMarketListingProofBoundary,
  digest: AsyncGameOwnerDigestAdapter,
): Promise<string> {
  return digest.hashString(canonicalGameMarketListingProof(unit, boundary));
}

export function canonicalGameMarketListing(
  unit: string,
  boundary: GameMarketListingProofBoundary,
): string {
  return JSON.stringify([
    "audit-survivors-market-listing-v3",
    unit,
    boundary.assetId,
    boundary.sellerId,
    boundary.authorityReceiptId,
    boundary.ownerPublicKey,
    boundary.ownerVersion,
    boundary.ownerHeadId,
    boundary.listingNonce,
  ]);
}

export function gameMarketListingId(
  unit: string,
  boundary: GameMarketListingProofBoundary,
  digest: GameOwnerDigestAdapter,
): string {
  return digest.hashString(canonicalGameMarketListing(unit, boundary));
}

export function gameMarketListingIdAsync(
  unit: string,
  boundary: GameMarketListingProofBoundary,
  digest: AsyncGameOwnerDigestAdapter,
): Promise<string> {
  return digest.hashString(canonicalGameMarketListing(unit, boundary));
}

export function signGameMarketListingProof(
  unit: string,
  boundary: GameMarketListingProofBoundary,
  digest: GameOwnerDigestAdapter,
  signer: GameOwnerSigner,
): string {
  if (boundary.ownerPublicKey !== signer.publicKey) {
    throw new Error("market listing proof key does not match signer");
  }
  return signer.signDigest(gameMarketListingProofDigest(unit, boundary, digest));
}

export async function signGameMarketListingProofAsync(
  unit: string,
  boundary: GameMarketListingProofBoundary,
  digest: AsyncGameOwnerDigestAdapter,
  signer: AsyncGameOwnerSigner,
): Promise<string> {
  if (boundary.ownerPublicKey !== signer.publicKey) {
    throw new Error("market listing proof key does not match signer");
  }
  return signer.signDigest(
    await gameMarketListingProofDigestAsync(unit, boundary, digest),
  );
}

export function verifyGameMarketListingProof(
  unit: string,
  boundary: GameMarketListingProofBoundary,
  signature: string,
  digest: GameOwnerDigestAdapter,
  verifier: GameOwnerSignatureVerifier,
): boolean {
  return verifier.verify(
    boundary.ownerPublicKey,
    gameMarketListingProofDigest(unit, boundary, digest),
    signature,
  );
}

export async function verifyGameMarketListingProofAsync(
  unit: string,
  boundary: GameMarketListingProofBoundary,
  signature: string,
  digest: AsyncGameOwnerDigestAdapter,
  verifier: AsyncGameOwnerSignatureVerifier,
): Promise<boolean> {
  return verifier.verify(
    boundary.ownerPublicKey,
    await gameMarketListingProofDigestAsync(unit, boundary, digest),
    signature,
  );
}

export function canonicalGameMarketListingCancelProof(
  unit: string,
  boundary: GameMarketListingCancelProofBoundary,
): string {
  return JSON.stringify([
    "audit-survivors-market-listing-cancel-proof-v2",
    unit,
    boundary.listingId,
    boundary.assetId,
    boundary.sellerId,
    boundary.authorityReceiptId,
    boundary.ownerPublicKey,
    boundary.ownerVersion,
    boundary.ownerHeadId,
    boundary.listingNonce,
  ]);
}

export function gameMarketListingCancelProofDigest(
  unit: string,
  boundary: GameMarketListingCancelProofBoundary,
  digest: GameOwnerDigestAdapter,
): string {
  return digest.hashString(
    canonicalGameMarketListingCancelProof(unit, boundary),
  );
}

export function gameMarketListingCancelProofDigestAsync(
  unit: string,
  boundary: GameMarketListingCancelProofBoundary,
  digest: AsyncGameOwnerDigestAdapter,
): Promise<string> {
  return digest.hashString(
    canonicalGameMarketListingCancelProof(unit, boundary),
  );
}

export function signGameMarketListingCancelProof(
  unit: string,
  boundary: GameMarketListingCancelProofBoundary,
  digest: GameOwnerDigestAdapter,
  signer: GameOwnerSigner,
): string {
  if (boundary.ownerPublicKey !== signer.publicKey) {
    throw new Error("market listing cancellation key does not match signer");
  }
  return signer.signDigest(
    gameMarketListingCancelProofDigest(unit, boundary, digest),
  );
}

export async function signGameMarketListingCancelProofAsync(
  unit: string,
  boundary: GameMarketListingCancelProofBoundary,
  digest: AsyncGameOwnerDigestAdapter,
  signer: AsyncGameOwnerSigner,
): Promise<string> {
  if (boundary.ownerPublicKey !== signer.publicKey) {
    throw new Error("market listing cancellation key does not match signer");
  }
  return signer.signDigest(
    await gameMarketListingCancelProofDigestAsync(unit, boundary, digest),
  );
}

export function verifyGameMarketListingCancelProof(
  unit: string,
  boundary: GameMarketListingCancelProofBoundary,
  signature: string,
  digest: GameOwnerDigestAdapter,
  verifier: GameOwnerSignatureVerifier,
): boolean {
  return verifier.verify(
    boundary.ownerPublicKey,
    gameMarketListingCancelProofDigest(unit, boundary, digest),
    signature,
  );
}

export async function verifyGameMarketListingCancelProofAsync(
  unit: string,
  boundary: GameMarketListingCancelProofBoundary,
  signature: string,
  digest: AsyncGameOwnerDigestAdapter,
  verifier: AsyncGameOwnerSignatureVerifier,
): Promise<boolean> {
  return verifier.verify(
    boundary.ownerPublicKey,
    await gameMarketListingCancelProofDigestAsync(unit, boundary, digest),
    signature,
  );
}

export function canonicalGameItemTransferProof(
  unit: string,
  boundary: GameItemTransferProofBoundary,
): string {
  return JSON.stringify([
    "audit-survivors-item-transfer-proof-v1",
    unit,
    boundary.assetId,
    boundary.authorityReceiptId,
    boundary.previousHeadId,
    boundary.fromOwnerId,
    boundary.fromOwnerPublicKey,
    boundary.toOwnerId,
    boundary.toOwnerPublicKey,
    boundary.previousVersion,
    boundary.nextVersion,
  ]);
}

export function gameItemTransferProofDigest(
  unit: string,
  boundary: GameItemTransferProofBoundary,
  digest: GameOwnerDigestAdapter,
): string {
  return digest.hashString(canonicalGameItemTransferProof(unit, boundary));
}

export function gameItemTransferProofDigestAsync(
  unit: string,
  boundary: GameItemTransferProofBoundary,
  digest: AsyncGameOwnerDigestAdapter,
): Promise<string> {
  return digest.hashString(canonicalGameItemTransferProof(unit, boundary));
}

export function signGameItemTransferProof(
  unit: string,
  boundary: GameItemTransferProofBoundary,
  digest: GameOwnerDigestAdapter,
  signer: GameOwnerSigner,
): string {
  if (
    signer.publicKey !== boundary.fromOwnerPublicKey &&
    signer.publicKey !== boundary.toOwnerPublicKey
  ) {
    throw new Error("item transfer signer is not a transfer participant");
  }
  return signer.signDigest(gameItemTransferProofDigest(unit, boundary, digest));
}

export async function signGameItemTransferProofAsync(
  unit: string,
  boundary: GameItemTransferProofBoundary,
  digest: AsyncGameOwnerDigestAdapter,
  signer: AsyncGameOwnerSigner,
): Promise<string> {
  if (
    signer.publicKey !== boundary.fromOwnerPublicKey &&
    signer.publicKey !== boundary.toOwnerPublicKey
  ) {
    throw new Error("item transfer signer is not a transfer participant");
  }
  return signer.signDigest(
    await gameItemTransferProofDigestAsync(unit, boundary, digest),
  );
}

export type VerifyGameItemTransferProofResult =
  | { ok: true }
  | {
      ok: false;
      reason:
        | "sender_authentication_refused"
        | "recipient_authentication_refused";
    };

export function verifyGameItemTransferProof(
  unit: string,
  boundary: GameItemTransferProofBoundary,
  senderSignature: string,
  recipientSignature: string,
  digest: GameOwnerDigestAdapter,
  verifier: GameOwnerSignatureVerifier,
): VerifyGameItemTransferProofResult {
  const proofDigest = gameItemTransferProofDigest(unit, boundary, digest);
  if (!verifier.verify(
    boundary.fromOwnerPublicKey,
    proofDigest,
    senderSignature,
  )) {
    return { ok: false, reason: "sender_authentication_refused" };
  }
  if (!verifier.verify(
    boundary.toOwnerPublicKey,
    proofDigest,
    recipientSignature,
  )) {
    return { ok: false, reason: "recipient_authentication_refused" };
  }
  return { ok: true };
}

export async function verifyGameItemTransferProofAsync(
  unit: string,
  boundary: GameItemTransferProofBoundary,
  senderSignature: string,
  recipientSignature: string,
  digest: AsyncGameOwnerDigestAdapter,
  verifier: AsyncGameOwnerSignatureVerifier,
): Promise<VerifyGameItemTransferProofResult> {
  const proofDigest = await gameItemTransferProofDigestAsync(
    unit,
    boundary,
    digest,
  );
  if (!await verifier.verify(
    boundary.fromOwnerPublicKey,
    proofDigest,
    senderSignature,
  )) {
    return { ok: false, reason: "sender_authentication_refused" };
  }
  if (!await verifier.verify(
    boundary.toOwnerPublicKey,
    proofDigest,
    recipientSignature,
  )) {
    return { ok: false, reason: "recipient_authentication_refused" };
  }
  return { ok: true };
}
