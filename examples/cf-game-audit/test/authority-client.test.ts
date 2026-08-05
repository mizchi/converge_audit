import { describe, expect, it, vi } from "vitest";
import type { GameItemVerificationRequest } from "../game/authority/item-verification";
import {
  requestGameCheckpointVerification,
  requestGameItemTransfer,
  requestGameItemVerification,
  requestGameMarketListingCancellation,
  requestGameMarketListing,
} from "../web/src/audit/authority-client";

const request = {
  version: 1,
  seed: 4661,
  player_id: "local-player",
  owner_public_key: "c".repeat(64),
  asset_id: "loot-1",
  owner_signature: "e".repeat(128),
  checkpoint: {
    version: 1,
    epoch: 0,
    first_tick: 1,
    last_tick: 30,
    event_count: 30,
    event_root: "root-1",
    state_digest: "state-1",
    previous_checkpoint: "genesis-1",
    checkpoint_digest: "checkpoint-1",
    canonical_envelope: "envelope-1",
    created_asset_ids: [],
  },
  events: [],
} as unknown as GameItemVerificationRequest;

describe("browser authority client", () => {
  it("submits a dual-signed transfer and binds the returned owner head", async () => {
    const transferRequest = {
      assetId: "loot-1",
      authorityReceiptId: "a".repeat(64),
      previousHeadId: "b".repeat(64),
      fromOwnerId: "local-player",
      fromOwnerPublicKey: "c".repeat(64),
      toOwnerId: "remote-player",
      toOwnerPublicKey: "d".repeat(64),
      previousVersion: 0,
      nextVersion: 1,
      senderSignature: "e".repeat(128),
      recipientSignature: "f".repeat(128),
    };
    const fetcher = vi.fn(async () => new Response(JSON.stringify({
      ok: true,
      transferred: true,
      decision: "transferred",
      transfer: {
        version: 1,
        transfer_id: "1".repeat(64),
        asset_id: "loot-1",
        authority_receipt_id: "a".repeat(64),
        previous_head_id: "b".repeat(64),
        next_head_id: "2".repeat(64),
        from_owner_id: "local-player",
        from_owner_public_key: "c".repeat(64),
        to_owner_id: "remote-player",
        to_owner_public_key: "d".repeat(64),
        previous_version: 0,
        next_version: 1,
        sender_signature: "e".repeat(128),
        recipient_signature: "f".repeat(128),
        transferred_at: 1234,
      },
      owner_head: {
        version: 1,
        asset_id: "loot-1",
        authority_receipt_id: "a".repeat(64),
        owner_id: "remote-player",
        owner_public_key: "d".repeat(64),
        owner_version: 1,
        owner_head_id: "2".repeat(64),
        last_transfer_id: "1".repeat(64),
        updated_at: 1234,
      },
    }), { status: 201 }));

    await expect(requestGameItemTransfer(
      fetcher,
      "reference:local-player:4661:run-1",
      transferRequest,
    )).resolves.toMatchObject({
      ok: true,
      decision: "transferred",
      transfer: { transferId: "1".repeat(64) },
      ownerHead: {
        ownerId: "remote-player",
        ownerVersion: 1,
        ownerHeadId: "2".repeat(64),
      },
    });
    expect(fetcher).toHaveBeenCalledWith(
      "/v1/pve/reference%3Alocal-player%3A4661%3Arun-1/game-item-transfers",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("lists an item with the exact authority receipt", async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({
      ok: true,
      allowed: true,
      decision: "listed",
      listing: {
        version: 1,
        listing_id: "d".repeat(64),
        asset_id: "loot-1",
        seller_id: "local-player",
        authority_receipt_id: "a".repeat(64),
        owner_public_key: "c".repeat(64),
        owner_version: 0,
        owner_head_id: "f".repeat(64),
        listing_nonce: "9".repeat(64),
        owner_signature: "e".repeat(128),
        checkpoint_digest: "checkpoint-1",
        inventory_epoch: 0,
        item_type: "ember-blade",
        power: 12,
        status: "active",
        listed_at: 1234,
      },
    }), { status: 201 }));

    await expect(requestGameMarketListing(
      fetcher,
      "reference:local-player:4661:run-1",
      {
        assetId: "loot-1",
        sellerId: "local-player",
        authorityReceiptId: "a".repeat(64),
        ownerPublicKey: "c".repeat(64),
        ownerVersion: 0,
        ownerHeadId: "f".repeat(64),
        listingNonce: "9".repeat(64),
        ownerSignature: "e".repeat(128),
      },
    )).resolves.toMatchObject({
      ok: true,
      decision: "listed",
      listing: {
        listingId: "d".repeat(64),
        assetId: "loot-1",
        sellerId: "local-player",
        status: "active",
      },
    });
    expect(fetcher).toHaveBeenCalledWith(
      "/v1/pve/reference%3Alocal-player%3A4661%3Arun-1/game-market-listings",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("cancels only the exact listing and owner head", async () => {
    const cancellationRequest = {
      listingId: "d".repeat(64),
      assetId: "loot-1",
      sellerId: "local-player",
      authorityReceiptId: "a".repeat(64),
      ownerPublicKey: "c".repeat(64),
      ownerVersion: 0,
      ownerHeadId: "f".repeat(64),
      listingNonce: "9".repeat(64),
      cancelSignature: "1".repeat(128),
    };
    const fetcher = vi.fn(async () => new Response(JSON.stringify({
      ok: true,
      canceled: true,
      decision: "canceled",
      listing: {
        version: 1,
        listing_id: "d".repeat(64),
        asset_id: "loot-1",
        seller_id: "local-player",
        authority_receipt_id: "a".repeat(64),
        owner_public_key: "c".repeat(64),
        owner_version: 0,
        owner_head_id: "f".repeat(64),
        listing_nonce: "9".repeat(64),
        owner_signature: "e".repeat(128),
        checkpoint_digest: "checkpoint-1",
        inventory_epoch: 0,
        item_type: "ember-blade",
        power: 12,
        status: "canceled",
        listed_at: 1234,
        cancel_signature: "1".repeat(128),
        canceled_at: 2345,
      },
    }), { status: 201 }));

    await expect(requestGameMarketListingCancellation(
      fetcher,
      "reference:local-player:4661:run-1",
      cancellationRequest,
    )).resolves.toMatchObject({
      ok: true,
      decision: "canceled",
      listing: {
        listingId: "d".repeat(64),
        status: "canceled",
        cancelSignature: "1".repeat(128),
        canceledAt: 2345,
      },
    });
    expect(fetcher).toHaveBeenCalledWith(
      "/v1/pve/reference%3Alocal-player%3A4661%3Arun-1/game-market-listing-cancellations",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("maps a checkpoint receipt only when it is bound to the submitted segment", async () => {
    const checkpointRequest = request;
    const fetcher = vi.fn(async () => new Response(JSON.stringify({
      ok: true,
      decision: "verified",
      receipt: {
        version: 1,
        authority_checkpoint_receipt_id: "c".repeat(64),
        player_id: "local-player",
        owner_public_key: "c".repeat(64),
        seed: 4661,
        epoch: 0,
        last_tick: 30,
        checkpoint_digest: "checkpoint-1",
        created_asset_ids: [],
      },
    }), { status: 201 }));

    await expect(requestGameCheckpointVerification(
      fetcher,
      "reference:local-player:4661",
      checkpointRequest,
    )).resolves.toEqual({
      ok: true,
      decision: "verified",
      receipt: {
        authorityCheckpointReceiptId: "c".repeat(64),
        playerId: "local-player",
        ownerPublicKey: "c".repeat(64),
        seed: 4661,
        epoch: 0,
        lastTick: 30,
        checkpointDigest: "checkpoint-1",
        createdAssetIds: [],
      },
    });
    expect(fetcher).toHaveBeenCalledWith(
      "/v1/pve/reference%3Alocal-player%3A4661/game-checkpoint-verifications",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("posts a sealed segment and maps the authority receipt contract", async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({
      ok: true,
      decision: "verified",
      receipt: {
        version: 1,
        authority_receipt_id: "a".repeat(64),
        asset_id: "loot-1",
        owner_id: "local-player",
        owner_public_key: "c".repeat(64),
        owner_version: 0,
        owner_head_id: "f".repeat(64),
        checkpoint_digest: "checkpoint-1",
        inventory_epoch: 0,
      },
    }), { status: 201, headers: { "content-type": "application/json" } }));

    await expect(requestGameItemVerification(
      fetcher,
      "reference:local-player:4661",
      request,
    )).resolves.toEqual({
      ok: true,
      decision: "verified",
      receipt: {
        authorityReceiptId: "a".repeat(64),
        assetId: "loot-1",
        ownerId: "local-player",
        ownerPublicKey: "c".repeat(64),
        ownerVersion: 0,
        ownerHeadId: "f".repeat(64),
        checkpointDigest: "checkpoint-1",
        inventoryEpoch: 0,
      },
    });
    expect(fetcher).toHaveBeenCalledWith(
      "/v1/pve/reference%3Alocal-player%3A4661/game-item-verifications",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify(request),
      }),
    );
  });

  it("fails closed when a successful response is not bound to the request", async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({
      ok: true,
      decision: "verified",
      receipt: {
        version: 1,
        authority_receipt_id: "b".repeat(64),
        asset_id: "different-loot",
        owner_id: "local-player",
        owner_public_key: "c".repeat(64),
        owner_version: 0,
        owner_head_id: "f".repeat(64),
        checkpoint_digest: "checkpoint-1",
        inventory_epoch: 0,
      },
    }), { status: 201 }));

    await expect(requestGameItemVerification(fetcher, "unit-1", request))
      .resolves.toEqual({ ok: false, reason: "invalid_response" });
  });

  it("keeps an authority refusal structured for retry UI", async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({
      ok: false,
      error: "reference_game_verification_rate_limited",
    }), { status: 429, headers: { "retry-after": "12" } }));

    await expect(requestGameItemVerification(fetcher, "unit-1", request))
      .resolves.toEqual({
        ok: false,
        reason: "authority_refused",
        error: "reference_game_verification_rate_limited",
        status: 429,
        retryAfterSeconds: 12,
      });
  });
});
