import { env } from "cloudflare:workers";
import {
  SELF,
  abortAllDurableObjects,
  createExecutionContext,
  createMessageBatch,
  evictDurableObject,
  getQueueResult,
} from "cloudflare:test";
import { describe, expect, it } from "vitest";
import {
  audit_browser_ed25519_public_key,
  audit_browser_ed25519_sign,
  audit_browser_merkle_root,
  audit_browser_sha256,
} from "../../../_build/js/release/build/x/game_audit/browser_bridge/browser_bridge.js";
import {
  audit_benchmark_make_anchor_envelope,
  audit_benchmark_make_checkpoint_delivery_authentication,
  audit_benchmark_make_inventory_lineage_proof_bundle,
  audit_benchmark_make_inventory_listing_proof_bundle,
  audit_benchmark_make_inventory_checkpoint_proof_bundle,
  audit_benchmark_make_open_world_multi_asset_pve_replay_bundle,
  audit_benchmark_make_open_world_pve_replay_bundle,
  audit_benchmark_make_pve_replay_bundle,
  audit_benchmark_make_pvp_replay_bundle,
  audit_experimental_sign_checkpoint_delivery_approval,
} from "../../../_build/js/release/build/x/game_audit/worker/worker.js";
import worker, {
  checkpointDestinationObjectName,
  type CheckpointDeliveryJob,
  type Env as AuditEnv,
  type ReplayJob,
} from "../src/index";
import { checkpointDeliveryIdempotencyKey } from "../src/checkpoint-runtime";
import {
  lineageDecisionStatementDigest,
  type LineageAncestorKind,
  type LineageDecisionScope,
  type LineageDecisionStatement,
} from "../src/lineage-decision-certificate";
import {
  appendAuditTick,
  createGameAuditJournal,
  type AuditDigestAdapter,
} from "../game/audit/journal";
import {
  authenticateGameItemVerificationRequest,
  buildGameCheckpointVerificationRequest,
  buildGameItemVerificationRequest,
} from "../game/authority/item-verification";
import {
  gameItemTransferProofDigest,
  signGameMarketListingCancelProof,
  signGameMarketListingProof,
} from "../game/authority/owner-authentication";
import { advanceGame, createInitialGame } from "../game/kernel";

const SEED =
  "000102030405060708090a0b0c0d0e0f" +
  "101112131415161718191a1b1c1d1e1f";
const PLAYER_SEED =
  "202122232425262728292a2b2c2d2e2f" +
  "303132333435363738393a3b3c3d3e3f";
const LINEAGE_ARBITER_SEED =
  "c0c1c2c3c4c5c6c7c8c9cacbcccdcecf" +
  "d0d1d2d3d4d5d6d7d8d9dadbdcdddedf";
const CHECKPOINT_WITNESS_SEEDS = [
  "404142434445464748494a4b4c4d4e4f" +
    "505152535455565758595a5b5c5d5e5f",
  "606162636465666768696a6b6c6d6e6f" +
    "707172737475767778797a7b7c7d7e7f",
  "808182838485868788898a8b8c8d8e8f" +
    "909192939495969798999a9b9c9d9e9f",
  "a0a1a2a3a4a5a6a7a8a9aaabacadaeaf" +
    "b0b1b2b3b4b5b6b7b8b9babbbcbdbebf",
];
const CHECKPOINT_WITNESS_IDS = [
  "checkpoint-witness-0",
  "checkpoint-witness-1",
  "checkpoint-witness-2",
  "checkpoint-witness-3",
];

interface Fixture {
  ok: true;
  envelope_hex: string;
  authority_key: string;
  digest: string;
  previous_digest: string;
  epoch: number;
}

interface CheckpointDeliveryFixture {
  ok: true;
  policy: {
    producer_id: string;
    producer_key: string;
    witnesses: Array<{ witness_id: string; witness_key: string }>;
    required_approvals: number;
  };
  authentication: CheckpointDeliveryJob["authentication"];
}

interface CheckpointDeliveryApprovalFixture {
  ok: true;
  approval: CheckpointDeliveryJob["authentication"]["approvals"][number];
}

function checkpointDeliveryFixture(
  mode: "pve" | "pvp" | "open",
  unit: string,
  destinationId: string,
  epoch: number,
  previousCheckpoint: string,
  checkpointDigest: string,
  canonicalEnvelope: string,
  approvalCount = 3,
): CheckpointDeliveryFixture {
  return JSON.parse(
    audit_benchmark_make_checkpoint_delivery_authentication(
      SEED,
      "checkpoint-producer",
      CHECKPOINT_WITNESS_SEEDS,
      CHECKPOINT_WITNESS_IDS,
      3,
      approvalCount,
      1,
      "checkpoint-v1",
      "manifest-1",
      `cf:${mode}:${unit}`,
      unit,
      destinationId,
      epoch,
      previousCheckpoint,
      checkpointDigest,
      canonicalEnvelope,
    ),
  ) as CheckpointDeliveryFixture;
}

function checkpointDeliveryApproval(
  witnessSeedHex: string,
  witnessId: string,
  statementDigest: string,
): CheckpointDeliveryApprovalFixture {
  return JSON.parse(
    audit_experimental_sign_checkpoint_delivery_approval(
      witnessSeedHex,
      witnessId,
      statementDigest,
    ),
  ) as CheckpointDeliveryApprovalFixture;
}

function fixture(
  sessionId: string,
  observerId: string,
  epoch: number,
  previousDigest: string,
): Fixture {
  return JSON.parse(
    audit_benchmark_make_anchor_envelope(
      SEED,
      sessionId,
      observerId,
      epoch,
      previousDigest,
    ),
  ) as Fixture;
}

async function configure(
  mode: "pve" | "pvp" | "open",
  unit: string,
  sessionId: string,
  authorityKey: string,
  initialEpoch: number,
  initialPreviousDigest: string,
): Promise<Response> {
  return SELF.fetch(`https://example.test/v1/${mode}/${unit}/configure`, {
    method: "POST",
    headers: {
      authorization: "Bearer test-admin-token",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      session_id: sessionId,
      authority_key: authorityKey,
      initial_epoch: initialEpoch,
      initial_previous_digest: initialPreviousDigest,
    }),
  });
}

async function submit(
  mode: "pve" | "pvp" | "open",
  unit: string,
  value: Fixture,
): Promise<Response> {
  return SELF.fetch(`https://example.test/v1/${mode}/${unit}/anchors`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ envelope_hex: value.envelope_hex }),
  });
}

async function requestReplay(
  mode: "pve" | "pvp" | "open",
  unit: string,
  reason: string,
  artifact?: {
    bundle_hex: string;
    checkpoint_digest: string;
    target_session_id?: string;
    audit_checkpoint_digest?: string;
    seal_checkpoint_digest?: string;
    transparency_log_session_id?: string;
    transparency_publisher_key?: string;
    transparency_checkpoint_digest?: string;
  },
): Promise<Response> {
  return SELF.fetch(`https://example.test/v1/${mode}/${unit}/replay`, {
    method: "POST",
    headers: {
      authorization: "Bearer test-admin-token",
      "content-type": "application/json",
    },
    body: JSON.stringify({ reason, ...artifact }),
  });
}

async function configureCheckpointRuntime(
  mode: "pve" | "pvp" | "open",
  unit: string,
  outboxCapacity = 8,
  destinations = ["authority-1", "peer-2"],
): Promise<Response> {
  const authenticationPolicy = checkpointDeliveryFixture(
    mode,
    unit,
    destinations[0] ?? "authority-1",
    0,
    "genesis",
    "checkpoint-policy-fixture",
    "checkpoint-policy-fixture-envelope",
  ).policy;
  return SELF.fetch(
    `https://example.test/v1/${mode}/${unit}/checkpoint-configure`,
    {
      method: "POST",
      headers: {
        authorization: "Bearer test-admin-token",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        protocol_version: 1,
        purpose: "checkpoint-v1",
        manifest_digest: "manifest-1",
        initial_epoch: -1,
        initial_digest: "genesis",
        outbox_capacity: outboxCapacity,
        destinations,
        authentication_policy: authenticationPolicy,
      }),
    },
  );
}

async function closeCheckpointEpoch(
  mode: "pve" | "pvp" | "open",
  unit: string,
  epoch: number,
): Promise<Response> {
  return SELF.fetch(
    `https://example.test/v1/${mode}/${unit}/checkpoint-closures`,
    {
      method: "POST",
      headers: {
        authorization: "Bearer test-admin-token",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        epoch,
        roster_digest: `roster-${epoch}`,
        frontier_digest: `frontier-${epoch}`,
        certificate_digest: `certificate-${epoch}`,
        frontier_complete: true,
        conflict_free: true,
        quorum_satisfied: true,
      }),
    },
  );
}

async function sealCheckpoint(
  mode: "pve" | "pvp" | "open",
  unit: string,
  epoch: number,
  previousCheckpoint: string,
  checkpointDigest: string,
  destinations: string[],
  faultPoint?: string,
  reverseApprovals = false,
  dispatch: "direct" | "deferred" = "deferred",
): Promise<Response> {
  const canonicalEnvelope = `canonical-envelope-${epoch}`;
  const authentications = destinations.map((destinationId) => {
    const authentication = checkpointDeliveryFixture(
      mode,
      unit,
      destinationId,
      epoch,
      previousCheckpoint,
      checkpointDigest,
      canonicalEnvelope,
    ).authentication;
    return {
      destination_id: destinationId,
      authentication: reverseApprovals
        ? {
          ...authentication,
          approvals: [...authentication.approvals].reverse(),
        }
        : authentication,
    };
  });
  return SELF.fetch(`https://example.test/v1/${mode}/${unit}/checkpoint-seals`, {
    method: "POST",
    headers: {
      authorization: "Bearer test-admin-token",
      "content-type": "application/json",
      "x-audit-checkpoint-dispatch": dispatch,
      ...(faultPoint ? { "x-audit-fault-point": faultPoint } : {}),
    },
    body: JSON.stringify({
      epoch,
      previous_checkpoint: previousCheckpoint,
      checkpoint_digest: checkpointDigest,
      canonical_envelope: canonicalEnvelope,
      destinations,
      authentications,
    }),
  });
}

async function checkpointState(
  mode: "pve" | "pvp" | "open",
  unit: string,
): Promise<Record<string, unknown>> {
  const response = await SELF.fetch(
    `https://example.test/v1/${mode}/${unit}/checkpoint-state`,
    { headers: { authorization: "Bearer test-admin-token" } },
  );
  expect(response.status).toBe(200);
  return await response.json() as Record<string, unknown>;
}

async function evictAuditShard(
  mode: "pve" | "pvp" | "open",
  unit: string,
): Promise<void> {
  const auditEnv = env as unknown as AuditEnv;
  const id = auditEnv.AUDIT_SHARD.idFromName(`${mode}:${unit}`);
  await evictDurableObject(auditEnv.AUDIT_SHARD.get(id));
}

function nextJsonMessage(socket: WebSocket): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    socket.addEventListener(
      "message",
      (event) => resolve(JSON.parse(String(event.data)) as Record<string, unknown>),
      { once: true },
    );
  });
}

const referenceGameDigest: AuditDigestAdapter = {
  hashString: audit_browser_sha256,
  merkleRoot: audit_browser_merkle_root,
};
const referenceGameOwnerPublicKey = audit_browser_ed25519_public_key(SEED);
const referenceGameRecipientPublicKey = audit_browser_ed25519_public_key(
  PLAYER_SEED,
);
const referenceGameOwnerSigner = {
  publicKey: referenceGameOwnerPublicKey,
  signDigest: (value: string) => audit_browser_ed25519_sign(SEED, value),
};

function signedLineageDecision(
  scope: LineageDecisionScope,
  unit: string,
  input: {
    asset_id: string;
    ancestor_id: string;
    ancestor_kind: LineageAncestorKind;
    expected_revision: number;
    outcome: "eligible" | "revoked";
    reason: string;
    appeal_of_decision_id?: string;
    issued_at_ms?: number;
    expires_at_ms?: number;
    appeal_deadline_at_ms?: number;
  },
) {
  const now = Date.now();
  const issuedAt = input.issued_at_ms ?? now - 10;
  const statement: LineageDecisionStatement = {
    version: 1,
    scope,
    unit,
    assetId: input.asset_id,
    ancestorId: input.ancestor_id,
    ancestorKind: input.ancestor_kind,
    expectedRevision: input.expected_revision,
    revision: input.expected_revision + 1,
    outcome: input.outcome,
    reasonCode: input.reason.toLowerCase().replace(/[^a-z0-9._:-]+/g, "_")
      .slice(0, 128),
    issuedAtMs: issuedAt,
    expiresAtMs: input.expires_at_ms ?? now + 30_000,
    appealDeadlineAtMs: input.outcome === "revoked"
      ? input.appeal_deadline_at_ms ?? now + 60_000
      : null,
    appealOfDecisionId: input.outcome === "eligible"
      ? input.appeal_of_decision_id ?? null
      : null,
    finalizedAtMs: input.outcome === "eligible" ? issuedAt - 1 : null,
  };
  const signature = audit_browser_ed25519_sign(
    LINEAGE_ARBITER_SEED,
    lineageDecisionStatementDigest(statement, referenceGameDigest),
  );
  return {
    statement: {
      version: statement.version,
      scope: statement.scope,
      unit: statement.unit,
      asset_id: statement.assetId,
      ancestor_id: statement.ancestorId,
      ancestor_kind: statement.ancestorKind,
      expected_revision: statement.expectedRevision,
      revision: statement.revision,
      outcome: statement.outcome,
      reason_code: statement.reasonCode,
      issued_at_ms: statement.issuedAtMs,
      expires_at_ms: statement.expiresAtMs,
      appeal_deadline_at_ms: statement.appealDeadlineAtMs,
      appeal_of_decision_id: statement.appealOfDecisionId,
      finalized_at_ms: statement.finalizedAtMs,
    },
    authentication: {
      scheme: "moonbit-ed25519-v1",
      arbiter_id: "external-arbiter-a",
      signature,
    },
  };
}

function referenceGameRun(
  lastTick: number,
  horizontalAt: (tick: number) => -1 | 0 | 1 = () => 0,
) {
  let game = createInitialGame({ seed: 0x1234, playerId: "player-1" });
  let audit = createGameAuditJournal({
    seed: game.seed,
    playerId: game.player.id,
    ownerPublicKey: referenceGameOwnerPublicKey,
    cadenceTicks: 30,
  }, referenceGameDigest);
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
    }, referenceGameDigest);
    if (!appended.ok) throw new Error(appended.reason);
    game = advanced.state;
    audit = appended.state;
  }
  return audit;
}

function referenceGameItemRequest(unit: string) {
  const audit = referenceGameRun(30);
  const assetId = audit.checkpoints[0].createdAssetIds[0];
  return authenticateGameItemVerificationRequest(
    unit,
    buildGameItemVerificationRequest(audit, assetId),
    referenceGameDigest,
    referenceGameOwnerSigner,
  );
}

describe.sequential("Cloudflare game audit shard", () => {
  it("lists only a reference-game item with its exact authority receipt", async () => {
    const unit = `reference-game-market-${crypto.randomUUID()}`;
    const request = referenceGameItemRequest(unit);
    const verified = await SELF.fetch(
      `https://example.test/v1/pve/${unit}/game-item-verifications`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(request),
      },
    );
    expect(verified.status).toBe(201);
    const verification = await verified.json() as {
      receipt: {
        authority_receipt_id: string;
        owner_public_key: string;
        owner_version: number;
        owner_head_id: string;
      };
    };
    const listingNonce = "1".repeat(64);
    const listingRequest = {
      asset_id: request.asset_id,
      seller_id: request.player_id,
      authority_receipt_id: verification.receipt.authority_receipt_id,
      owner_public_key: referenceGameOwnerPublicKey,
      owner_version: verification.receipt.owner_version,
      owner_head_id: verification.receipt.owner_head_id,
      listing_nonce: listingNonce,
      owner_signature: signGameMarketListingProof(
        unit,
        {
          assetId: request.asset_id,
          sellerId: request.player_id,
          authorityReceiptId: verification.receipt.authority_receipt_id,
          ownerPublicKey: referenceGameOwnerPublicKey,
          ownerVersion: verification.receipt.owner_version,
          ownerHeadId: verification.receipt.owner_head_id,
          listingNonce,
        },
        referenceGameDigest,
        referenceGameOwnerSigner,
      ),
    };
    const list = (body: unknown) => SELF.fetch(
      `https://example.test/v1/pve/${unit}/game-market-listings`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      },
    );

    const forged = await list({
      ...listingRequest,
      authority_receipt_id: "f".repeat(64),
    });
    expect(forged.status).toBe(403);
    await expect(forged.json()).resolves.toMatchObject({
      ok: true,
      allowed: false,
      decision: "authority_receipt_mismatch",
    });

    const wrongSeller = await list({
      ...listingRequest,
      seller_id: "different-player",
    });
    expect(wrongSeller.status).toBe(403);
    await expect(wrongSeller.json()).resolves.toMatchObject({
      ok: true,
      allowed: false,
      decision: "seller_mismatch",
    });

    const stolenReceipt = await list({
      ...listingRequest,
      owner_signature: "f".repeat(128),
    });
    expect(stolenReceipt.status).toBe(403);
    await expect(stolenReceipt.json()).resolves.toMatchObject({
      ok: true,
      allowed: false,
      decision: "owner_authentication_refused",
    });

    const listed = await list(listingRequest);
    expect(listed.status).toBe(201);
    const first = await listed.json() as Record<string, unknown>;
    expect(first).toMatchObject({
      ok: true,
      allowed: true,
      decision: "listed",
      listing: {
        asset_id: request.asset_id,
        seller_id: request.player_id,
        authority_receipt_id: verification.receipt.authority_receipt_id,
        status: "active",
      },
    });

    await evictAuditShard("pve", unit);
    const duplicate = await list(listingRequest);
    expect(duplicate.status).toBe(200);
    await expect(duplicate.json()).resolves.toEqual({
      ...first,
      decision: "duplicate",
    });
  });

  it("transfers an item with dual signatures and lists only the current owner", async () => {
    const unit = `reference-game-transfer-${crypto.randomUUID()}`;
    const itemRequest = referenceGameItemRequest(unit);
    const verified = await SELF.fetch(
      `https://example.test/v1/pve/${unit}/game-item-verifications`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(itemRequest),
      },
    );
    expect(verified.status).toBe(201);
    const verifiedBody = await verified.json() as {
      receipt: {
        authority_receipt_id: string;
        owner_version: number;
        owner_head_id: string;
      };
    };
    const transferBoundary = {
      assetId: itemRequest.asset_id,
      authorityReceiptId: verifiedBody.receipt.authority_receipt_id,
      previousHeadId: verifiedBody.receipt.owner_head_id,
      fromOwnerId: itemRequest.player_id,
      fromOwnerPublicKey: referenceGameOwnerPublicKey,
      toOwnerId: "player-2",
      toOwnerPublicKey: referenceGameRecipientPublicKey,
      previousVersion: verifiedBody.receipt.owner_version,
      nextVersion: verifiedBody.receipt.owner_version + 1,
    };
    const transferDigest = gameItemTransferProofDigest(
      unit,
      transferBoundary,
      referenceGameDigest,
    );
    const transferRequest = {
      asset_id: transferBoundary.assetId,
      authority_receipt_id: transferBoundary.authorityReceiptId,
      previous_head_id: transferBoundary.previousHeadId,
      from_owner_id: transferBoundary.fromOwnerId,
      from_owner_public_key: transferBoundary.fromOwnerPublicKey,
      to_owner_id: transferBoundary.toOwnerId,
      to_owner_public_key: transferBoundary.toOwnerPublicKey,
      previous_version: transferBoundary.previousVersion,
      next_version: transferBoundary.nextVersion,
      sender_signature: audit_browser_ed25519_sign(SEED, transferDigest),
      recipient_signature: audit_browser_ed25519_sign(
        PLAYER_SEED,
        transferDigest,
      ),
    };
    const post = (action: string, body: unknown) => SELF.fetch(
      `https://example.test/v1/pve/${unit}/${action}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      },
    );

    const forgedAcceptance = await post("game-item-transfers", {
      ...transferRequest,
      recipient_signature: "f".repeat(128),
    });
    expect(forgedAcceptance.status).toBe(403);
    await expect(forgedAcceptance.json()).resolves.toMatchObject({
      transferred: false,
      decision: "recipient_authentication_refused",
    });

    const transferred = await post("game-item-transfers", transferRequest);
    expect(transferred.status).toBe(201);
    const transferredBody = await transferred.json() as {
      owner_head: {
        owner_id: string;
        owner_public_key: string;
        owner_version: number;
        owner_head_id: string;
      };
      transfer: { transfer_id: string };
    };
    expect(transferredBody).toMatchObject({
      owner_head: {
        owner_id: "player-2",
        owner_public_key: referenceGameRecipientPublicKey,
        owner_version: 1,
      },
    });

    const duplicateOriginReceipt = await post(
      "game-item-verifications",
      itemRequest,
    );
    expect(duplicateOriginReceipt.status).toBe(200);
    await expect(duplicateOriginReceipt.json()).resolves.toMatchObject({
      decision: "duplicate",
      receipt: {
        owner_version: 0,
        owner_head_id: transferBoundary.previousHeadId,
      },
    });

    await evictAuditShard("pve", unit);
    const duplicate = await post("game-item-transfers", transferRequest);
    expect(duplicate.status).toBe(200);
    await expect(duplicate.json()).resolves.toMatchObject({
      transferred: true,
      decision: "duplicate",
      transfer: { transfer_id: transferredBody.transfer.transfer_id },
    });

    const oldOwnerListing = {
      asset_id: itemRequest.asset_id,
      seller_id: itemRequest.player_id,
      authority_receipt_id: transferBoundary.authorityReceiptId,
      owner_public_key: referenceGameOwnerPublicKey,
      owner_version: transferBoundary.previousVersion,
      owner_head_id: transferBoundary.previousHeadId,
      listing_nonce: "2".repeat(64),
      owner_signature: signGameMarketListingProof(
        unit,
        {
          assetId: itemRequest.asset_id,
          sellerId: itemRequest.player_id,
          authorityReceiptId: transferBoundary.authorityReceiptId,
          ownerPublicKey: referenceGameOwnerPublicKey,
          ownerVersion: transferBoundary.previousVersion,
          ownerHeadId: transferBoundary.previousHeadId,
          listingNonce: "2".repeat(64),
        },
        referenceGameDigest,
        referenceGameOwnerSigner,
      ),
    };
    const staleListing = await post("game-market-listings", oldOwnerListing);
    expect(staleListing.status).toBe(403);
    await expect(staleListing.json()).resolves.toMatchObject({
      allowed: false,
      decision: "seller_mismatch",
    });

    const recipientSigner = {
      publicKey: referenceGameRecipientPublicKey,
      signDigest: (value: string) =>
        audit_browser_ed25519_sign(PLAYER_SEED, value),
    };
    const currentListingBoundary = {
      assetId: itemRequest.asset_id,
      sellerId: "player-2",
      authorityReceiptId: transferBoundary.authorityReceiptId,
      ownerPublicKey: referenceGameRecipientPublicKey,
      ownerVersion: transferredBody.owner_head.owner_version,
      ownerHeadId: transferredBody.owner_head.owner_head_id,
      listingNonce: "3".repeat(64),
    };
    const currentListing = await post("game-market-listings", {
      asset_id: currentListingBoundary.assetId,
      seller_id: currentListingBoundary.sellerId,
      authority_receipt_id: currentListingBoundary.authorityReceiptId,
      owner_public_key: currentListingBoundary.ownerPublicKey,
      owner_version: currentListingBoundary.ownerVersion,
      owner_head_id: currentListingBoundary.ownerHeadId,
      listing_nonce: currentListingBoundary.listingNonce,
      owner_signature: signGameMarketListingProof(
        unit,
        currentListingBoundary,
        referenceGameDigest,
        recipientSigner,
      ),
    });
    expect(currentListing.status).toBe(201);
    const currentListingBody = await currentListing.json() as {
      listing: { listing_id: string };
    };
    expect(currentListingBody).toMatchObject({
      allowed: true,
      decision: "listed",
      listing: {
        seller_id: "player-2",
        owner_version: 1,
        owner_head_id: transferredBody.owner_head.owner_head_id,
      },
    });

    const thirdOwnerSeed = CHECKPOINT_WITNESS_SEEDS[0];
    const thirdOwnerPublicKey = audit_browser_ed25519_public_key(thirdOwnerSeed);
    const listedTransferBoundary = {
      assetId: itemRequest.asset_id,
      authorityReceiptId: transferBoundary.authorityReceiptId,
      previousHeadId: transferredBody.owner_head.owner_head_id,
      fromOwnerId: "player-2",
      fromOwnerPublicKey: referenceGameRecipientPublicKey,
      toOwnerId: "player-3",
      toOwnerPublicKey: thirdOwnerPublicKey,
      previousVersion: transferredBody.owner_head.owner_version,
      nextVersion: transferredBody.owner_head.owner_version + 1,
    };
    const listedTransferDigest = gameItemTransferProofDigest(
      unit,
      listedTransferBoundary,
      referenceGameDigest,
    );
    const listedTransferRequest = {
      asset_id: listedTransferBoundary.assetId,
      authority_receipt_id: listedTransferBoundary.authorityReceiptId,
      previous_head_id: listedTransferBoundary.previousHeadId,
      from_owner_id: listedTransferBoundary.fromOwnerId,
      from_owner_public_key: listedTransferBoundary.fromOwnerPublicKey,
      to_owner_id: listedTransferBoundary.toOwnerId,
      to_owner_public_key: listedTransferBoundary.toOwnerPublicKey,
      previous_version: listedTransferBoundary.previousVersion,
      next_version: listedTransferBoundary.nextVersion,
      sender_signature: audit_browser_ed25519_sign(
        PLAYER_SEED,
        listedTransferDigest,
      ),
      recipient_signature: audit_browser_ed25519_sign(
        thirdOwnerSeed,
        listedTransferDigest,
      ),
    };
    const blockedByListing = await post(
      "game-item-transfers",
      listedTransferRequest,
    );
    expect(blockedByListing.status).toBe(409);
    await expect(blockedByListing.json()).resolves.toMatchObject({
      transferred: false,
      decision: "asset_listed",
    });

    const cancelBoundary = {
      listingId: currentListingBody.listing.listing_id,
      ...currentListingBoundary,
    };
    const cancelSignature = signGameMarketListingCancelProof(
      unit,
      cancelBoundary,
      referenceGameDigest,
      recipientSigner,
    );
    const cancelRequest = {
      listing_id: cancelBoundary.listingId,
      asset_id: cancelBoundary.assetId,
      seller_id: cancelBoundary.sellerId,
      authority_receipt_id: cancelBoundary.authorityReceiptId,
      owner_public_key: cancelBoundary.ownerPublicKey,
      owner_version: cancelBoundary.ownerVersion,
      owner_head_id: cancelBoundary.ownerHeadId,
      listing_nonce: cancelBoundary.listingNonce,
      cancel_signature: cancelSignature,
    };
    const forgedCancellation = await post(
      "game-market-listing-cancellations",
      { ...cancelRequest, cancel_signature: "f".repeat(128) },
    );
    expect(forgedCancellation.status).toBe(403);
    await expect(forgedCancellation.json()).resolves.toMatchObject({
      canceled: false,
      decision: "owner_authentication_refused",
    });

    const canceled = await post(
      "game-market-listing-cancellations",
      cancelRequest,
    );
    expect(canceled.status).toBe(201);
    const canceledBody = await canceled.json() as Record<string, unknown>;
    expect(canceledBody).toMatchObject({
      canceled: true,
      decision: "canceled",
      listing: {
        listing_id: cancelBoundary.listingId,
        status: "canceled",
        cancel_signature: cancelSignature,
      },
    });

    const canceledHeadRelisting = await post("game-market-listings", {
      asset_id: currentListingBoundary.assetId,
      seller_id: currentListingBoundary.sellerId,
      authority_receipt_id: currentListingBoundary.authorityReceiptId,
      owner_public_key: currentListingBoundary.ownerPublicKey,
      owner_version: currentListingBoundary.ownerVersion,
      owner_head_id: currentListingBoundary.ownerHeadId,
      listing_nonce: currentListingBoundary.listingNonce,
      owner_signature: signGameMarketListingProof(
        unit,
        currentListingBoundary,
        referenceGameDigest,
        recipientSigner,
      ),
    });
    expect(canceledHeadRelisting.status).toBe(409);
    await expect(canceledHeadRelisting.json()).resolves.toMatchObject({
      allowed: false,
      decision: "listing_canceled",
    });

    const freshListingBoundary = {
      ...currentListingBoundary,
      listingNonce: "4".repeat(64),
    };
    const freshListing = await post("game-market-listings", {
      asset_id: freshListingBoundary.assetId,
      seller_id: freshListingBoundary.sellerId,
      authority_receipt_id: freshListingBoundary.authorityReceiptId,
      owner_public_key: freshListingBoundary.ownerPublicKey,
      owner_version: freshListingBoundary.ownerVersion,
      owner_head_id: freshListingBoundary.ownerHeadId,
      listing_nonce: freshListingBoundary.listingNonce,
      owner_signature: signGameMarketListingProof(
        unit,
        freshListingBoundary,
        referenceGameDigest,
        recipientSigner,
      ),
    });
    expect(freshListing.status).toBe(201);
    const freshListingBody = await freshListing.json() as {
      listing: { listing_id: string };
    };
    expect(freshListingBody).toMatchObject({
      allowed: true,
      decision: "listed",
      listing: { listing_nonce: freshListingBoundary.listingNonce },
    });

    const freshCancelBoundary = {
      listingId: freshListingBody.listing.listing_id,
      ...freshListingBoundary,
    };
    const freshCancelSignature = signGameMarketListingCancelProof(
      unit,
      freshCancelBoundary,
      referenceGameDigest,
      recipientSigner,
    );
    const freshCancellation = await post(
      "game-market-listing-cancellations",
      {
        listing_id: freshCancelBoundary.listingId,
        asset_id: freshCancelBoundary.assetId,
        seller_id: freshCancelBoundary.sellerId,
        authority_receipt_id: freshCancelBoundary.authorityReceiptId,
        owner_public_key: freshCancelBoundary.ownerPublicKey,
        owner_version: freshCancelBoundary.ownerVersion,
        owner_head_id: freshCancelBoundary.ownerHeadId,
        listing_nonce: freshCancelBoundary.listingNonce,
        cancel_signature: freshCancelSignature,
      },
    );
    expect(freshCancellation.status).toBe(201);
    await expect(freshCancellation.json()).resolves.toMatchObject({
      canceled: true,
      decision: "canceled",
      listing: { listing_id: freshCancelBoundary.listingId },
    });

    const transferredAfterCancellation = await post(
      "game-item-transfers",
      listedTransferRequest,
    );
    expect(transferredAfterCancellation.status).toBe(201);
    await expect(transferredAfterCancellation.json()).resolves.toMatchObject({
      transferred: true,
      decision: "transferred",
      owner_head: {
        owner_id: "player-3",
        owner_version: 2,
      },
    });

    await evictAuditShard("pve", unit);
    const duplicateCancellation = await post(
      "game-market-listing-cancellations",
      cancelRequest,
    );
    expect(duplicateCancellation.status).toBe(200);
    await expect(duplicateCancellation.json()).resolves.toEqual({
      ...canceledBody,
      decision: "duplicate",
    });
  });

  it("quarantines descendant listings until an origin revocation is appealed", async () => {
    const unit = `reference-game-revocation-${crypto.randomUUID()}`;
    const itemRequest = referenceGameItemRequest(unit);
    const verified = await SELF.fetch(
      `https://example.test/v1/pve/${unit}/game-item-verifications`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(itemRequest),
      },
    );
    expect(verified.status).toBe(201);
    const verifiedBody = await verified.json() as {
      receipt: {
        authority_receipt_id: string;
        owner_version: number;
        owner_head_id: string;
      };
    };
    const transferBoundary = {
      assetId: itemRequest.asset_id,
      authorityReceiptId: verifiedBody.receipt.authority_receipt_id,
      previousHeadId: verifiedBody.receipt.owner_head_id,
      fromOwnerId: itemRequest.player_id,
      fromOwnerPublicKey: referenceGameOwnerPublicKey,
      toOwnerId: "player-2",
      toOwnerPublicKey: referenceGameRecipientPublicKey,
      previousVersion: verifiedBody.receipt.owner_version,
      nextVersion: verifiedBody.receipt.owner_version + 1,
    };
    const transferDigest = gameItemTransferProofDigest(
      unit,
      transferBoundary,
      referenceGameDigest,
    );
    const transferRequest = {
      asset_id: transferBoundary.assetId,
      authority_receipt_id: transferBoundary.authorityReceiptId,
      previous_head_id: transferBoundary.previousHeadId,
      from_owner_id: transferBoundary.fromOwnerId,
      from_owner_public_key: transferBoundary.fromOwnerPublicKey,
      to_owner_id: transferBoundary.toOwnerId,
      to_owner_public_key: transferBoundary.toOwnerPublicKey,
      previous_version: transferBoundary.previousVersion,
      next_version: transferBoundary.nextVersion,
      sender_signature: audit_browser_ed25519_sign(SEED, transferDigest),
      recipient_signature: audit_browser_ed25519_sign(
        PLAYER_SEED,
        transferDigest,
      ),
    };
    const transferred = await SELF.fetch(
      `https://example.test/v1/pve/${unit}/game-item-transfers`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(transferRequest),
      },
    );
    expect(transferred.status).toBe(201);
    const transferredBody = await transferred.json() as {
      owner_head: { owner_version: number; owner_head_id: string };
      transfer: { transfer_id: string };
    };
    const recipientSigner = {
      publicKey: referenceGameRecipientPublicKey,
      signDigest: (value: string) =>
        audit_browser_ed25519_sign(PLAYER_SEED, value),
    };
    const listingBoundary = {
      assetId: itemRequest.asset_id,
      sellerId: "player-2",
      authorityReceiptId: transferBoundary.authorityReceiptId,
      ownerPublicKey: referenceGameRecipientPublicKey,
      ownerVersion: transferredBody.owner_head.owner_version,
      ownerHeadId: transferredBody.owner_head.owner_head_id,
      listingNonce: "5".repeat(64),
    };
    const listingRequest = {
      asset_id: listingBoundary.assetId,
      seller_id: listingBoundary.sellerId,
      authority_receipt_id: listingBoundary.authorityReceiptId,
      owner_public_key: listingBoundary.ownerPublicKey,
      owner_version: listingBoundary.ownerVersion,
      owner_head_id: listingBoundary.ownerHeadId,
      listing_nonce: listingBoundary.listingNonce,
      owner_signature: signGameMarketListingProof(
        unit,
        listingBoundary,
        referenceGameDigest,
        recipientSigner,
      ),
    };
    const list = (body: unknown) => SELF.fetch(
      `https://example.test/v1/pve/${unit}/game-market-listings`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      },
    );
    const initialListing = await list(listingRequest);
    expect(initialListing.status).toBe(201);
    await initialListing.json();

    const decide = (body: unknown, authorized = true) => SELF.fetch(
      `https://example.test/v1/pve/${unit}/game-asset-lineage-decisions`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(authorized
            ? { authorization: "Bearer test-admin-token" }
            : {}),
        },
        body: JSON.stringify(body),
      },
    );
    const revocation = signedLineageDecision("reference-game", unit, {
      asset_id: itemRequest.asset_id,
      ancestor_id: transferBoundary.authorityReceiptId,
      ancestor_kind: "origin",
      expected_revision: 0,
      outcome: "revoked",
      reason: "origin checkpoint challenge upheld",
    });
    const unsigned = await decide({
      asset_id: itemRequest.asset_id,
      ancestor_id: transferBoundary.authorityReceiptId,
      expected_revision: 0,
      outcome: "revoked",
      reason: "legacy unsigned decision",
    });
    expect(unsigned.status).toBe(400);
    await unsigned.json();
    const unknownArbiter = structuredClone(revocation);
    unknownArbiter.authentication.arbiter_id = "unknown-arbiter";
    const unknown = await decide(unknownArbiter);
    expect(unknown.status).toBe(403);
    await expect(unknown.json()).resolves.toMatchObject({
      decision: "unknown_arbiter",
    });
    const expiredCertificate = signedLineageDecision("reference-game", unit, {
      asset_id: itemRequest.asset_id,
      ancestor_id: transferBoundary.authorityReceiptId,
      ancestor_kind: "origin",
      expected_revision: 0,
      outcome: "revoked",
      reason: "expired external decision",
      issued_at_ms: Date.now() - 20_000,
      expires_at_ms: Date.now() - 10_000,
      appeal_deadline_at_ms: Date.now() + 60_000,
    });
    const expired = await decide(expiredCertificate);
    expect(expired.status).toBe(403);
    await expect(expired.json()).resolves.toMatchObject({
      decision: "certificate_expired",
    });
    expect((await decide(revocation, false)).status).toBe(401);
    const revoked = await decide(revocation);
    expect(revoked.status).toBe(201);
    const revokedDecision = await revoked.json() as {
      decision_id: string;
    };
    expect(revokedDecision).toMatchObject({
      ok: true,
      decision: "applied",
      ancestor_kind: "origin",
      revision: 1,
      lineage_status: "revoked",
      lifecycle: "appeal_open",
      quarantined_listings: 1,
    });
    const denied = await list(listingRequest);
    expect(denied.status).toBe(403);
    await expect(denied.json()).resolves.toMatchObject({
      allowed: false,
      decision: "asset_lineage_revoked",
    });
    const deniedTransfer = await SELF.fetch(
      `https://example.test/v1/pve/${unit}/game-item-transfers`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(transferRequest),
      },
    );
    expect(deniedTransfer.status).toBe(403);
    await expect(deniedTransfer.json()).resolves.toMatchObject({
      transferred: false,
      decision: "asset_lineage_revoked",
      open_revocations: 1,
    });

    const transferRevocation = signedLineageDecision("reference-game", unit, {
      asset_id: itemRequest.asset_id,
      ancestor_id: transferredBody.transfer.transfer_id,
      ancestor_kind: "transfer",
      expected_revision: 0,
      outcome: "revoked",
      reason: "transfer signature challenge upheld",
    });
    const transferRevoked = await decide(transferRevocation);
    expect(transferRevoked.status).toBe(201);
    const transferRevokedDecision = await transferRevoked.json() as {
      decision_id: string;
    };
    expect(transferRevokedDecision).toMatchObject({
      decision: "applied",
      ancestor_kind: "transfer",
      lineage_status: "revoked",
      open_revocations: 2,
      quarantined_listings: 0,
    });

    await evictAuditShard("pve", unit);

    const restored = await decide(signedLineageDecision("reference-game", unit, {
      asset_id: itemRequest.asset_id,
      ancestor_id: transferBoundary.authorityReceiptId,
      ancestor_kind: "origin",
      expected_revision: 1,
      outcome: "eligible",
      reason: "appeal accepted after authoritative replay",
      appeal_of_decision_id: revokedDecision.decision_id,
    }));
    expect(restored.status).toBe(201);
    await expect(restored.json()).resolves.toMatchObject({
      decision: "applied",
      revision: 2,
      lineage_status: "eligible",
      open_revocations: 1,
    });
    const stillDenied = await list(listingRequest);
    expect(stillDenied.status).toBe(403);
    await expect(stillDenied.json()).resolves.toMatchObject({
      allowed: false,
      decision: "asset_lineage_revoked",
      open_revocations: 1,
    });
    const transferRestored = await decide(signedLineageDecision(
      "reference-game",
      unit,
      {
        asset_id: itemRequest.asset_id,
        ancestor_id: transferredBody.transfer.transfer_id,
        ancestor_kind: "transfer",
      expected_revision: 1,
      outcome: "eligible",
      reason: "transfer appeal accepted after signature audit",
        appeal_of_decision_id: transferRevokedDecision.decision_id,
      },
    ));
    expect(transferRestored.status).toBe(201);
    await expect(transferRestored.json()).resolves.toMatchObject({
      decision: "applied",
      revision: 2,
      lineage_status: "eligible",
      open_revocations: 0,
    });
    const quarantinedReplay = await list(listingRequest);
    expect(quarantinedReplay.status).toBe(409);
    await expect(quarantinedReplay.json()).resolves.toMatchObject({
      allowed: false,
      decision: "listing_quarantined",
    });

    const freshBoundary = {
      ...listingBoundary,
      listingNonce: "6".repeat(64),
    };
    const fresh = await list({
      ...listingRequest,
      listing_nonce: freshBoundary.listingNonce,
      owner_signature: signGameMarketListingProof(
        unit,
        freshBoundary,
        referenceGameDigest,
        recipientSigner,
      ),
    });
    expect(fresh.status).toBe(201);
    await expect(fresh.json()).resolves.toMatchObject({
      allowed: true,
      decision: "listed",
      listing: { listing_nonce: freshBoundary.listingNonce },
    });

    const duplicateRevocation = await decide(transferRevocation);
    expect(duplicateRevocation.status).toBe(200);
    await expect(duplicateRevocation.json()).resolves.toMatchObject({
      decision: "duplicate",
      ancestor_kind: "transfer",
      decision_revision: 1,
      decision_outcome: "revoked",
      revision: 2,
      lineage_status: "eligible",
      open_revocations: 0,
    });
    const staleAppeal = await decide(signedLineageDecision(
      "reference-game",
      unit,
      {
      asset_id: itemRequest.asset_id,
      ancestor_id: transferredBody.transfer.transfer_id,
      ancestor_kind: "transfer",
      expected_revision: 0,
      outcome: "eligible",
      reason: "stale appeal",
      appeal_of_decision_id: transferRevokedDecision.decision_id,
      },
    ));
    expect(staleAppeal.status).toBe(409);
    await expect(staleAppeal.json()).resolves.toMatchObject({
      decision: "stale_lineage_revision",
      current_revision: 2,
      current_status: "eligible",
    });

    const shortWindowRevocation = signedLineageDecision(
      "reference-game",
      unit,
      {
        asset_id: itemRequest.asset_id,
        ancestor_id: transferredBody.transfer.transfer_id,
        ancestor_kind: "transfer",
        expected_revision: 2,
        outcome: "revoked",
        reason: "short appeal window",
        appeal_deadline_at_ms: Date.now() + 100,
      },
    );
    const shortWindowRevoked = await decide(shortWindowRevocation);
    expect(shortWindowRevoked.status).toBe(201);
    const shortWindowDecision = await shortWindowRevoked.json() as {
      decision_id: string;
    };
    await new Promise((resolve) => setTimeout(resolve, 150));
    const lateAppeal = await decide(signedLineageDecision(
      "reference-game",
      unit,
      {
        asset_id: itemRequest.asset_id,
        ancestor_id: transferredBody.transfer.transfer_id,
        ancestor_kind: "transfer",
        expected_revision: 3,
        outcome: "eligible",
        reason: "late appeal",
        appeal_of_decision_id: shortWindowDecision.decision_id,
      },
    ));
    expect(lateAppeal.status).toBe(409);
    await expect(lateAppeal.json()).resolves.toMatchObject({
      decision: "appeal_window_expired",
    });
  });

  it("issues an item receipt from a later authority-verified epoch", async () => {
    const unit = `reference-game-later-item-${crypto.randomUUID()}`;
    const audit = referenceGameRun(60, (tick) => tick <= 30 ? -1 : 1);
    const firstRequest = buildGameCheckpointVerificationRequest(audit, 0);
    const itemRequest = authenticateGameItemVerificationRequest(
      unit,
      buildGameItemVerificationRequest(
        audit,
        audit.checkpoints[1].createdAssetIds[0],
      ),
      referenceGameDigest,
      referenceGameOwnerSigner,
    );
    const submit = (action: string, body: unknown) => SELF.fetch(
      `https://example.test/v1/pve/${unit}/${action}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      },
    );

    const parent = await submit("game-checkpoint-verifications", firstRequest);
    expect(parent.status).toBe(201);
    const item = await submit("game-item-verifications", itemRequest);
    expect(item.status).toBe(201);
    await expect(item.json()).resolves.toMatchObject({
      ok: true,
      decision: "verified",
      receipt: {
        asset_id: itemRequest.asset_id,
        checkpoint_digest: itemRequest.checkpoint.checkpoint_digest,
        inventory_epoch: 1,
      },
    });
  });

  it("persists replayed checkpoint state and advances from it after eviction", async () => {
    const unit = `reference-game-checkpoints-${crypto.randomUUID()}`;
    const audit = referenceGameRun(60);
    const firstRequest = buildGameCheckpointVerificationRequest(audit, 0);
    const secondRequest = buildGameCheckpointVerificationRequest(audit, 1);
    const submit = (body: unknown) => SELF.fetch(
      `https://example.test/v1/pve/${unit}/game-checkpoint-verifications`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      },
    );

    const missingParent = await submit(secondRequest);
    expect(missingParent.status).toBe(409);
    await expect(missingParent.json()).resolves.toEqual({
      ok: false,
      error: "reference_game_parent_not_verified",
    });

    const first = await submit(firstRequest);
    expect(first.status).toBe(201);
    await expect(first.json()).resolves.toMatchObject({
      ok: true,
      decision: "verified",
      receipt: {
        version: 1,
        epoch: 0,
        last_tick: 30,
        checkpoint_digest: firstRequest.checkpoint.checkpoint_digest,
      },
    });

    await evictAuditShard("pve", unit);
    const second = await submit(secondRequest);
    expect(second.status).toBe(201);
    const acceptedSecond = await second.json() as Record<string, unknown>;
    expect(acceptedSecond).toMatchObject({
      ok: true,
      decision: "verified",
      receipt: {
        version: 1,
        epoch: 1,
        last_tick: 60,
        checkpoint_digest: secondRequest.checkpoint.checkpoint_digest,
      },
    });

    await evictAuditShard("pve", unit);
    const duplicate = await submit(secondRequest);
    expect(duplicate.status).toBe(200);
    await expect(duplicate.json()).resolves.toEqual({
      ...acceptedSecond,
      decision: "duplicate",
    });
  });

  it("replays a high-value item segment and persists an idempotent receipt", async () => {
    const unit = `reference-game-${crypto.randomUUID()}`;
    const request = referenceGameItemRequest(unit);
    const submit = () => SELF.fetch(
      `https://example.test/v1/pve/${unit}/game-item-verifications`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(request),
      },
    );

    const accepted = await submit();
    expect(accepted.status).toBe(201);
    const first = await accepted.json() as Record<string, unknown>;
    expect(first).toMatchObject({
      ok: true,
      decision: "verified",
      receipt: {
        version: 1,
        asset_id: request.asset_id,
        owner_id: request.player_id,
        checkpoint_digest: request.checkpoint.checkpoint_digest,
        inventory_epoch: 0,
      },
    });

    await evictAuditShard("pve", unit);
    const duplicate = await submit();
    expect(duplicate.status).toBe(200);
    await expect(duplicate.json()).resolves.toEqual({
      ...first,
      decision: "duplicate",
    });
  });

  it("refuses a stolen item transcript without the genesis owner signature", async () => {
    const unit = `reference-game-stolen-transcript-${crypto.randomUUID()}`;
    const request = referenceGameItemRequest(unit);
    request.owner_signature = "f".repeat(128);

    const response = await SELF.fetch(
      `https://example.test/v1/pve/${unit}/game-item-verifications`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(request),
      },
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      ok: false,
      error: "owner_authentication_refused",
    });
  });

  it("refuses a claimed item that differs from authority replay", async () => {
    const unit = `reference-game-tamper-${crypto.randomUUID()}`;
    const request = referenceGameItemRequest(unit);
    const last = JSON.parse(request.events.at(-1)!.canonical_payload);
    last[4][2][5][0] = "forged-asset";
    request.events.at(-1)!.canonical_payload = JSON.stringify(last);
    request.events.at(-1)!.created_asset_ids = ["forged-asset"];

    const response = await SELF.fetch(
      `https://example.test/v1/pve/${unit}/game-item-verifications`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(request),
      },
    );
    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toEqual({
      ok: false,
      error: "event_replay_mismatch",
    });
  });

  it("fails closed when witness source bucketing has no server secret", async () => {
    const auditEnv = env as unknown as AuditEnv;
    const response = await worker.fetch(
      new Request(
        "https://example.test/v1/pvp/missing-source-secret/checkpoint-witness-approvals",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({}),
        },
      ),
      {
        AUDIT_SHARD: auditEnv.AUDIT_SHARD,
        REPLAY_QUEUE: auditEnv.REPLAY_QUEUE,
        ADMIN_TOKEN: "test-admin-token",
        WITNESS_SOURCE_BUCKET_KEY: "",
      } as AuditEnv,
    );
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      error: "checkpoint_witness_source_bucketing_not_configured",
    });
  });

  it("fails closed when reference-game source bucketing has no server secret", async () => {
    const auditEnv = env as unknown as AuditEnv;
    const response = await worker.fetch(
      new Request(
        "https://example.test/v1/pve/missing-source-secret/game-market-listings",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({}),
        },
      ),
      {
        AUDIT_SHARD: auditEnv.AUDIT_SHARD,
        REPLAY_QUEUE: auditEnv.REPLAY_QUEUE,
        ADMIN_TOKEN: "test-admin-token",
        WITNESS_SOURCE_BUCKET_KEY: "",
      } as AuditEnv,
    );
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      error: "reference_game_source_bucketing_not_configured",
    });
  });

  it("refuses a checkpoint at an unprovisioned receiver", async () => {
    const mode = "pvp" as const;
    const unit = crypto.randomUUID();
    const sessionId = `cf:pvp:${unit}`;
    const anchor = fixture(sessionId, "observer-unprovisioned", 0, "genesis");
    await configure(
      mode,
      unit,
      sessionId,
      anchor.authority_key,
      anchor.epoch,
      anchor.previous_digest,
    );
    const configured = await configureCheckpointRuntime(
      mode,
      unit,
      8,
      ["authority-1"],
    );
    await expect(configured.json()).resolves.toMatchObject({
      destinations_provisioned: 1,
    });
    await closeCheckpointEpoch(mode, unit, 0);
    await sealCheckpoint(
      mode,
      unit,
      0,
      "genesis",
      "checkpoint-unprovisioned",
      ["authority-1"],
    );
    const state = await checkpointState(mode, unit) as {
      outbox: { entries: CheckpointDeliveryJob[] };
    };
    const job = state.outbox.entries[0];
    const auditEnv = env as unknown as AuditEnv;
    const unprovisioned = auditEnv.AUDIT_SHARD.get(
      auditEnv.AUDIT_SHARD.idFromName(`unprovisioned:${crypto.randomUUID()}`),
    );
    const refused = await unprovisioned.fetch(
      "https://audit.internal/checkpoint-receive",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-audit-internal": "checkpoint-queue-consumer",
          "x-audit-mode": job.mode,
          "x-audit-unit": job.unit,
        },
        body: JSON.stringify(job),
      },
    );
    expect(refused.status).toBe(409);
    await expect(refused.json()).resolves.toMatchObject({
      error: "checkpoint_receiver_not_configured",
    });
  });

  it("refuses an under-quorum seal before source history or outbox mutation", async () => {
    const mode = "pvp" as const;
    const unit = crypto.randomUUID();
    const sessionId = `cf:pvp:${unit}`;
    const anchor = fixture(sessionId, "observer-under-quorum-seal", 0, "genesis");
    await configure(
      mode,
      unit,
      sessionId,
      anchor.authority_key,
      anchor.epoch,
      anchor.previous_digest,
    );
    await configureCheckpointRuntime(mode, unit, 8, ["authority-1"]);
    await closeCheckpointEpoch(mode, unit, 0);
    const authentication = checkpointDeliveryFixture(
      mode,
      unit,
      "authority-1",
      0,
      "genesis",
      "checkpoint-under-quorum",
      "canonical-envelope-0",
      2,
    ).authentication;
    const refused = await SELF.fetch(
      `https://example.test/v1/${mode}/${unit}/checkpoint-seals`,
      {
        method: "POST",
        headers: {
          authorization: "Bearer test-admin-token",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          epoch: 0,
          previous_checkpoint: "genesis",
          checkpoint_digest: "checkpoint-under-quorum",
          canonical_envelope: "canonical-envelope-0",
          destinations: ["authority-1"],
          authentications: [{
            destination_id: "authority-1",
            authentication,
          }],
        }),
      },
    );
    expect(refused.status).toBe(409);
    await expect(refused.json()).resolves.toMatchObject({
      reason: "checkpoint_delivery_authentication_refused",
      authentication_error: "under_quorum",
    });
    await expect(checkpointState(mode, unit)).resolves.toMatchObject({
      head: { epoch: -1, digest: "genesis" },
      history: 0,
      closures: { ready: 1, consumed: 0 },
      outbox: { pending: 0, in_flight: 0, acknowledged: 0 },
    });
  });

  it("requires producer signature and provisioned witness quorum before receiver mutation", async () => {
    const mode = "open" as const;
    const unit = crypto.randomUUID();
    const sessionId = `cf:open:${unit}`;
    const anchor = fixture(sessionId, "observer-hostile-receiver", 0, "genesis");
    await configure(
      mode,
      unit,
      sessionId,
      anchor.authority_key,
      anchor.epoch,
      anchor.previous_digest,
    );
    await configureCheckpointRuntime(mode, unit, 8, ["authority-1"]);
    await closeCheckpointEpoch(mode, unit, 0);
    await sealCheckpoint(
      mode,
      unit,
      0,
      "genesis",
      "checkpoint-hostile-receiver",
      ["authority-1"],
    );
    const state = await checkpointState(mode, unit) as {
      outbox: { entries: CheckpointDeliveryJob[] };
    };
    const job = state.outbox.entries[0];
    const auditEnv = env as unknown as AuditEnv;
    const receiver = auditEnv.AUDIT_SHARD.get(
      auditEnv.AUDIT_SHARD.idFromName(checkpointDestinationObjectName(job)),
    );
    const receive = (value: CheckpointDeliveryJob) => receiver.fetch(
      "https://audit.internal/checkpoint-receive",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-audit-internal": "checkpoint-queue-consumer",
          "x-audit-mode": value.mode,
          "x-audit-unit": value.unit,
        },
        body: JSON.stringify(value),
      },
    );
    const invalidSignature: CheckpointDeliveryJob = {
      ...job,
      authentication: {
        ...job.authentication,
        producer_signature: `${
          job.authentication.producer_signature[0] === "0" ? "1" : "0"
        }${job.authentication.producer_signature.slice(1)}`,
      },
    };
    const invalidSignatureResponse = await receive(invalidSignature);
    expect(invalidSignatureResponse.status).toBe(401);
    await expect(invalidSignatureResponse.json()).resolves.toMatchObject({
      authentication_error: "invalid_producer_signature",
    });

    const underQuorum: CheckpointDeliveryJob = {
      ...job,
      authentication: {
        ...job.authentication,
        approvals: job.authentication.approvals.slice(0, 2),
      },
    };
    const underQuorumResponse = await receive(underQuorum);
    expect(underQuorumResponse.status).toBe(401);
    await expect(underQuorumResponse.json()).resolves.toMatchObject({
      authentication_error: "under_quorum",
    });

    const foreignWitness: CheckpointDeliveryJob = {
      ...job,
      authentication: {
        ...job.authentication,
        approvals: job.authentication.approvals.map((approval, index) =>
          index === 0 ? { ...approval, witness_id: "mallory" } : approval
        ),
      },
    };
    const foreignWitnessResponse = await receive(foreignWitness);
    expect(foreignWitnessResponse.status).toBe(401);
    await expect(foreignWitnessResponse.json()).resolves.toMatchObject({
      authentication_error: "unknown_witness",
    });

    const accepted = await receive(job);
    expect(accepted.status).toBe(202);
    await expect(accepted.json()).resolves.toMatchObject({
      decision: "accepted",
      epoch: 0,
      checkpoint_digest: "checkpoint-hostile-receiver",
    });
  }, 20_000);

  it("lets each peer sign only its own checkpoint witness approval", () => {
    const complete = checkpointDeliveryFixture(
      "pvp",
      "peer-signing",
      "authority-1",
      0,
      "genesis",
      "checkpoint-peer-signing",
      "canonical-envelope-peer-signing",
      3,
    );

    for (let index = 0; index < 3; index++) {
      const signed = checkpointDeliveryApproval(
        CHECKPOINT_WITNESS_SEEDS[index],
        CHECKPOINT_WITNESS_IDS[index],
        complete.authentication.statement_digest,
      );
      expect(signed).toMatchObject({
        ok: true,
        approval: complete.authentication.approvals[index],
      });
    }
  });

  it("collects remote witness approvals durably before allowing a collection-backed seal", async () => {
    const mode = "pvp" as const;
    const unit = crypto.randomUUID();
    const sessionId = `cf:pvp:${unit}`;
    const anchor = fixture(sessionId, "observer-witness-collection", 0, "genesis");
    await configure(
      mode,
      unit,
      sessionId,
      anchor.authority_key,
      anchor.epoch,
      anchor.previous_digest,
    );
    await configureCheckpointRuntime(mode, unit, 8, ["authority-1"]);
    await closeCheckpointEpoch(mode, unit, 0);
    const statement = {
      destination_id: "authority-1",
      epoch: 0,
      previous_checkpoint: "genesis",
      checkpoint_digest: "checkpoint-collected",
      canonical_envelope: "canonical-envelope-collected",
    };
    const producerOnly = checkpointDeliveryFixture(
      mode,
      unit,
      statement.destination_id,
      statement.epoch,
      statement.previous_checkpoint,
      statement.checkpoint_digest,
      statement.canonical_envelope,
      0,
    );
    const complete = checkpointDeliveryFixture(
      mode,
      unit,
      statement.destination_id,
      statement.epoch,
      statement.previous_checkpoint,
      statement.checkpoint_digest,
      statement.canonical_envelope,
      3,
    );
    const started = await SELF.fetch(
      `https://example.test/v1/${mode}/${unit}/checkpoint-witness-collections`,
      {
        method: "POST",
        headers: {
          authorization: "Bearer test-admin-token",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          ...statement,
          deadline_at: Date.now() + 60_000,
          producer_authentication: producerOnly.authentication,
        }),
      },
    );
    expect(started.status).toBe(201);
    const startedBody = await started.json() as {
      collection_id: string;
      status: string;
      approval_count: number;
    };
    expect(startedBody).toMatchObject({ status: "collecting", approval_count: 0 });

    const publicStatus = await SELF.fetch(
      `https://example.test/v1/${mode}/${unit}/checkpoint-witness-collections?collection_id=${
        encodeURIComponent(startedBody.collection_id)
      }`,
    );
    expect(publicStatus.status).toBe(200);
    await expect(publicStatus.json()).resolves.toMatchObject({
      collection_id: startedBody.collection_id,
      status: "collecting",
      statement,
    });

    const submitApproval = (approval: typeof complete.authentication.approvals[number]) =>
      SELF.fetch(
        `https://example.test/v1/${mode}/${unit}/checkpoint-witness-approvals`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            collection_id: startedBody.collection_id,
            approval,
          }),
        },
      );
    const foreign = await submitApproval({
      ...complete.authentication.approvals[0],
      witness_id: "mallory",
    });
    expect(foreign.status).toBe(409);
    await expect(foreign.json()).resolves.toMatchObject({
      decision: "refused",
      reason: "unknown_witness",
      approval_count: 0,
    });

    const first = await submitApproval(complete.authentication.approvals[0]);
    expect(first.status).toBe(202);
    await expect(first.json()).resolves.toMatchObject({
      decision: "accepted",
      status: "collecting",
      approval_count: 1,
    });
    await abortAllDurableObjects();
    const invalidConflict = await submitApproval({
      ...complete.authentication.approvals[0],
      signature: `${
        complete.authentication.approvals[0].signature[0] === "0" ? "1" : "0"
      }${complete.authentication.approvals[0].signature.slice(1)}`,
    });
    expect(invalidConflict.status).toBe(409);
    await expect(invalidConflict.json()).resolves.toMatchObject({
      decision: "refused",
      reason: "invalid_witness_signature",
      approval_count: 1,
    });
    const duplicate = await submitApproval(complete.authentication.approvals[0]);
    expect(duplicate.status).toBe(200);
    await expect(duplicate.json()).resolves.toMatchObject({
      decision: "duplicate",
      approval_count: 1,
    });
    const second = await submitApproval(complete.authentication.approvals[1]);
    expect(second.status).toBe(202);

    const sealFromCollection = () => SELF.fetch(
      `https://example.test/v1/${mode}/${unit}/checkpoint-seals`,
      {
        method: "POST",
        headers: {
          authorization: "Bearer test-admin-token",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          epoch: statement.epoch,
          previous_checkpoint: statement.previous_checkpoint,
          checkpoint_digest: statement.checkpoint_digest,
          canonical_envelope: statement.canonical_envelope,
          destinations: [statement.destination_id],
          authentication_collection_ids: [{
            destination_id: statement.destination_id,
            collection_id: startedBody.collection_id,
          }],
        }),
      },
    );
    const earlySeal = await sealFromCollection();
    expect(earlySeal.status).toBe(409);
    await expect(earlySeal.json()).resolves.toMatchObject({
      reason: "witness_collection_not_ready",
    });

    const quorum = await submitApproval(complete.authentication.approvals[2]);
    expect(quorum.status).toBe(201);
    await expect(quorum.json()).resolves.toMatchObject({
      decision: "accepted",
      status: "ready",
      approval_count: 3,
    });
    const committed = await sealFromCollection();
    expect(committed.status).toBe(202);
    await expect(committed.json()).resolves.toMatchObject({
      decision: "committed",
      digest: statement.checkpoint_digest,
    });

    const expiringStatement = {
      ...statement,
      checkpoint_digest: "checkpoint-expiring-collection",
      canonical_envelope: "canonical-envelope-expiring-collection",
    };
    const expiring = checkpointDeliveryFixture(
      mode,
      unit,
      expiringStatement.destination_id,
      expiringStatement.epoch,
      expiringStatement.previous_checkpoint,
      expiringStatement.checkpoint_digest,
      expiringStatement.canonical_envelope,
      0,
    );
    const expiringComplete = checkpointDeliveryFixture(
      mode,
      unit,
      expiringStatement.destination_id,
      expiringStatement.epoch,
      expiringStatement.previous_checkpoint,
      expiringStatement.checkpoint_digest,
      expiringStatement.canonical_envelope,
      3,
    );
    const expiringStart = await SELF.fetch(
      `https://example.test/v1/${mode}/${unit}/checkpoint-witness-collections`,
      {
        method: "POST",
        headers: {
          authorization: "Bearer test-admin-token",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          ...expiringStatement,
          deadline_at: Date.now() + 100,
          producer_authentication: expiring.authentication,
        }),
      },
    );
    expect(expiringStart.status).toBe(201);
    const expiringBody = await expiringStart.json() as { collection_id: string };
    await new Promise((resolve) => setTimeout(resolve, 125));
    const expired = await SELF.fetch(
      `https://example.test/v1/${mode}/${unit}/checkpoint-witness-approvals`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          collection_id: expiringBody.collection_id,
          approval: expiringComplete.authentication.approvals[0],
        }),
      },
    );
    expect(expired.status).toBe(409);
    await expect(expired.json()).resolves.toMatchObject({
      decision: "refused",
      reason: "collection_expired",
      approval_count: 0,
    });
  }, 20_000);

  it("rate-limits one hostile source without starving another source's valid quorum", async () => {
    const mode = "open" as const;
    const unit = crypto.randomUUID();
    const sessionId = `cf:open:${unit}`;
    const anchor = fixture(sessionId, "observer-witness-rate-limit", 0, "genesis");
    await configure(
      mode,
      unit,
      sessionId,
      anchor.authority_key,
      anchor.epoch,
      anchor.previous_digest,
    );
    await configureCheckpointRuntime(mode, unit, 8, ["authority-1"]);
    const statement = {
      destination_id: "authority-1",
      epoch: 0,
      previous_checkpoint: "genesis",
      checkpoint_digest: "checkpoint-rate-limited",
      canonical_envelope: "canonical-envelope-rate-limited",
    };
    const producerOnly = checkpointDeliveryFixture(
      mode,
      unit,
      statement.destination_id,
      statement.epoch,
      statement.previous_checkpoint,
      statement.checkpoint_digest,
      statement.canonical_envelope,
      0,
    );
    const complete = checkpointDeliveryFixture(
      mode,
      unit,
      statement.destination_id,
      statement.epoch,
      statement.previous_checkpoint,
      statement.checkpoint_digest,
      statement.canonical_envelope,
      3,
    );
    const started = await SELF.fetch(
      `https://example.test/v1/${mode}/${unit}/checkpoint-witness-collections`,
      {
        method: "POST",
        headers: {
          authorization: "Bearer test-admin-token",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          ...statement,
          deadline_at: Date.now() + 60_000,
          producer_authentication: producerOnly.authentication,
        }),
      },
    );
    const { collection_id: collectionId } = await started.json() as {
      collection_id: string;
    };
    const submitFrom = (
      sourceIp: string,
      approval: typeof complete.authentication.approvals[number],
      attackerSelectedBucket?: string,
    ) => SELF.fetch(
      `https://example.test/v1/${mode}/${unit}/checkpoint-witness-approvals`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "cf-connecting-ip": sourceIp,
          ...(attackerSelectedBucket
            ? { "x-audit-source-bucket": attackerSelectedBucket }
            : {}),
        },
        body: JSON.stringify({ collection_id: collectionId, approval }),
      },
    );
    const invalid = {
      ...complete.authentication.approvals[0],
      witness_id: "mallory",
    };
    for (let attempt = 0; attempt < 8; attempt++) {
      const response = await submitFrom(
        "192.0.2.10",
        invalid,
        attempt.toString(16).padStart(64, "0"),
      );
      expect(response.status).toBe(409);
    }
    const limited = await submitFrom("192.0.2.10", invalid, "f".repeat(64));
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBe("1");
    await expect(limited.json()).resolves.toMatchObject({
      error: "checkpoint_witness_source_rate_limited",
    });

    for (const [index, approval] of complete.authentication.approvals.entries()) {
      const response = await submitFrom("198.51.100.20", approval);
      expect(response.status).toBe(index === 2 ? 201 : 202);
    }
    const status = await SELF.fetch(
      `https://example.test/v1/${mode}/${unit}/checkpoint-witness-collections?collection_id=${
        encodeURIComponent(collectionId)
      }`,
    );
    await expect(status.json()).resolves.toMatchObject({
      status: "ready",
      approval_count: 3,
    });
  }, 20_000);

  it("authenticates Queue delivery against the source durable outbox before receiver mutation", async () => {
    const mode = "open" as const;
    const unit = crypto.randomUUID();
    const sessionId = `cf:open:${unit}`;
    const anchor = fixture(sessionId, "observer-source-auth", 0, "genesis");
    await configure(
      mode,
      unit,
      sessionId,
      anchor.authority_key,
      anchor.epoch,
      anchor.previous_digest,
    );
    await configureCheckpointRuntime(mode, unit, 8, ["authority-1"]);
    await closeCheckpointEpoch(mode, unit, 0);
    await sealCheckpoint(
      mode,
      unit,
      0,
      "genesis",
      "checkpoint-authenticated",
      ["authority-1"],
    );
    const state = await checkpointState(mode, unit) as {
      outbox: { entries: CheckpointDeliveryJob[] };
    };
    const job = state.outbox.entries[0];
    const forgedDigest = "checkpoint-forged";
    const forged: CheckpointDeliveryJob = {
      ...job,
      checkpoint_digest: forgedDigest,
      canonical_envelope: "canonical-envelope-forged",
      idempotency_key: checkpointDeliveryIdempotencyKey(
        job.boundary,
        job.destination_id,
        job.epoch,
        forgedDigest,
      ),
    };
    const auditEnv = env as unknown as AuditEnv;
    const forgedBatch = createMessageBatch<CheckpointDeliveryJob>(
      "converge-game-audit-checkpoints",
      [{
        id: "checkpoint-forged-consistent",
        timestamp: new Date(),
        body: forged,
        attempts: 1,
      }],
    );
    const forgedContext = createExecutionContext();
    await worker.queue!(forgedBatch, auditEnv, forgedContext);
    const forgedResult = await getQueueResult(forgedBatch, forgedContext);
    expect(forgedResult.explicitAcks).toStrictEqual([]);
    expect(forgedResult.retryMessages).toHaveLength(1);

    const realBatch = createMessageBatch<CheckpointDeliveryJob>(
      "converge-game-audit-checkpoints",
      [{
        id: "checkpoint-real-after-forgery",
        timestamp: new Date(),
        body: job,
        attempts: 1,
      }],
    );
    const realContext = createExecutionContext();
    await worker.queue!(realBatch, auditEnv, realContext);
    const realResult = await getQueueResult(realBatch, realContext);
    expect(realResult.explicitAcks).toStrictEqual([
      "checkpoint-real-after-forgery",
    ]);
    expect(realResult.retryMessages).toStrictEqual([]);
    await expect(checkpointState(mode, unit)).resolves.toMatchObject({
      outbox: {
        acknowledged: 1,
        ack_decisions: { accepted: 1, duplicate: 0 },
      },
    });
  }, 20_000);

  it("commits an exact Accepted ACK and deduplicates its Queue redelivery", async () => {
    const mode = "pve" as const;
    const unit = crypto.randomUUID();
    const sessionId = `cf:pve:${unit}`;
    const anchor = fixture(sessionId, "observer-checkpoint-ack", 0, "genesis");
    await configure(
      mode,
      unit,
      sessionId,
      anchor.authority_key,
      anchor.epoch,
      anchor.previous_digest,
    );
    await configureCheckpointRuntime(mode, unit, 8, ["authority-1"]);
    await closeCheckpointEpoch(mode, unit, 0);
    await sealCheckpoint(
      mode,
      unit,
      0,
      "genesis",
      "checkpoint-accepted",
      ["authority-1"],
    );
    const state = await checkpointState(mode, unit) as {
      outbox: {
        entries: Array<CheckpointDeliveryJob & {
          attempts: number;
          lease_expires_at: number | null;
          last_attempt_at: number | null;
          acknowledged_at: number | null;
          ack_decision: "accepted" | "duplicate" | null;
        }>;
      };
    };
    const job = state.outbox.entries[0];
    expect(job).toMatchObject({
      state: "in_flight",
      attempts: 1,
      lease_expires_at: expect.any(Number),
      last_attempt_at: expect.any(Number),
      acknowledged_at: null,
      ack_decision: null,
    });

    for (const [index, attempts] of [1, 2].entries()) {
      const id = `checkpoint-accepted-${index}`;
      const batch = createMessageBatch<CheckpointDeliveryJob>(
        "converge-game-audit-checkpoints",
        [{ id, timestamp: new Date(), body: job, attempts }],
      );
      const context = createExecutionContext();
      await worker.queue!(batch, env as unknown as AuditEnv, context);
      const result = await getQueueResult(batch, context);
      expect(result.explicitAcks).toStrictEqual([id]);
      expect(result.retryMessages).toStrictEqual([]);
    }
    await expect(checkpointState(mode, unit)).resolves.toMatchObject({
      outbox: {
        pending: 0,
        in_flight: 0,
        acknowledged: 1,
        ack_decisions: { accepted: 1, duplicate: 0 },
        entries: [{
          state: "acknowledged",
          attempts: 1,
          lease_expires_at: null,
          last_attempt_at: expect.any(Number),
          acknowledged_at: expect.any(Number),
          ack_decision: "accepted",
        }],
      },
    });
  }, 20_000);

  it("settles the authority ACK directly from the durable outbox", async () => {
    const mode = "pvp" as const;
    const unit = crypto.randomUUID();
    const sessionId = `cf:pvp:${unit}`;
    const anchor = fixture(sessionId, "observer-checkpoint-direct", 0, "genesis");
    await configure(
      mode,
      unit,
      sessionId,
      anchor.authority_key,
      anchor.epoch,
      anchor.previous_digest,
    );
    await configureCheckpointRuntime(mode, unit, 8, ["authority-1"]);
    await closeCheckpointEpoch(mode, unit, 0);
    const seal = await sealCheckpoint(
      mode,
      unit,
      0,
      "genesis",
      "checkpoint-direct",
      ["authority-1"],
      undefined,
      false,
      "direct",
    );
    expect(seal.status).toBe(202);
    await expect(seal.json()).resolves.toMatchObject({
      delivery_dispatch: {
        pending_before: 1,
        in_flight_before: 0,
        claimed: 1,
        acknowledged: 1,
        unsettled: 0,
        errors: [],
      },
    });
    await expect(checkpointState(mode, unit)).resolves.toMatchObject({
      outbox: {
        pending: 0,
        in_flight: 0,
        acknowledged: 1,
        ack_decisions: { accepted: 1, duplicate: 0 },
        entries: [{
          state: "acknowledged",
          attempts: 1,
          ack_decision: "accepted",
        }],
      },
    });
  });

  it("recovers an ACK lost after authority commit with a historical Duplicate ACK", async () => {
    const mode = "open" as const;
    const unit = crypto.randomUUID();
    const sessionId = `cf:open:${unit}`;
    const anchor = fixture(sessionId, "observer-checkpoint-send", 0, "genesis");
    await configure(
      mode,
      unit,
      sessionId,
      anchor.authority_key,
      anchor.epoch,
      anchor.previous_digest,
    );
    await configureCheckpointRuntime(mode, unit, 8, ["authority-1"]);
    await closeCheckpointEpoch(mode, unit, 0);
    expect((await sealCheckpoint(
      mode,
      unit,
      0,
      "genesis",
      "checkpoint-0",
      ["authority-1"],
    )).status).toBe(202);
    await closeCheckpointEpoch(mode, unit, 1);
    expect((await sealCheckpoint(
      mode,
      unit,
      1,
      "checkpoint-0",
      "checkpoint-1",
      ["authority-1"],
    )).status).toBe(202);

    const before = await checkpointState(mode, unit) as {
      outbox: { entries: CheckpointDeliveryJob[] };
    };
    const epoch0 = before.outbox.entries.find((entry) => entry.epoch === 0);
    const epoch1 = before.outbox.entries.find((entry) => entry.epoch === 1);
    expect(epoch0?.state).toBe("in_flight");
    expect(epoch1?.state).toBe("in_flight");
    expect(epoch0).toBeDefined();
    expect(epoch1).toBeDefined();

    const auditEnv = env as unknown as AuditEnv;
    const receiver = auditEnv.AUDIT_SHARD.get(
      auditEnv.AUDIT_SHARD.idFromName(
        checkpointDestinationObjectName(epoch0!),
      ),
    );
    for (const job of [epoch0!, epoch1!]) {
      const committedWithoutAck = await receiver.fetch(
        "https://audit.internal/checkpoint-receive",
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-audit-internal": "checkpoint-queue-consumer",
            "x-audit-mode": job.mode,
            "x-audit-unit": job.unit,
          },
          body: JSON.stringify(job),
        },
      );
      expect(committedWithoutAck.status).toBe(202);
      await expect(committedWithoutAck.json()).resolves.toMatchObject({
        decision: "accepted",
        epoch: job.epoch,
      });
    }

    const retryBatch = createMessageBatch<CheckpointDeliveryJob>(
      "converge-game-audit-checkpoints",
      [{
        id: "checkpoint-retry-0",
        timestamp: new Date(),
        body: epoch0!,
        attempts: 2,
      }],
    );
    const retryContext = createExecutionContext();
    await worker.queue!(retryBatch, auditEnv, retryContext);
    const retryResult = await getQueueResult(retryBatch, retryContext);
    expect(retryResult.explicitAcks).toStrictEqual(["checkpoint-retry-0"]);
    expect(retryResult.retryMessages).toStrictEqual([]);
    await expect(checkpointState(mode, unit)).resolves.toMatchObject({
      outbox: {
        acknowledged: 1,
        ack_decisions: { accepted: 0, duplicate: 1 },
      },
    });

    const tampered = { ...epoch1!, checkpoint_digest: "tampered" };
    const tamperedBatch = createMessageBatch<CheckpointDeliveryJob>(
      "converge-game-audit-checkpoints",
      [{
        id: "checkpoint-tampered-1",
        timestamp: new Date(),
        body: tampered,
        attempts: 1,
      }],
    );
    const tamperedContext = createExecutionContext();
    await worker.queue!(tamperedBatch, auditEnv, tamperedContext);
    const tamperedResult = await getQueueResult(tamperedBatch, tamperedContext);
    expect(tamperedResult.explicitAcks).toStrictEqual([]);
    expect(tamperedResult.retryMessages).toHaveLength(1);
    await expect(checkpointState(mode, unit)).resolves.toMatchObject({
      outbox: { acknowledged: 1, in_flight: 1 },
    });
  }, 20_000);

  it("atomically seals checkpoint history head outbox and closure across eviction", async () => {
    const unit = crypto.randomUUID();
    const sessionId = `cf:pve:${unit}`;
    const anchor = fixture(sessionId, "observer-seal", 0, "genesis");
    expect((await configure(
      "pve",
      unit,
      sessionId,
      anchor.authority_key,
      anchor.epoch,
      anchor.previous_digest,
    )).status).toBe(201);
    expect((await configureCheckpointRuntime("pve", unit)).status).toBe(201);
    expect((await closeCheckpointEpoch("pve", unit, 0)).status).toBe(201);

    const missingDestination = await sealCheckpoint(
      "pve",
      unit,
      0,
      "genesis",
      "checkpoint-0",
      ["authority-1"],
    );
    expect(missingDestination.status).toBe(409);
    await expect(missingDestination.json()).resolves.toMatchObject({
      decision: "refused",
      reason: "destination_policy_mismatch",
    });

    const committed = await sealCheckpoint(
      "pve",
      unit,
      0,
      "genesis",
      "checkpoint-0",
      ["authority-1", "peer-2"],
      undefined,
      true,
    );
    expect(committed.status).toBe(202);
    await expect(committed.json()).resolves.toMatchObject({
      decision: "committed",
      epoch: 0,
      digest: "checkpoint-0",
      outbox_entries: 2,
    });

    await expect(checkpointState("pve", unit)).resolves.toMatchObject({
      head: { epoch: 0, digest: "checkpoint-0" },
      history: 1,
      closures: { ready: 0, consumed: 1 },
      outbox: { pending: 0, in_flight: 2, acknowledged: 0 },
    });
    const configurationRetry = await configureCheckpointRuntime("pve", unit);
    expect(configurationRetry.status).toBe(200);
    await expect(configurationRetry.json()).resolves.toMatchObject({
      decision: "configuration_duplicate",
    });
    await abortAllDurableObjects();
    await expect(checkpointState("pve", unit)).resolves.toMatchObject({
      head: { epoch: 0, digest: "checkpoint-0" },
      history: 1,
      closures: { ready: 0, consumed: 1 },
      outbox: { pending: 0, in_flight: 2, acknowledged: 0 },
    });

    const duplicate = await sealCheckpoint(
      "pve",
      unit,
      0,
      "genesis",
      "checkpoint-0",
      ["authority-1", "peer-2"],
    );
    expect(duplicate.status).toBe(200);
    await expect(duplicate.json()).resolves.toMatchObject({
      decision: "duplicate",
      epoch: 0,
      digest: "checkpoint-0",
    });
  }, 20_000);

  for (
    const faultPoint of [
      "after_history",
      "after_head",
      "after_outbox",
      "after_closure",
    ] as const
  ) {
    it(`rolls back ${faultPoint} without a partial checkpoint seal`, async () => {
      const unit = crypto.randomUUID();
      const sessionId = `cf:open:${unit}`;
      const anchor = fixture(sessionId, "observer-fault", 0, "genesis");
      await configure(
        "open",
        unit,
        sessionId,
        anchor.authority_key,
        anchor.epoch,
        anchor.previous_digest,
      );
      await configureCheckpointRuntime("open", unit);
      await closeCheckpointEpoch("open", unit, 0);

      const failed = await sealCheckpoint(
        "open",
        unit,
        0,
        "genesis",
        `checkpoint-${faultPoint}`,
        ["authority-1", "peer-2"],
        faultPoint,
      );
      expect(failed.status).toBe(503);
      await expect(failed.json()).resolves.toMatchObject({
        decision: "fault_injected",
        fault_point: faultPoint,
      });
      await expect(checkpointState("open", unit)).resolves.toMatchObject({
        head: { epoch: -1, digest: "genesis" },
        history: 0,
        closures: { ready: 1, consumed: 0 },
        outbox: { pending: 0, acknowledged: 0 },
      });

      const recovered = await sealCheckpoint(
        "open",
        unit,
        0,
        "genesis",
        `checkpoint-${faultPoint}`,
        ["authority-1", "peer-2"],
      );
      expect(recovered.status).toBe(202);
    }, 10_000);
  }

  it("keeps the whole seal unchanged when durable outbox capacity is exhausted", async () => {
    const unit = crypto.randomUUID();
    const sessionId = `cf:pvp:${unit}`;
    const anchor = fixture(sessionId, "observer-capacity", 0, "genesis");
    await configure(
      "pvp",
      unit,
      sessionId,
      anchor.authority_key,
      anchor.epoch,
      anchor.previous_digest,
    );
    await configureCheckpointRuntime("pvp", unit, 1);
    await closeCheckpointEpoch("pvp", unit, 0);
    const refused = await sealCheckpoint(
      "pvp",
      unit,
      0,
      "genesis",
      "checkpoint-capacity",
      ["authority-1", "peer-2"],
    );
    expect(refused.status).toBe(409);
    await expect(refused.json()).resolves.toMatchObject({
      decision: "refused",
      reason: "outbox_capacity_exceeded",
    });
    await expect(checkpointState("pvp", unit)).resolves.toMatchObject({
      head: { epoch: -1, digest: "genesis" },
      history: 0,
      closures: { ready: 1, consumed: 0 },
      outbox: { pending: 0, acknowledged: 0 },
    });
  });

  it("reuses delivery capacity after ACK while retaining its tombstone", async () => {
    const mode = "open" as const;
    const unit = crypto.randomUUID();
    const sessionId = `cf:open:${unit}`;
    const anchor = fixture(sessionId, "observer-capacity-reuse", 0, "genesis");
    await configure(
      mode,
      unit,
      sessionId,
      anchor.authority_key,
      anchor.epoch,
      anchor.previous_digest,
    );
    await configureCheckpointRuntime(mode, unit, 1, ["authority-1"]);
    await closeCheckpointEpoch(mode, unit, 0);
    const first = await sealCheckpoint(
      mode,
      unit,
      0,
      "genesis",
      "checkpoint-capacity-0",
      ["authority-1"],
      undefined,
      false,
      "direct",
    );
    expect(first.status).toBe(202);

    await closeCheckpointEpoch(mode, unit, 1);
    const second = await sealCheckpoint(
      mode,
      unit,
      1,
      "checkpoint-capacity-0",
      "checkpoint-capacity-1",
      ["authority-1"],
      undefined,
      false,
      "direct",
    );
    expect(second.status).toBe(202);
    await expect(checkpointState(mode, unit)).resolves.toMatchObject({
      head: { epoch: 1, digest: "checkpoint-capacity-1" },
      history: 2,
      outbox: {
        capacity: 1,
        pending: 0,
        in_flight: 0,
        acknowledged: 2,
      },
    });
  });

  it("atomically initializes, advances, deduplicates, and survives eviction", async () => {
    const unit = crypto.randomUUID();
    const sessionId = `cf:pve:${unit}`;
    const first = fixture(sessionId, "observer-1", 7, "checkpoint-6");
    expect((await configure(
      "pve",
      unit,
      sessionId,
      first.authority_key,
      first.epoch,
      first.previous_digest,
    )).status).toBe(201);

    const initialized = await submit("pve", unit, first);
    expect(initialized.status).toBe(202);
    expect(await initialized.json()).toMatchObject({ decision: "initialized", epoch: 7 });

    const duplicate = await submit("pve", unit, first);
    expect(duplicate.status).toBe(200);
    expect(await duplicate.json()).toMatchObject({ decision: "duplicate" });

    const webSocketResponse = await SELF.fetch(
      `https://example.test/v1/pve/${unit}/ws`,
      { headers: { upgrade: "websocket" } },
    );
    const socket = webSocketResponse.webSocket;
    expect(socket).toBeDefined();
    socket!.accept();
    expect(await nextJsonMessage(socket!)).toMatchObject({
      type: "connected",
      head: { epoch: 7, digest: first.digest },
    });

    await evictAuditShard("pve", unit);
    const second = fixture(sessionId, "observer-1", 8, first.digest);
    const broadcast = nextJsonMessage(socket!);
    const advanced = await submit("pve", unit, second);
    expect(advanced.status).toBe(202);
    expect(await advanced.json()).toMatchObject({ decision: "advance", epoch: 8 });
    expect(await broadcast).toMatchObject({
      type: "anchor_head",
      decision: "advance",
      epoch: 8,
    });
    socket!.close(1000, "done");

    const head = await SELF.fetch(`https://example.test/v1/pve/${unit}/head`);
    expect(await head.json()).toMatchObject({ epoch: 8, digest: second.digest });

    const gap = await SELF.fetch(
      `https://example.test/v1/pve/${unit}/gap?after_epoch=7&after_digest=${first.digest}&target_epoch=8&max_items=1`,
    );
    expect(gap.status).toBe(200);
    expect(await gap.json()).toMatchObject({
      has_more: false,
      envelopes: [second.envelope_hex],
    });

    const third = fixture(sessionId, "observer-1", 9, second.digest);
    const contenders = await Promise.all(
      Array.from({ length: 8 }, () => submit("pve", unit, third)),
    );
    expect(contenders.filter((response) => response.status === 202)).toHaveLength(1);
    expect(contenders.filter((response) => response.status === 200)).toHaveLength(7);
    const contendedHead = await SELF.fetch(
      `https://example.test/v1/pve/${unit}/head`,
    );
    expect(await contendedHead.json()).toMatchObject({
      epoch: 9,
      digest: third.digest,
    });
  }, 15_000);

  it("records forks but never advances the accepted head", async () => {
    const unit = crypto.randomUUID();
    const sessionId = `cf:pvp:${unit}`;
    const accepted = fixture(sessionId, "observer-a", 1, "genesis");
    const conflicting = fixture(sessionId, "observer-b", 1, "genesis");
    await configure(
      "pvp",
      unit,
      sessionId,
      accepted.authority_key,
      accepted.epoch,
      accepted.previous_digest,
    );
    expect((await submit("pvp", unit, accepted)).status).toBe(202);

    const fork = await submit("pvp", unit, conflicting);
    expect(fork.status).toBe(409);
    expect(await fork.json()).toMatchObject({
      decision: "same_epoch_fork",
      replay_queue: "queued",
    });

    const head = await SELF.fetch(`https://example.test/v1/pvp/${unit}/head`);
    expect(await head.json()).toMatchObject({ epoch: 1, digest: accepted.digest });
    const stats = await SELF.fetch(`https://example.test/v1/pvp/${unit}/stats`);
    expect(await stats.json()).toMatchObject({
      forks: 1,
      mode: "pvp",
      replay_outbox: { pending: 0, queued: 1, delivered: 0 },
    });
  });

  it("rejects gaps and unauthorized reconfiguration", async () => {
    const unit = crypto.randomUUID();
    const sessionId = `cf:open:${unit}`;
    const first = fixture(sessionId, "observer-1", 10, "checkpoint-9");
    await configure(
      "open",
      unit,
      sessionId,
      first.authority_key,
      first.epoch,
      first.previous_digest,
    );
    const rolledBack = fixture(sessionId, "observer-1", 9, "checkpoint-8");
    const rollbackRefused = await submit("open", unit, rolledBack);
    expect(rollbackRefused.status).toBe(409);
    expect(await rollbackRefused.json()).toMatchObject({
      decision: "boundary_rejected",
    });
    await submit("open", unit, first);

    const gap = fixture(sessionId, "observer-1", 12, "missing-11");
    const refused = await submit("open", unit, gap);
    expect(refused.status).toBe(409);
    expect(await refused.json()).toMatchObject({ decision: "gap" });

    const unauthorized = await SELF.fetch(
      `https://example.test/v1/open/${unit}/configure`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          session_id: sessionId,
          authority_key: first.authority_key,
          initial_epoch: first.epoch,
          initial_previous_digest: first.previous_digest,
        }),
      },
    );
    expect(unauthorized.status).toBe(401);
  });

  it("queues only mode-allowed central replay reasons and deduplicates retries", async () => {
    const unit = crypto.randomUUID();
    const sessionId = `cf:open:${unit}`;
    const first = fixture(sessionId, "observer-1", 1, "genesis");
    await configure(
      "open",
      unit,
      sessionId,
      first.authority_key,
      first.epoch,
      first.previous_digest,
    );
    expect((await submit("open", unit, first)).status).toBe(202);

    const queued = await requestReplay("open", unit, "marketplace");
    expect(queued.status).toBe(202);
    const queuedBody = await queued.json() as {
      decision: string;
      idempotency_key: string;
    };
    expect(queuedBody).toMatchObject({ decision: "queued" });

    const duplicate = await requestReplay("open", unit, "marketplace");
    expect(duplicate.status).toBe(200);
    expect(await duplicate.json()).toMatchObject({
      decision: "duplicate",
      idempotency_key: queuedBody.idempotency_key,
    });

    const forbiddenReason = await requestReplay("open", unit, "high_value");
    expect(forbiddenReason.status).toBe(400);
    const unauthorized = await SELF.fetch(
      `https://example.test/v1/open/${unit}/replay`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ reason: "challenge" }),
      },
    );
    expect(unauthorized.status).toBe(401);

    const stats = await SELF.fetch(`https://example.test/v1/open/${unit}/stats`);
    expect(await stats.json()).toMatchObject({
      replay_outbox: { pending: 0, queued: 1, delivered: 0 },
    });
  });

  it("deduplicates queue delivery but keeps anchor-only jobs awaiting transcript", async () => {
    const unit = crypto.randomUUID();
    const sessionId = `cf:pvp:${unit}`;
    const first = fixture(sessionId, "observer-a", 1, "genesis");
    await configure(
      "pvp",
      unit,
      sessionId,
      first.authority_key,
      first.epoch,
      first.previous_digest,
    );
    expect((await submit("pvp", unit, first)).status).toBe(202);
    const queued = await requestReplay("pvp", unit, "dispute");
    const queuedBody = await queued.json() as {
      idempotency_key: string;
    };
    const job: ReplayJob = {
      version: 1,
      idempotency_key: queuedBody.idempotency_key,
      mode: "pvp",
      unit,
      reason: "dispute",
      epoch: first.epoch,
      digest: first.digest,
      created_at: 1,
    };

    for (const id of ["delivery-1", "delivery-2"]) {
      const batch = createMessageBatch<ReplayJob>("converge-game-audit-replay", [
        { id, timestamp: new Date(), body: job, attempts: 1 },
      ]);
      const ctx = createExecutionContext();
      await worker.queue!(batch, env as unknown as AuditEnv, ctx);
      const result = await getQueueResult(batch, ctx);
      expect(result.explicitAcks).toStrictEqual([id]);
      expect(result.retryMessages).toStrictEqual([]);
    }

    const stats = await SELF.fetch(`https://example.test/v1/pvp/${unit}/stats`);
    expect(await stats.json()).toMatchObject({
      replay_outbox: { pending: 0, queued: 0, delivered: 1 },
      replay_decisions: {
        awaiting_transcript: 1,
        verified: 0,
        refused: 0,
      },
    });
  });

  it("stores a PvE transcript and verifies its real checkpoint replay in the queue consumer", async () => {
    const unit = crypto.randomUUID();
    const sessionId = `cf:pve:${unit}`;
    const anchor = fixture(sessionId, "observer-pve", 1, "genesis");
    const replay = JSON.parse(
      audit_benchmark_make_pve_replay_bundle(SEED, PLAYER_SEED, sessionId),
    ) as {
      ok: true;
      bundle_hex: string;
      checkpoint_digest: string;
      authority_key: string;
    };
    expect(replay.authority_key).toBe(anchor.authority_key);
    await configure(
      "pve",
      unit,
      sessionId,
      anchor.authority_key,
      anchor.epoch,
      anchor.previous_digest,
    );
    expect((await submit("pve", unit, anchor)).status).toBe(202);

    const queued = await requestReplay("pve", unit, "high_value", {
      bundle_hex: replay.bundle_hex,
      checkpoint_digest: replay.checkpoint_digest,
    });
    expect(queued.status).toBe(202);
    const queuedBody = await queued.json() as { idempotency_key: string };
    const job: ReplayJob = {
      version: 1,
      idempotency_key: queuedBody.idempotency_key,
      mode: "pve",
      unit,
      reason: "high_value",
      epoch: anchor.epoch,
      digest: anchor.digest,
      checkpoint_digest: replay.checkpoint_digest,
      created_at: 1,
    };
    const batch = createMessageBatch<ReplayJob>(
      "converge-game-audit-replay",
      [{ id: "pve-replay-1", timestamp: new Date(), body: job, attempts: 1 }],
    );
    const ctx = createExecutionContext();
    await worker.queue!(batch, env as unknown as AuditEnv, ctx);
    const result = await getQueueResult(batch, ctx);
    expect(result.explicitAcks).toStrictEqual(["pve-replay-1"]);
    expect(result.retryMessages).toStrictEqual([]);

    const stats = await SELF.fetch(`https://example.test/v1/pve/${unit}/stats`);
    const statsBody = await stats.json() as Record<string, unknown>;
    expect(statsBody).toMatchObject({
      replay_outbox: { pending: 0, queued: 0, delivered: 1 },
      replay_decisions: {
        awaiting_transcript: 0,
        verified: 1,
        refused: 0,
      },
      replay_artifacts: { stored: 1, bytes: replay.bundle_hex.length / 2 },
      replay_compute: { count: 1 },
    });
  });

  it("stores a PvP transcript and verifies replay plus witness quorum in the queue consumer", async () => {
    const unit = crypto.randomUUID();
    const sessionId = `cf:pvp:${unit}`;
    const anchor = fixture(sessionId, "observer-pvp", 1, "genesis");
    const replay = JSON.parse(
      audit_benchmark_make_pvp_replay_bundle(SEED, PLAYER_SEED, sessionId),
    ) as {
      ok: true;
      bundle_hex: string;
      checkpoint_digest: string;
      referee_key: string;
      approval_count: number;
    };
    expect(replay.referee_key).toBe(anchor.authority_key);
    expect(replay.approval_count).toBe(3);
    await configure(
      "pvp",
      unit,
      sessionId,
      anchor.authority_key,
      anchor.epoch,
      anchor.previous_digest,
    );
    expect((await submit("pvp", unit, anchor)).status).toBe(202);

    const queued = await requestReplay("pvp", unit, "dispute", {
      bundle_hex: replay.bundle_hex,
      checkpoint_digest: replay.checkpoint_digest,
    });
    expect(queued.status).toBe(202);
    const queuedBody = await queued.json() as { idempotency_key: string };
    const job: ReplayJob = {
      version: 1,
      idempotency_key: queuedBody.idempotency_key,
      mode: "pvp",
      unit,
      reason: "dispute",
      epoch: anchor.epoch,
      digest: anchor.digest,
      checkpoint_digest: replay.checkpoint_digest,
      created_at: 1,
    };
    const batch = createMessageBatch<ReplayJob>(
      "converge-game-audit-replay",
      [{ id: "pvp-replay-1", timestamp: new Date(), body: job, attempts: 1 }],
    );
    const ctx = createExecutionContext();
    await worker.queue!(batch, env as unknown as AuditEnv, ctx);
    const result = await getQueueResult(batch, ctx);
    expect(result.explicitAcks).toStrictEqual(["pvp-replay-1"]);
    expect(result.retryMessages).toStrictEqual([]);

    const stats = await SELF.fetch(`https://example.test/v1/pvp/${unit}/stats`);
    const statsBody = await stats.json() as Record<string, unknown>;
    expect(statsBody).toMatchObject({
      replay_outbox: { pending: 0, queued: 0, delivered: 1 },
      replay_decisions: {
        awaiting_transcript: 0,
        verified: 1,
        refused: 0,
      },
      replay_artifacts: { stored: 1, bytes: replay.bundle_hex.length / 2 },
      replay_compute: { count: 1 },
    });
  });

  it("commits a multi-asset inventory checkpoint atomically", async () => {
    const unit = crypto.randomUUID();
    const worldId = `cf:open:${unit}`;
    const encounterSessionId = `${worldId}:multi-asset-encounter`;
    const anchor = fixture(worldId, "observer-open", 1, "genesis");
    const replay = JSON.parse(
      audit_benchmark_make_open_world_multi_asset_pve_replay_bundle(
        SEED,
        PLAYER_SEED,
        worldId,
        encounterSessionId,
        2,
      ),
    ) as {
      ok: true;
      bundle_hex: string;
      checkpoint_digest: string;
      audit_checkpoint_digest: string;
      seal_checkpoint_digest: string;
      transparency_log_session_id: string;
      transparency_publisher_key: string;
      transparency_checkpoint_digest: string;
      authority_key: string;
      assets: Array<{
        asset_id: string;
        initial_owner_id: string;
        item_type: string;
        quantity: number;
        output_index: number;
        source_event: string;
      }>;
    };
    expect(replay.assets).toHaveLength(2);
    await configure(
      "open",
      unit,
      worldId,
      anchor.authority_key,
      anchor.epoch,
      anchor.previous_digest,
    );
    expect((await submit("open", unit, anchor)).status).toBe(202);
    const queued = await requestReplay("open", unit, "sample", {
      bundle_hex: replay.bundle_hex,
      checkpoint_digest: replay.checkpoint_digest,
      target_session_id: encounterSessionId,
      audit_checkpoint_digest: replay.audit_checkpoint_digest,
      seal_checkpoint_digest: replay.seal_checkpoint_digest,
      transparency_log_session_id: replay.transparency_log_session_id,
      transparency_publisher_key: replay.transparency_publisher_key,
      transparency_checkpoint_digest: replay.transparency_checkpoint_digest,
    });
    expect(queued.status).toBe(202);
    const queuedBody = await queued.json() as { idempotency_key: string };
    const job: ReplayJob = {
      version: 1,
      idempotency_key: queuedBody.idempotency_key,
      mode: "open",
      unit,
      reason: "sample",
      epoch: anchor.epoch,
      digest: anchor.digest,
      checkpoint_digest: replay.checkpoint_digest,
      created_at: 1,
    };
    const batch = createMessageBatch<ReplayJob>(
      "converge-game-audit-replay",
      [{ id: "open-multi-replay", timestamp: new Date(), body: job, attempts: 1 }],
    );
    const ctx = createExecutionContext();
    await worker.queue!(batch, env as unknown as AuditEnv, ctx);
    expect((await getQueueResult(batch, ctx)).explicitAcks).toStrictEqual([
      "open-multi-replay",
    ]);

    const assets = [...replay.assets].sort((left, right) =>
      left.asset_id.localeCompare(right.asset_id)
    );
    const checkpoint = JSON.parse(
      audit_benchmark_make_inventory_checkpoint_proof_bundle(
        SEED,
        PLAYER_SEED,
        encounterSessionId,
        replay.checkpoint_digest,
        1,
        assets.map((asset) => asset.asset_id),
        assets.map((asset) => asset.quantity),
        assets.map((asset) => asset.source_event),
        assets.map((asset) => asset.output_index),
        assets.map((asset) => asset.initial_owner_id),
        assets.map(() => "bob"),
        assets[0].item_type,
      ),
    ) as {
      ok: true;
      bundle_hex: string;
      checkpoint_digest: string;
      game_manifest_digest: string;
    };
    const expectedAssets = assets.map((asset) => ({
      asset_id: asset.asset_id,
      expected_checkpoint_digest: replay.checkpoint_digest,
      expected_version: 0,
    }));
    const commit = (
      idempotencyKey: string,
      requestAssets = expectedAssets,
      faultAfterAssetUpdates?: number,
    ) =>
      SELF.fetch(
        `https://example.test/v1/open/${unit}/inventory-checkpoints`,
        {
          method: "POST",
          headers: {
            authorization: "Bearer test-admin-token",
            "content-type": "application/json",
          },
          body: JSON.stringify({
            idempotency_key: idempotencyKey,
            inventory_bundle_hex: checkpoint.bundle_hex,
            inventory_checkpoint_digest: checkpoint.checkpoint_digest,
            inventory_game_manifest_digest: checkpoint.game_manifest_digest,
            assets: requestAssets,
            fault_after_asset_updates: faultAfterAssetUpdates,
          }),
        },
      );
    const list = (assetId: string, sellerId: string) =>
      SELF.fetch(
        `https://example.test/v1/open/${unit}/market-listing`,
        {
          method: "POST",
          headers: {
            authorization: "Bearer test-admin-token",
            "content-type": "application/json",
          },
          body: JSON.stringify({ asset_id: assetId, seller_id: sellerId }),
        },
      );

    const injected = await commit("multi-fault", expectedAssets, 1);
    expect(injected.status).toBe(500);
    await expect(injected.json()).resolves.toMatchObject({
      decision: "injected_inventory_checkpoint_fault",
    });
    for (const asset of assets) {
      expect((await list(asset.asset_id, asset.initial_owner_id)).status).toBe(200);
    }

    const staleAssets = expectedAssets.map((asset, index) => ({
      ...asset,
      expected_version: index === 1 ? 1 : asset.expected_version,
    }));
    const stale = await commit("multi-stale", staleAssets);
    expect(stale.status).toBe(409);
    await expect(stale.json()).resolves.toMatchObject({
      decision: "inventory_checkpoint_stale",
      asset_id: assets[1].asset_id,
    });

    const decide = (body: Record<string, unknown>) =>
      SELF.fetch(
        `https://example.test/v1/open/${unit}/asset-lineage-decisions`,
        {
          method: "POST",
          headers: {
            authorization: "Bearer test-admin-token",
            "content-type": "application/json",
          },
          body: JSON.stringify(body),
        },
      );
    const atomicRevocation = signedLineageDecision("verified-asset", unit, {
      asset_id: assets[1].asset_id,
      ancestor_id: assets[1].asset_id,
      ancestor_kind: "origin",
      expected_revision: 0,
      outcome: "revoked",
      reason: "atomic batch regression",
    });
    const atomicRevoked = await decide(atomicRevocation);
    expect(atomicRevoked.status).toBe(201);
    const atomicRevokedDecision = await atomicRevoked.json() as {
      decision_id: string;
    };
    const revoked = await commit("multi-revoked");
    expect(revoked.status).toBe(403);
    await expect(revoked.json()).resolves.toMatchObject({
      decision: "inventory_checkpoint_asset_revoked",
      asset_id: assets[1].asset_id,
    });
    expect((await list(assets[0].asset_id, assets[0].initial_owner_id)).status)
      .toBe(200);
    expect((await decide(signedLineageDecision("verified-asset", unit, {
      asset_id: assets[1].asset_id,
      ancestor_id: assets[1].asset_id,
      ancestor_kind: "origin",
      expected_revision: 1,
      outcome: "eligible",
      reason: "atomic batch appeal",
      appeal_of_decision_id: atomicRevokedDecision.decision_id,
    }))).status).toBe(201);

    const contenders = await Promise.all([
      commit("multi-commit-a"),
      commit("multi-commit-b"),
    ]);
    expect(contenders.map((response) => response.status).sort()).toStrictEqual([
      201,
      409,
    ]);
    const committedIndex = contenders.findIndex((response) =>
      response.status === 201
    );
    const committedKey = committedIndex === 0
      ? "multi-commit-a"
      : "multi-commit-b";
    await expect(contenders[committedIndex].json()).resolves.toMatchObject({
      decision: "committed",
      asset_count: 2,
      checkpoint_digest: checkpoint.checkpoint_digest,
    });
    expect((await commit(committedKey)).status).toBe(200);
    const conflict = await commit(committedKey, staleAssets);
    expect(conflict.status).toBe(409);
    await expect(conflict.json()).resolves.toMatchObject({
      decision: "inventory_checkpoint_idempotency_conflict",
    });
    for (const asset of assets) {
      expect((await list(asset.asset_id, "bob")).status).toBe(200);
    }
  });

  it("stores an open-world sample and verifies plan seal observers eligibility and replay", async () => {
    const unit = crypto.randomUUID();
    const worldId = `cf:open:${unit}`;
    const encounterSessionId = `${worldId}:encounter-0`;
    const anchor = fixture(worldId, "observer-open", 1, "genesis");
    const replay = JSON.parse(
      audit_benchmark_make_open_world_pve_replay_bundle(
        SEED,
        PLAYER_SEED,
        worldId,
        encounterSessionId,
      ),
    ) as {
      ok: true;
      bundle_hex: string;
      checkpoint_digest: string;
      asset_id: string;
      item_type: string;
      quantity: number;
      output_index: number;
      source_event: string;
      audit_checkpoint_digest: string;
      seal_checkpoint_digest: string;
      transparency_log_session_id: string;
      transparency_publisher_key: string;
      transparency_checkpoint_digest: string;
      authority_key: string;
      observer_approvals: number;
    };
    expect(replay.authority_key).toBe(anchor.authority_key);
    expect(replay.observer_approvals).toBe(3);
    await configure(
      "open",
      unit,
      worldId,
      anchor.authority_key,
      anchor.epoch,
      anchor.previous_digest,
    );
    expect((await submit("open", unit, anchor)).status).toBe(202);

    const missingTransparency = await requestReplay("open", unit, "sample", {
      bundle_hex: replay.bundle_hex,
      checkpoint_digest: replay.checkpoint_digest,
      target_session_id: encounterSessionId,
      audit_checkpoint_digest: replay.audit_checkpoint_digest,
      seal_checkpoint_digest: replay.seal_checkpoint_digest,
    });
    expect(missingTransparency.status).toBe(400);
    await expect(missingTransparency.json()).resolves.toMatchObject({
      error: "invalid_replay_artifact",
    });

    const queued = await requestReplay("open", unit, "sample", {
      bundle_hex: replay.bundle_hex,
      checkpoint_digest: replay.checkpoint_digest,
      target_session_id: encounterSessionId,
      audit_checkpoint_digest: replay.audit_checkpoint_digest,
      seal_checkpoint_digest: replay.seal_checkpoint_digest,
      transparency_log_session_id: replay.transparency_log_session_id,
      transparency_publisher_key: replay.transparency_publisher_key,
      transparency_checkpoint_digest: replay.transparency_checkpoint_digest,
    });
    expect(queued.status).toBe(202);
    const queuedBody = await queued.json() as { idempotency_key: string };
    const job: ReplayJob = {
      version: 1,
      idempotency_key: queuedBody.idempotency_key,
      mode: "open",
      unit,
      reason: "sample",
      epoch: anchor.epoch,
      digest: anchor.digest,
      checkpoint_digest: replay.checkpoint_digest,
      created_at: 1,
    };
    const batch = createMessageBatch<ReplayJob>(
      "converge-game-audit-replay",
      [{ id: "open-replay-1", timestamp: new Date(), body: job, attempts: 1 }],
    );
    const ctx = createExecutionContext();
    await worker.queue!(batch, env as unknown as AuditEnv, ctx);
    const result = await getQueueResult(batch, ctx);
    expect(result.explicitAcks).toStrictEqual(["open-replay-1"]);
    expect(result.retryMessages).toStrictEqual([]);

    const unauthenticatedListing = await SELF.fetch(
      `https://example.test/v1/open/${unit}/market-listing`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ asset_id: replay.asset_id, seller_id: "alice" }),
      },
    );
    expect(unauthenticatedListing.status).toBe(401);

    const wrongSeller = await SELF.fetch(
      `https://example.test/v1/open/${unit}/market-listing`,
      {
        method: "POST",
        headers: {
          authorization: "Bearer test-admin-token",
          "content-type": "application/json",
        },
        body: JSON.stringify({ asset_id: replay.asset_id, seller_id: "mallory" }),
      },
    );
    expect(wrongSeller.status).toBe(403);
    await expect(wrongSeller.json()).resolves.toMatchObject({
      allowed: false,
      decision: "seller_mismatch",
    });

    const validListing = await SELF.fetch(
      `https://example.test/v1/open/${unit}/market-listing`,
      {
        method: "POST",
        headers: {
          authorization: "Bearer test-admin-token",
          "content-type": "application/json",
        },
        body: JSON.stringify({ asset_id: replay.asset_id, seller_id: "alice" }),
      },
    );
    expect(validListing.status).toBe(200);
    await expect(validListing.json()).resolves.toMatchObject({
      allowed: true,
      decision: "eligible_current_owner",
      asset_id: replay.asset_id,
      seller_id: "alice",
      checkpoint_digest: replay.checkpoint_digest,
      current_version: 0,
    });

    const inventory = JSON.parse(
      audit_benchmark_make_inventory_listing_proof_bundle(
        SEED,
        PLAYER_SEED,
        encounterSessionId,
        replay.checkpoint_digest,
        1,
        replay.asset_id,
        "alice",
        "bob",
        replay.item_type,
        replay.quantity,
        replay.source_event,
        replay.output_index,
        1,
      ),
    ) as {
      ok: true;
      bundle_hex: string;
      checkpoint_digest: string;
      game_manifest_digest: string;
    };
    const transferredListing = await SELF.fetch(
      `https://example.test/v1/open/${unit}/market-listing`,
      {
        method: "POST",
        headers: {
          authorization: "Bearer test-admin-token",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          asset_id: replay.asset_id,
          seller_id: "bob",
          inventory_bundle_hex: inventory.bundle_hex,
          inventory_checkpoint_digest: inventory.checkpoint_digest,
          inventory_game_manifest_digest: inventory.game_manifest_digest,
        }),
      },
    );
    expect(transferredListing.status).toBe(200);
    await expect(transferredListing.json()).resolves.toMatchObject({
      allowed: true,
      decision: "eligible_current_owner",
      asset_id: replay.asset_id,
      seller_id: "bob",
      checkpoint_digest: inventory.checkpoint_digest,
      previous_checkpoint: replay.checkpoint_digest,
      current_version: 1,
    });

    const lineage = JSON.parse(
      audit_benchmark_make_inventory_lineage_proof_bundle(
        SEED,
        PLAYER_SEED,
        encounterSessionId,
        replay.checkpoint_digest,
        1,
        replay.asset_id,
        "alice",
        "bob",
        replay.item_type,
        replay.quantity,
        replay.source_event,
        replay.output_index,
        1,
      ),
    ) as {
      ok: true;
      bundle_hex: string;
      checkpoint_digest: string;
      game_manifest_digest: string;
      anchor_owner_id: string;
      anchor_version: number;
      anchor_last_event: string;
      anchor_lineage_root: string;
    };
    const registerLineage = (bundleHex = lineage.bundle_hex) =>
      SELF.fetch(
        `https://example.test/v1/open/${unit}/asset-lineage-proofs`,
        {
          method: "POST",
          headers: {
            authorization: "Bearer test-admin-token",
            "content-type": "application/json",
          },
          body: JSON.stringify({
            asset_id: replay.asset_id,
            seller_id: "bob",
            lineage_bundle_hex: bundleHex,
            inventory_checkpoint_digest: lineage.checkpoint_digest,
            inventory_game_manifest_digest: lineage.game_manifest_digest,
            anchor_owner_id: lineage.anchor_owner_id,
            anchor_version: lineage.anchor_version,
            anchor_last_event: lineage.anchor_last_event,
            anchor_lineage_root: lineage.anchor_lineage_root,
          }),
        },
      );
    const tamperedLineageHex = lineage.bundle_hex.slice(0, -1) +
      (lineage.bundle_hex.endsWith("0") ? "1" : "0");
    const tamperedLineage = await registerLineage(tamperedLineageHex);
    expect(tamperedLineage.status).toBe(403);
    await expect(tamperedLineage.json()).resolves.toMatchObject({
      decision: "lineage_proof_refused",
    });
    const registeredLineage = await registerLineage();
    expect(registeredLineage.status).toBe(201);
    const registeredLineageBody = await registeredLineage.json() as {
      decision: string;
      transfer_count: number;
      transitions: Array<{ source_event: string; previous_event: string }>;
    };
    expect(registeredLineageBody).toMatchObject({
      decision: "registered",
      transfer_count: 1,
    });
    const transferEvent = registeredLineageBody.transitions[0]?.source_event;
    expect(transferEvent).toMatch(/^[0-9a-f]{64}$/);
    expect((await registerLineage()).status).toBe(200);

    const decideLineage = (
      decision: Record<string, unknown>,
      authenticated = true,
    ) =>
      SELF.fetch(
        `https://example.test/v1/open/${unit}/asset-lineage-decisions`,
        {
          method: "POST",
          headers: {
            ...(authenticated
              ? { authorization: "Bearer test-admin-token" }
              : {}),
            "content-type": "application/json",
          },
          body: JSON.stringify(decision),
        },
      );
    const originRevocation = signedLineageDecision("verified-asset", unit, {
      asset_id: replay.asset_id,
      ancestor_id: replay.asset_id,
      ancestor_kind: "origin",
      expected_revision: 0,
      outcome: "revoked",
      reason: "sample replay appealed",
    });
    const transferRevocation = await decideLineage(signedLineageDecision(
      "verified-asset",
      unit,
      {
      asset_id: replay.asset_id,
      ancestor_id: transferEvent,
      ancestor_kind: "transfer",
      expected_revision: 0,
      outcome: "revoked",
      reason: "historical transfer disputed",
      },
    ));
    expect(transferRevocation.status).toBe(201);
    const transferRevocationBody = await transferRevocation.json() as {
      decision_id: string;
    };
    expect(transferRevocationBody).toMatchObject({
      ancestor_id: transferEvent,
      ancestor_kind: "transfer",
      lineage_status: "revoked",
      open_revocations: 1,
    });
    const blockedByTransfer = await SELF.fetch(
      `https://example.test/v1/open/${unit}/market-listing`,
      {
        method: "POST",
        headers: {
          authorization: "Bearer test-admin-token",
          "content-type": "application/json",
        },
        body: JSON.stringify({ asset_id: replay.asset_id, seller_id: "bob" }),
      },
    );
    expect(blockedByTransfer.status).toBe(403);
    await expect(blockedByTransfer.json()).resolves.toMatchObject({
      decision: "asset_lineage_revoked",
      open_revocations: 1,
    });
    const appealedTransfer = await decideLineage(signedLineageDecision(
      "verified-asset",
      unit,
      {
      asset_id: replay.asset_id,
      ancestor_id: transferEvent,
      ancestor_kind: "transfer",
      expected_revision: 1,
      outcome: "eligible",
      reason: "historical transfer proof accepted",
      appeal_of_decision_id: transferRevocationBody.decision_id,
      },
    ));
    expect(appealedTransfer.status).toBe(201);
    await expect(appealedTransfer.json()).resolves.toMatchObject({
      ancestor_kind: "transfer",
      lineage_status: "eligible",
      open_revocations: 0,
    });
    expect((await decideLineage(originRevocation, false)).status).toBe(401);
    const oldHead = await decideLineage(signedLineageDecision(
      "verified-asset",
      unit,
      {
      asset_id: replay.asset_id,
      ancestor_id: replay.checkpoint_digest,
      ancestor_kind: "current_head",
      expected_revision: 0,
      outcome: "revoked",
      reason: "unproven historical head",
      },
    ));
    expect(oldHead.status).toBe(409);
    await expect(oldHead.json()).resolves.toMatchObject({
      decision: "ancestor_not_in_lineage",
      asset_id: replay.asset_id,
      ancestor_id: replay.checkpoint_digest,
    });

    const revokedOrigin = await decideLineage(originRevocation);
    expect(revokedOrigin.status).toBe(201);
    const revokedOriginBody = await revokedOrigin.json() as Record<
      string,
      unknown
    >;
    expect(revokedOriginBody).toMatchObject({
      decision: "applied",
      asset_id: replay.asset_id,
      ancestor_id: replay.asset_id,
      ancestor_kind: "origin",
      revision: 1,
      lineage_status: "revoked",
      open_revocations: 1,
    });
    expect((await decideLineage(originRevocation)).status).toBe(200);

    const blockedByOrigin = await SELF.fetch(
      `https://example.test/v1/open/${unit}/market-listing`,
      {
        method: "POST",
        headers: {
          authorization: "Bearer test-admin-token",
          "content-type": "application/json",
        },
        body: JSON.stringify({ asset_id: replay.asset_id, seller_id: "bob" }),
      },
    );
    expect(blockedByOrigin.status).toBe(403);
    await expect(blockedByOrigin.json()).resolves.toMatchObject({
      allowed: false,
      decision: "asset_lineage_revoked",
      open_revocations: 1,
    });

    const revokedHead = await decideLineage(signedLineageDecision(
      "verified-asset",
      unit,
      {
      asset_id: replay.asset_id,
      ancestor_id: inventory.checkpoint_digest,
      ancestor_kind: "current_head",
      expected_revision: 0,
      outcome: "revoked",
      reason: "current owner checkpoint disputed",
      },
    ));
    expect(revokedHead.status).toBe(201);
    const revokedHeadBody = await revokedHead.json() as {
      decision_id: string;
    };
    expect(revokedHeadBody).toMatchObject({
      ancestor_kind: "current_head",
      revision: 1,
      lineage_status: "revoked",
      open_revocations: 2,
    });

    const appealedOrigin = await decideLineage(signedLineageDecision(
      "verified-asset",
      unit,
      {
      asset_id: replay.asset_id,
      ancestor_id: replay.asset_id,
      ancestor_kind: "origin",
      expected_revision: 1,
      outcome: "eligible",
      reason: "origin appeal accepted",
      appeal_of_decision_id: String(revokedOriginBody.decision_id),
      },
    ));
    expect(appealedOrigin.status).toBe(201);
    await expect(appealedOrigin.json()).resolves.toMatchObject({
      lineage_status: "eligible",
      open_revocations: 1,
    });
    const stillBlocked = await SELF.fetch(
      `https://example.test/v1/open/${unit}/market-listing`,
      {
        method: "POST",
        headers: {
          authorization: "Bearer test-admin-token",
          "content-type": "application/json",
        },
        body: JSON.stringify({ asset_id: replay.asset_id, seller_id: "bob" }),
      },
    );
    expect(stillBlocked.status).toBe(403);
    await expect(stillBlocked.json()).resolves.toMatchObject({
      decision: "asset_lineage_revoked",
      open_revocations: 1,
    });

    const appealedHead = await decideLineage(signedLineageDecision(
      "verified-asset",
      unit,
      {
      asset_id: replay.asset_id,
      ancestor_id: inventory.checkpoint_digest,
      ancestor_kind: "current_head",
      expected_revision: 1,
      outcome: "eligible",
      reason: "current head appeal accepted",
      appeal_of_decision_id: revokedHeadBody.decision_id,
      },
    ));
    expect(appealedHead.status).toBe(201);
    await expect(appealedHead.json()).resolves.toMatchObject({
      lineage_status: "eligible",
      open_revocations: 0,
    });
    const listingAfterAppeal = await SELF.fetch(
      `https://example.test/v1/open/${unit}/market-listing`,
      {
        method: "POST",
        headers: {
          authorization: "Bearer test-admin-token",
          "content-type": "application/json",
        },
        body: JSON.stringify({ asset_id: replay.asset_id, seller_id: "bob" }),
      },
    );
    expect(listingAfterAppeal.status).toBe(200);
    await expect(listingAfterAppeal.json()).resolves.toMatchObject({
      allowed: true,
      decision: "eligible_current_owner",
      open_revocations: 0,
    });
    const staleOriginDecision = await decideLineage(signedLineageDecision(
      "verified-asset",
      unit,
      {
      asset_id: replay.asset_id,
      ancestor_id: replay.asset_id,
      ancestor_kind: "origin",
      expected_revision: 0,
      outcome: "revoked",
      reason: "stale revision replay",
      },
    ));
    expect(staleOriginDecision.status).toBe(409);
    await expect(staleOriginDecision.json()).resolves.toMatchObject({
      decision: "stale_lineage_revision",
      current_revision: 2,
      current_status: "eligible",
    });

    const wrongParent = JSON.parse(
      audit_benchmark_make_inventory_listing_proof_bundle(
        SEED,
        PLAYER_SEED,
        encounterSessionId,
        replay.checkpoint_digest,
        2,
        replay.asset_id,
        "alice",
        "carol",
        replay.item_type,
        replay.quantity,
        replay.source_event,
        replay.output_index,
        2,
      ),
    ) as typeof inventory;
    const forkedListing = await SELF.fetch(
      `https://example.test/v1/open/${unit}/market-listing`,
      {
        method: "POST",
        headers: {
          authorization: "Bearer test-admin-token",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          asset_id: replay.asset_id,
          seller_id: "carol",
          inventory_bundle_hex: wrongParent.bundle_hex,
          inventory_checkpoint_digest: wrongParent.checkpoint_digest,
          inventory_game_manifest_digest: wrongParent.game_manifest_digest,
        }),
      },
    );
    expect(forkedListing.status).toBe(409);
    await expect(forkedListing.json()).resolves.toMatchObject({
      allowed: false,
      decision: "inventory_stale_or_wrong_parent",
      current_checkpoint: inventory.checkpoint_digest,
      submitted_previous_checkpoint: replay.checkpoint_digest,
    });

    const regressingVersion = JSON.parse(
      audit_benchmark_make_inventory_listing_proof_bundle(
        SEED,
        PLAYER_SEED,
        encounterSessionId,
        inventory.checkpoint_digest,
        2,
        replay.asset_id,
        "alice",
        "carol",
        replay.item_type,
        replay.quantity,
        replay.source_event,
        replay.output_index,
        0,
      ),
    ) as typeof inventory;
    const regressingListing = await SELF.fetch(
      `https://example.test/v1/open/${unit}/market-listing`,
      {
        method: "POST",
        headers: {
          authorization: "Bearer test-admin-token",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          asset_id: replay.asset_id,
          seller_id: "carol",
          inventory_bundle_hex: regressingVersion.bundle_hex,
          inventory_checkpoint_digest: regressingVersion.checkpoint_digest,
          inventory_game_manifest_digest: regressingVersion.game_manifest_digest,
        }),
      },
    );
    expect(regressingListing.status).toBe(409);
    await expect(regressingListing.json()).resolves.toMatchObject({
      allowed: false,
      decision: "inventory_stale_or_wrong_parent",
      current_checkpoint: inventory.checkpoint_digest,
      submitted_previous_checkpoint: inventory.checkpoint_digest,
    });

    const staleOwner = await SELF.fetch(
      `https://example.test/v1/open/${unit}/market-listing`,
      {
        method: "POST",
        headers: {
          authorization: "Bearer test-admin-token",
          "content-type": "application/json",
        },
        body: JSON.stringify({ asset_id: replay.asset_id, seller_id: "alice" }),
      },
    );
    expect(staleOwner.status).toBe(403);
    await expect(staleOwner.json()).resolves.toMatchObject({
      allowed: false,
      decision: "seller_mismatch",
    });

    const stats = await SELF.fetch(`https://example.test/v1/open/${unit}/stats`);
    expect(await stats.json()).toMatchObject({
      replay_outbox: { pending: 0, queued: 0, delivered: 1 },
      replay_decisions: {
        awaiting_transcript: 0,
        verified: 1,
        refused: 0,
      },
      replay_artifacts: { stored: 1, bytes: replay.bundle_hex.length / 2 },
      replay_compute: { count: 1 },
      verified_item_creations: { eligible: 1, revoked: 0 },
      verified_asset_lineages: { eligible: 1, revoked: 0 },
    });
  });

  it("retries a queue job whose idempotency key contradicts its fields", async () => {
    const invalid: ReplayJob = {
      version: 1,
      idempotency_key: "replay-v1:tampered",
      mode: "open",
      unit: "encounter-1",
      reason: "sample",
      epoch: 1,
      digest: "00".repeat(32),
      created_at: 1,
    };
    const batch = createMessageBatch<ReplayJob>(
      "converge-game-audit-replay",
      [{ id: "invalid-1", timestamp: new Date(), body: invalid, attempts: 1 }],
    );
    const ctx = createExecutionContext();
    await worker.queue!(batch, env as unknown as AuditEnv, ctx);
    const result = await getQueueResult(batch, ctx);
    expect(result.explicitAcks).toStrictEqual([]);
    expect(result.retryMessages).toMatchObject([{ msgId: "invalid-1" }]);
  });
});
