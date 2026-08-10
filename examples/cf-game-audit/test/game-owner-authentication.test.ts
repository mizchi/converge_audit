import { describe, expect, it } from "vitest";
import {
  audit_browser_ed25519_public_key,
  audit_browser_ed25519_sign,
  audit_browser_ed25519_verify,
  audit_browser_sha256,
} from "../../../_build/js/release/build/x/game_audit/browser_bridge/browser_bridge.js";
import {
  signGameItemOwnerProofAsync,
  signGameItemTransferProofAsync,
  signGameMarketListingCancelProofAsync,
  signGameMarketListingProofAsync,
  gameItemOwnerProofDigest,
  gameItemTransferProofDigest,
  gameItemTransferProofDigestAsync,
  gameMarketListingId,
  gameMarketListingIdAsync,
  gameMarketListingCancelProofDigest,
  gameMarketListingProofDigest,
  verifyGameItemOwnerProofAsync,
  verifyGameItemOwnerProof,
  verifyGameItemTransferProofAsync,
  verifyGameItemTransferProof,
  verifyGameMarketListingCancelProofAsync,
  verifyGameMarketListingCancelProof,
  verifyGameMarketListingProofAsync,
  verifyGameMarketListingProof,
  type GameOwnerSignatureVerifier,
} from "../game/authority/owner-authentication";
import {
  createStandardWebCryptoBackend,
} from "../../player-local-runtime/crypto-backend";

const seed =
  "000102030405060708090a0b0c0d0e0f" +
  "101112131415161718191a1b1c1d1e1f";
const publicKey = audit_browser_ed25519_public_key(seed);
const verifier: GameOwnerSignatureVerifier = {
  verify: audit_browser_ed25519_verify,
};
const digest = { hashString: audit_browser_sha256 };

describe("reference game owner authentication", () => {
  it("keeps standard WebCrypto and the MoonBit verifier interoperable", async () => {
    const standard = createStandardWebCryptoBackend(crypto);
    const signer = (await standard.importLegacySeed(seed, publicKey)).signer;
    const item = {
      playerId: "player-1",
      seed: 0x1234,
      checkpointDigest: "c".repeat(64),
      assetId: "loot-1",
      ownerPublicKey: publicKey,
    };
    const listing = {
      assetId: item.assetId,
      sellerId: item.playerId,
      authorityReceiptId: "a".repeat(64),
      ownerPublicKey: publicKey,
      ownerVersion: 0,
      ownerHeadId: "b".repeat(64),
      listingNonce: "9".repeat(64),
    };
    const cancellation = {
      ...listing,
      listingId: "d".repeat(64),
    };
    const transfer = {
      assetId: item.assetId,
      authorityReceiptId: listing.authorityReceiptId,
      previousHeadId: listing.ownerHeadId,
      fromOwnerId: item.playerId,
      fromOwnerPublicKey: publicKey,
      toOwnerId: "player-2",
      toOwnerPublicKey: publicKey,
      previousVersion: 0,
      nextVersion: 1,
    };

    const itemSignature = await signGameItemOwnerProofAsync(
      "run-1",
      item,
      standard,
      signer,
    );
    const listingSignature = await signGameMarketListingProofAsync(
      "run-1",
      listing,
      standard,
      signer,
    );
    const cancellationSignature =
      await signGameMarketListingCancelProofAsync(
        "run-1",
        cancellation,
        standard,
        signer,
      );
    const transferSignature = await signGameItemTransferProofAsync(
      "run-1",
      transfer,
      standard,
      signer,
    );

    await expect(gameItemTransferProofDigestAsync(
      "run-1",
      transfer,
      standard,
    )).resolves.toBe(gameItemTransferProofDigest("run-1", transfer, digest));
    await expect(gameMarketListingIdAsync(
      "run-1",
      listing,
      standard,
    )).resolves.toBe(gameMarketListingId("run-1", listing, digest));

    await expect(verifyGameItemOwnerProofAsync(
      "run-1",
      item,
      itemSignature,
      standard,
      standard,
    )).resolves.toBe(true);
    await expect(verifyGameMarketListingProofAsync(
      "run-1",
      listing,
      listingSignature,
      standard,
      standard,
    )).resolves.toBe(true);
    await expect(verifyGameMarketListingCancelProofAsync(
      "run-1",
      cancellation,
      cancellationSignature,
      standard,
      standard,
    )).resolves.toBe(true);
    await expect(verifyGameItemTransferProofAsync(
      "run-1",
      transfer,
      transferSignature,
      transferSignature,
      standard,
      standard,
    )).resolves.toEqual({ ok: true });

    expect(verifyGameItemOwnerProof(
      "run-1",
      item,
      itemSignature,
      digest,
      verifier,
    )).toBe(true);
    expect(verifyGameMarketListingProof(
      "run-1",
      listing,
      listingSignature,
      digest,
      verifier,
    )).toBe(true);
    expect(verifyGameMarketListingCancelProof(
      "run-1",
      cancellation,
      cancellationSignature,
      digest,
      verifier,
    )).toBe(true);
    expect(verifyGameItemTransferProof(
      "run-1",
      transfer,
      transferSignature,
      transferSignature,
      digest,
      verifier,
    )).toEqual({ ok: true });
  });

  it("binds item settlement to its run, owner key, asset, and checkpoint", () => {
    const boundary = {
      playerId: "player-1",
      seed: 0x1234,
      checkpointDigest: "c".repeat(64),
      assetId: "loot-1",
      ownerPublicKey: publicKey,
    };
    const proofDigest = gameItemOwnerProofDigest("run-1", boundary, digest);
    const signature = audit_browser_ed25519_sign(seed, proofDigest);

    expect(verifyGameItemOwnerProof(
      "run-1",
      boundary,
      signature,
      digest,
      verifier,
    )).toBe(true);
    expect(verifyGameItemOwnerProof(
      "run-2",
      boundary,
      signature,
      digest,
      verifier,
    )).toBe(false);
    expect(verifyGameItemOwnerProof(
      "run-1",
      { ...boundary, assetId: "stolen-loot" },
      signature,
      digest,
      verifier,
    )).toBe(false);
  });

  it("binds a market action to the authority receipt and origin key", () => {
    const boundary = {
      assetId: "loot-1",
      sellerId: "player-1",
      authorityReceiptId: "a".repeat(64),
      ownerPublicKey: publicKey,
      ownerVersion: 0,
      ownerHeadId: "h".repeat(64),
      listingNonce: "9".repeat(64),
    };
    const proofDigest = gameMarketListingProofDigest("run-1", boundary, digest);
    const signature = audit_browser_ed25519_sign(seed, proofDigest);

    expect(verifyGameMarketListingProof(
      "run-1",
      boundary,
      signature,
      digest,
      verifier,
    )).toBe(true);
    expect(verifyGameMarketListingProof(
      "run-1",
      { ...boundary, authorityReceiptId: "b".repeat(64) },
      signature,
      digest,
      verifier,
    )).toBe(false);
    expect(verifyGameMarketListingProof(
      "run-1",
      { ...boundary, sellerId: "different-player" },
      signature,
      digest,
      verifier,
    )).toBe(false);
    expect(verifyGameMarketListingProof(
      "run-1",
      { ...boundary, listingNonce: "8".repeat(64) },
      signature,
      digest,
      verifier,
    )).toBe(false);
  });

  it("binds listing cancellation to the exact listing and owner head", () => {
    const boundary = {
      listingId: "l".repeat(64),
      assetId: "loot-1",
      sellerId: "player-1",
      authorityReceiptId: "a".repeat(64),
      ownerPublicKey: publicKey,
      ownerVersion: 1,
      ownerHeadId: "h".repeat(64),
      listingNonce: "9".repeat(64),
    };
    const proofDigest = gameMarketListingCancelProofDigest(
      "run-1",
      boundary,
      digest,
    );
    const signature = audit_browser_ed25519_sign(seed, proofDigest);

    expect(verifyGameMarketListingCancelProof(
      "run-1",
      boundary,
      signature,
      digest,
      verifier,
    )).toBe(true);
    expect(verifyGameMarketListingCancelProof(
      "run-1",
      { ...boundary, listingId: "x".repeat(64) },
      signature,
      digest,
      verifier,
    )).toBe(false);
    expect(verifyGameMarketListingCancelProof(
      "run-1",
      { ...boundary, ownerVersion: 2 },
      signature,
      digest,
      verifier,
    )).toBe(false);
    expect(verifyGameMarketListingCancelProof(
      "run-1",
      { ...boundary, listingNonce: "8".repeat(64) },
      signature,
      digest,
      verifier,
    )).toBe(false);
  });

  it("requires both the current owner handoff and recipient acceptance", () => {
    const recipientSeed =
      "1f1e1d1c1b1a19181716151413121110" +
      "0f0e0d0c0b0a09080706050403020100";
    const recipientPublicKey = audit_browser_ed25519_public_key(recipientSeed);
    const boundary = {
      assetId: "loot-1",
      authorityReceiptId: "a".repeat(64),
      previousHeadId: "b".repeat(64),
      fromOwnerId: "player-1",
      fromOwnerPublicKey: publicKey,
      toOwnerId: "player-2",
      toOwnerPublicKey: recipientPublicKey,
      previousVersion: 0,
      nextVersion: 1,
    };
    const proofDigest = gameItemTransferProofDigest("run-1", boundary, digest);
    const senderSignature = audit_browser_ed25519_sign(seed, proofDigest);
    const recipientSignature = audit_browser_ed25519_sign(
      recipientSeed,
      proofDigest,
    );

    expect(verifyGameItemTransferProof(
      "run-1",
      boundary,
      senderSignature,
      recipientSignature,
      digest,
      verifier,
    )).toEqual({ ok: true });
    expect(verifyGameItemTransferProof(
      "run-1",
      boundary,
      senderSignature,
      "f".repeat(128),
      digest,
      verifier,
    )).toEqual({ ok: false, reason: "recipient_authentication_refused" });
    expect(verifyGameItemTransferProof(
      "run-1",
      { ...boundary, previousHeadId: "c".repeat(64) },
      senderSignature,
      recipientSignature,
      digest,
      verifier,
    )).toEqual({ ok: false, reason: "sender_authentication_refused" });
  });
});
