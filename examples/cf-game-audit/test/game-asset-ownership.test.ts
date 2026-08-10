import { describe, expect, it } from "vitest";
import {
  audit_browser_ed25519_public_key,
  audit_browser_ed25519_sign,
  audit_browser_ed25519_verify,
  audit_browser_sha256,
} from "../../../_build/js/release/build/x/game_audit/browser_bridge/browser_bridge.js";
import {
  createInitialGameAssetOwnershipHead,
  gameAssetOwnershipHeadIdAsync,
  verifyAndApplyGameItemTransfer,
  type GameItemTransferRequest,
} from "../game/authority/asset-ownership";
import { gameItemTransferProofDigest } from "../game/authority/owner-authentication";
import { createStandardWebCryptoBackend } from "../../player-local-runtime/crypto-backend";

const senderSeed =
  "000102030405060708090a0b0c0d0e0f" +
  "101112131415161718191a1b1c1d1e1f";
const recipientSeed =
  "1f1e1d1c1b1a19181716151413121110" +
  "0f0e0d0c0b0a09080706050403020100";
const senderPublicKey = audit_browser_ed25519_public_key(senderSeed);
const recipientPublicKey = audit_browser_ed25519_public_key(recipientSeed);
const digest = { hashString: audit_browser_sha256 };
const verifier = { verify: audit_browser_ed25519_verify };
const unit = "run-1";
const origin = {
  assetId: "loot-1",
  authorityReceiptId: "a".repeat(64),
  ownerId: "player-1",
  ownerPublicKey: senderPublicKey,
};

function signedTransfer(
  overrides: Partial<GameItemTransferRequest> = {},
): GameItemTransferRequest {
  const head = createInitialGameAssetOwnershipHead(unit, origin, digest);
  const boundary = {
    assetId: origin.assetId,
    authorityReceiptId: origin.authorityReceiptId,
    previousHeadId: head.headId,
    fromOwnerId: head.ownerId,
    fromOwnerPublicKey: head.ownerPublicKey,
    toOwnerId: "player-2",
    toOwnerPublicKey: recipientPublicKey,
    previousVersion: 0,
    nextVersion: 1,
    ...overrides,
  };
  const proofDigest = gameItemTransferProofDigest(unit, boundary, digest);
  return {
    ...boundary,
    senderSignature: audit_browser_ed25519_sign(senderSeed, proofDigest),
    recipientSignature: audit_browser_ed25519_sign(recipientSeed, proofDigest),
  };
}

describe("reference game asset ownership head", () => {
  it("derives the same ownership heads with WebCrypto and MoonBit", async () => {
    const standard = createStandardWebCryptoBackend(crypto);
    const initial = createInitialGameAssetOwnershipHead(unit, origin, digest);

    await expect(gameAssetOwnershipHeadIdAsync(
      unit,
      initial,
      standard,
    )).resolves.toBe(initial.headId);
    const transferred = verifyAndApplyGameItemTransfer(
      unit,
      initial,
      signedTransfer(),
      digest,
      verifier,
    );
    expect(transferred.ok).toBe(true);
    if (!transferred.ok) throw new Error(transferred.reason);
    await expect(gameAssetOwnershipHeadIdAsync(
      unit,
      transferred.head,
      standard,
    )).resolves.toBe(transferred.head.headId);
  });

  it("detects an incompatible asynchronous ownership-head backend", async () => {
    const initial = createInitialGameAssetOwnershipHead(unit, origin, digest);
    const incompatible = {
      hashString: async (_value: string) => "0".repeat(64),
    };

    await expect(gameAssetOwnershipHeadIdAsync(
      unit,
      initial,
      incompatible,
    )).resolves.not.toBe(initial.headId);
  });

  it("derives a deterministic version-zero head from the authority receipt", () => {
    const first = createInitialGameAssetOwnershipHead(unit, origin, digest);
    const second = createInitialGameAssetOwnershipHead(unit, origin, digest);

    expect(first).toEqual(second);
    expect(first).toMatchObject({
      assetId: "loot-1",
      authorityReceiptId: "a".repeat(64),
      ownerId: "player-1",
      ownerPublicKey: senderPublicKey,
      version: 0,
      lastTransferId: origin.authorityReceiptId,
    });
    expect(first.headId).toMatch(/^[0-9a-f]{64}$/);
  });

  it("advances only an exact head with signatures from both owners", () => {
    const current = createInitialGameAssetOwnershipHead(unit, origin, digest);
    const request = signedTransfer();
    const result = verifyAndApplyGameItemTransfer(
      unit,
      current,
      request,
      digest,
      verifier,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.reason);
    expect(result.transferId).toMatch(/^[0-9a-f]{64}$/);
    expect(result.head).toMatchObject({
      ownerId: "player-2",
      ownerPublicKey: recipientPublicKey,
      version: 1,
      lastTransferId: result.transferId,
    });
    expect(result.head.headId).not.toBe(current.headId);
  });

  it("rejects a stale head, version gap, or unchanged owner", () => {
    const current = createInitialGameAssetOwnershipHead(unit, origin, digest);

    expect(verifyAndApplyGameItemTransfer(
      unit,
      current,
      signedTransfer({ previousHeadId: "b".repeat(64) }),
      digest,
      verifier,
    )).toEqual({ ok: false, reason: "stale_owner_head" });
    expect(verifyAndApplyGameItemTransfer(
      unit,
      current,
      signedTransfer({ nextVersion: 2 }),
      digest,
      verifier,
    )).toEqual({ ok: false, reason: "invalid_owner_version" });
    expect(verifyAndApplyGameItemTransfer(
      unit,
      current,
      signedTransfer({
        toOwnerId: current.ownerId,
        toOwnerPublicKey: current.ownerPublicKey,
      }),
      digest,
      verifier,
    )).toEqual({ ok: false, reason: "unchanged_owner" });
  });
});
