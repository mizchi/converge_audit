import { describe, expect, it } from "vitest";
import {
  audit_browser_ed25519_public_key,
  audit_browser_ed25519_sign,
  audit_browser_ed25519_verify,
  audit_browser_merkle_root,
  audit_browser_sha256,
} from "../../../_build/js/release/build/x/game_audit/browser_bridge/browser_bridge.js";
import {
  appendAuditTick,
  canonicalMicroCheckpointEnvelope,
  createGameAuditJournal,
  type AuditDigestAdapter,
  type GameAuditJournalState,
} from "../game/audit/journal";
import {
  authenticateGameItemVerificationRequest,
  buildGameCheckpointVerificationRequest,
  buildGameItemVerificationRequest,
  verifyGameCheckpoint,
  verifyGameItemCreation,
  type GameItemVerificationRequest,
} from "../game/authority/item-verification";
import { advanceGame, createInitialGame } from "../game/kernel";

const digest: AuditDigestAdapter = {
  hashString: audit_browser_sha256,
  merkleRoot: audit_browser_merkle_root,
};
const ownerSeed =
  "000102030405060708090a0b0c0d0e0f" +
  "101112131415161718191a1b1c1d1e1f";
const ownerPublicKey = audit_browser_ed25519_public_key(ownerSeed);
const ownerSigner = {
  publicKey: ownerPublicKey,
  signDigest: (value: string) => audit_browser_ed25519_sign(ownerSeed, value),
};
const signatureVerifier = { verify: audit_browser_ed25519_verify };

function authenticatedItemRequest(
  audit: GameAuditJournalState,
  assetId: string,
  unit = "encounter-1",
): GameItemVerificationRequest {
  return authenticateGameItemVerificationRequest(
    unit,
    buildGameItemVerificationRequest(audit, assetId),
    digest,
    ownerSigner,
  );
}

function droppedRun() {
  let game = createInitialGame({ seed: 0x1234, playerId: "player-1" });
  let audit = createGameAuditJournal({
    seed: game.seed,
    playerId: game.player.id,
    ownerPublicKey,
    cadenceTicks: 30,
  }, digest);
  while (game.tick < 30) {
    const input = { tick: game.tick + 1, horizontal: 0 as const, vertical: 0 as const };
    const advanced = advanceGame(game, input);
    if (!advanced.ok) throw new Error(advanced.reason);
    const appended = appendAuditTick(audit, {
      input,
      effects: advanced.effects,
      state: advanced.state,
    }, digest);
    if (!appended.ok) throw new Error(appended.reason);
    game = advanced.state;
    audit = appended.state;
  }
  const assetId = audit.checkpoints[0].createdAssetIds[0];
  return {
    assetId,
    request: authenticatedItemRequest(audit, assetId),
  };
}

function runThrough(
  lastTick: number,
  horizontalAt: (tick: number) => -1 | 0 | 1 = () => 0,
) {
  let game = createInitialGame({ seed: 0x1234, playerId: "player-1" });
  let audit = createGameAuditJournal({
    seed: game.seed,
    playerId: game.player.id,
    ownerPublicKey,
    cadenceTicks: 30,
  }, digest);
  while (game.tick < lastTick) {
    const input = {
      tick: game.tick + 1,
      horizontal: horizontalAt(game.tick + 1),
      vertical: 0 as const,
    };
    const advanced = advanceGame(game, input);
    if (!advanced.ok) throw new Error(advanced.reason);
    const appended = appendAuditTick(audit, {
      input,
      effects: advanced.effects,
      state: advanced.state,
    }, digest);
    if (!appended.ok) throw new Error(appended.reason);
    game = advanced.state;
    audit = appended.state;
  }
  return { game, audit };
}

function recommit(request: GameItemVerificationRequest): void {
  request.checkpoint.event_root = digest.merkleRoot(
    request.events.map((event) => event.canonical_payload),
  );
  request.checkpoint.canonical_envelope = canonicalMicroCheckpointEnvelope({
    epoch: request.checkpoint.epoch,
    firstTick: request.checkpoint.first_tick,
    lastTick: request.checkpoint.last_tick,
    eventCount: request.checkpoint.event_count,
    eventRoot: request.checkpoint.event_root,
    stateDigest: request.checkpoint.state_digest,
    previousCheckpoint: request.checkpoint.previous_checkpoint,
    createdAssetIds: request.checkpoint.created_asset_ids,
  });
  request.checkpoint.checkpoint_digest = digest.hashString(
    request.checkpoint.canonical_envelope,
  );
}

function resign(request: GameItemVerificationRequest): void {
  request.owner_signature = authenticateGameItemVerificationRequest(
    "encounter-1",
    request,
    digest,
    ownerSigner,
  ).owner_signature;
}

describe("high-value item authority replay", () => {
  it("replays an arbitrary checkpoint from an authority-verified parent state", () => {
    const { audit } = runThrough(60);
    const first = verifyGameCheckpoint(
      buildGameCheckpointVerificationRequest(audit, 0),
      digest,
    );
    expect(first.ok).toBe(true);
    if (!first.ok) throw new Error(first.reason);

    const secondRequest = buildGameCheckpointVerificationRequest(audit, 1);
    expect(verifyGameCheckpoint(secondRequest, digest)).toEqual({
      ok: false,
      reason: "unverified_parent",
    });
    const second = verifyGameCheckpoint(secondRequest, digest, {
      checkpointDigest: first.checkpoint.checkpoint_digest,
      stateDigest: first.checkpoint.state_digest,
      ownerPublicKey,
      state: first.state,
    });
    expect(second.ok).toBe(true);
    if (!second.ok) throw new Error(second.reason);
    expect(second.state.tick).toBe(60);
    expect(second.checkpoint.epoch).toBe(1);
    expect(second.checkpoint.previous_checkpoint).toBe(
      first.checkpoint.checkpoint_digest,
    );
  });

  it("refuses a parent state that is not bound to the verified parent digest", () => {
    const { audit } = runThrough(60);
    const first = verifyGameCheckpoint(
      buildGameCheckpointVerificationRequest(audit, 0),
      digest,
    );
    if (!first.ok) throw new Error(first.reason);
    const tamperedParent = {
      ...first.state,
      player: { ...first.state.player, x: first.state.player.x + 1 },
    };

    expect(verifyGameCheckpoint(
      buildGameCheckpointVerificationRequest(audit, 1),
      digest,
      {
        checkpointDigest: first.checkpoint.checkpoint_digest,
        stateDigest: first.checkpoint.state_digest,
        ownerPublicKey,
        state: tamperedParent,
      },
    )).toEqual({ ok: false, reason: "invalid_parent_state" });
  });

  it("issues an item receipt for a drop in a later verified epoch", () => {
    const { audit } = runThrough(60, (tick) => tick <= 30 ? -1 : 1);
    expect(audit.checkpoints[1].createdAssetIds).toHaveLength(1);
    const first = verifyGameCheckpoint(
      buildGameCheckpointVerificationRequest(audit, 0),
      digest,
    );
    if (!first.ok) throw new Error(first.reason);
    const request = authenticatedItemRequest(
      audit,
      audit.checkpoints[1].createdAssetIds[0],
    );

    expect(verifyGameItemCreation(
      "encounter-1",
      request,
      digest,
      signatureVerifier,
    )).toEqual({
      ok: false,
      reason: "unverified_parent",
    });
    const verified = verifyGameItemCreation(
      "encounter-1",
      request,
      digest,
      signatureVerifier,
      {
        checkpointDigest: first.checkpoint.checkpoint_digest,
        stateDigest: first.checkpoint.state_digest,
        ownerPublicKey,
        state: first.state,
      },
    );
    expect(verified.ok).toBe(true);
    if (!verified.ok) throw new Error(verified.reason);
    expect(verified.receipt).toMatchObject({
      assetId: request.asset_id,
      checkpointDigest: request.checkpoint.checkpoint_digest,
      inventoryEpoch: 1,
    });
  });

  it("replays the retained segment and returns a checkpoint-bound receipt", () => {
    const { assetId, request } = droppedRun();
    const verified = verifyGameItemCreation(
      "encounter-1",
      request,
      digest,
      signatureVerifier,
    );

    expect(verified.ok).toBe(true);
    if (!verified.ok) throw new Error(verified.reason);
    expect(verified.receipt).toMatchObject({
      version: 1,
      assetId,
      ownerId: "player-1",
      checkpointDigest: request.checkpoint.checkpoint_digest,
      inventoryEpoch: 0,
    });
    expect(verified.receipt.authorityReceiptId).toMatch(/^[0-9a-f]{64}$/);
  });

  it("rejects a self-recommitted leaf whose claimed drop differs from replay", () => {
    const { request } = droppedRun();
    const last = JSON.parse(request.events.at(-1)!.canonical_payload);
    last[4][2][5][0] = "forged-asset";
    request.events.at(-1)!.canonical_payload = JSON.stringify(last);
    request.events.at(-1)!.created_asset_ids = ["forged-asset"];
    request.checkpoint.created_asset_ids = ["forged-asset"];
    request.asset_id = "forged-asset";
    recommit(request);
    resign(request);

    expect(verifyGameItemCreation(
      "encounter-1",
      request,
      digest,
      signatureVerifier,
    )).toEqual({
      ok: false,
      reason: "event_replay_mismatch",
    });
  });

  it("rejects an input outside the game input contract", () => {
    const { request } = droppedRun();
    const first = JSON.parse(request.events[0].canonical_payload);
    first[2] = 2;
    request.events[0].canonical_payload = JSON.stringify(first);
    recommit(request);
    resign(request);

    expect(verifyGameItemCreation(
      "encounter-1",
      request,
      digest,
      signatureVerifier,
    )).toEqual({
      ok: false,
      reason: "invalid_event",
    });
  });

  it("does not issue a receipt for an asset absent from replay", () => {
    const { request } = droppedRun();
    request.asset_id = "absent-asset";
    resign(request);

    expect(verifyGameItemCreation(
      "encounter-1",
      request,
      digest,
      signatureVerifier,
    )).toEqual({
      ok: false,
      reason: "asset_not_created",
    });
  });

  it("rejects settlement signed by a key other than the genesis owner", () => {
    const { request } = droppedRun();
    request.owner_signature = audit_browser_ed25519_sign(
      "1f1e1d1c1b1a19181716151413121110" +
        "0f0e0d0c0b0a09080706050403020100",
      "forged",
    );

    expect(verifyGameItemCreation(
      "encounter-1",
      request,
      digest,
      signatureVerifier,
    )).toEqual({ ok: false, reason: "owner_authentication_refused" });
  });
});
