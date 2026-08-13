import { env } from "cloudflare:workers";
import {
  SELF,
  createExecutionContext,
  createMessageBatch,
  getQueueResult,
} from "cloudflare:test";
import { expect, it } from "vitest";
import {
  audit_benchmark_make_anchor_envelope,
  audit_benchmark_make_inventory_checkpoint_proof_bundle,
  audit_benchmark_make_open_world_multi_asset_pve_replay_bundle,
} from "../../../_build/js/release/build/x/game_audit/worker_fixture/worker_fixture.js";
import worker, {
  type Env as AuditEnv,
  type ReplayJob,
} from "../src/index";
import { summarizeLatency } from "../src/benchmark-metrics";

const SEED =
  "000102030405060708090a0b0c0d0e0f" +
  "101112131415161718191a1b1c1d1e1f";
const PLAYER_SEED =
  "202122232425262728292a2b2c2d2e2f" +
  "303132333435363738393a3b3c3d3e3f";
const LENGTHS = [1, 8, 32, 64];
const ITERATIONS = Number(
  process.env.AUDIT_INVENTORY_CHECKPOINT_BENCH_ITERATIONS ?? 3,
);

interface AnchorFixture {
  ok: true;
  envelope_hex: string;
  authority_key: string;
  digest: string;
  previous_digest: string;
  epoch: number;
}

interface ReplayAsset {
  asset_id: string;
  initial_owner_id: string;
  item_type: string;
  quantity: number;
  output_index: number;
  source_event: string;
}

interface ReplayFixture {
  ok: true;
  bundle_hex: string;
  checkpoint_digest: string;
  audit_checkpoint_digest: string;
  seal_checkpoint_digest: string;
  transparency_log_session_id: string;
  transparency_publisher_key: string;
  transparency_checkpoint_digest: string;
  authority_key: string;
  assets: ReplayAsset[];
}

interface InventoryCheckpointFixture {
  ok: true;
  bundle_hex: string;
  bundle_bytes: number;
  checkpoint_digest: string;
  game_manifest_digest: string;
}

interface CommitMetrics {
  verification_ms: number;
  standard_verification_ms: number;
  sqlite_ms: number;
}

async function benchmarkOnce(assetCount: number, iteration: number) {
  const unit = `inventory-checkpoint-bench-${assetCount}-${iteration}-${crypto.randomUUID()}`;
  const worldId = `cf:open:inventory-checkpoint-bench-${assetCount}`;
  const encounterSessionId = `${worldId}:encounter`;
  const anchor = JSON.parse(
    audit_benchmark_make_anchor_envelope(
      SEED,
      worldId,
      "observer-open",
      1,
      "genesis",
    ),
  ) as AnchorFixture;
  const replay = JSON.parse(
    audit_benchmark_make_open_world_multi_asset_pve_replay_bundle(
      SEED,
      PLAYER_SEED,
      worldId,
      encounterSessionId,
      assetCount,
    ),
  ) as ReplayFixture;
  expect(replay.assets).toHaveLength(assetCount);
  const headers = {
    authorization: "Bearer test-admin-token",
    "content-type": "application/json",
  };
  expect((await SELF.fetch(`https://example.test/v1/open/${unit}/configure`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      session_id: worldId,
      authority_key: anchor.authority_key,
      initial_epoch: anchor.epoch,
      initial_previous_digest: anchor.previous_digest,
    }),
  })).status).toBe(201);
  expect((await SELF.fetch(`https://example.test/v1/open/${unit}/anchors`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ envelope_hex: anchor.envelope_hex }),
  })).status).toBe(202);
  const queued = await SELF.fetch(`https://example.test/v1/open/${unit}/replay`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      reason: "sample",
      bundle_hex: replay.bundle_hex,
      checkpoint_digest: replay.checkpoint_digest,
      target_session_id: encounterSessionId,
      audit_checkpoint_digest: replay.audit_checkpoint_digest,
      seal_checkpoint_digest: replay.seal_checkpoint_digest,
      transparency_log_session_id: replay.transparency_log_session_id,
      transparency_publisher_key: replay.transparency_publisher_key,
      transparency_checkpoint_digest: replay.transparency_checkpoint_digest,
    }),
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
    [{ id: `replay-${assetCount}-${iteration}`, timestamp: new Date(), body: job, attempts: 1 }],
  );
  const context = createExecutionContext();
  await worker.queue!(batch, env as unknown as AuditEnv, context);
  expect((await getQueueResult(batch, context)).explicitAcks).toHaveLength(1);

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
      assets.map(() => "market-owner"),
      assets[0].item_type,
    ),
  ) as InventoryCheckpointFixture;
  const started = performance.now();
  const response = await SELF.fetch(
    `https://example.test/v1/open/${unit}/inventory-checkpoints`,
    {
      method: "POST",
      headers,
      body: JSON.stringify({
        idempotency_key: `bench-${assetCount}-${iteration}`,
        inventory_bundle_hex: checkpoint.bundle_hex,
        inventory_checkpoint_digest: checkpoint.checkpoint_digest,
        inventory_game_manifest_digest: checkpoint.game_manifest_digest,
        assets: assets.map((asset) => ({
          asset_id: asset.asset_id,
          expected_checkpoint_digest: replay.checkpoint_digest,
          expected_version: 0,
        })),
      }),
    },
  );
  const endToEndMs = performance.now() - started;
  expect(response.status).toBe(201);
  const metrics = await response.json() as CommitMetrics;
  return {
    bundleBytes: checkpoint.bundle_bytes,
    verificationMs: metrics.verification_ms,
    standardVerificationMs: metrics.standard_verification_ms,
    sqliteMs: metrics.sqlite_ms,
    endToEndMs,
  };
}

it("benchmarks atomic inventory checkpoints", async () => {
  const results = [];
  for (const assetCount of LENGTHS) {
    const verification: number[] = [];
    const standardVerification: number[] = [];
    const sqlite: number[] = [];
    const endToEnd: number[] = [];
    let bundleBytes = 0;
    for (let iteration = 0; iteration < ITERATIONS; iteration++) {
      const result = await benchmarkOnce(assetCount, iteration);
      bundleBytes = result.bundleBytes;
      verification.push(result.verificationMs);
      standardVerification.push(result.standardVerificationMs);
      sqlite.push(result.sqliteMs);
      endToEnd.push(result.endToEndMs);
    }
    results.push({
      asset_count: assetCount,
      bundle_bytes: bundleBytes,
      verification_ms: summarizeLatency(verification),
      standard_verification_ms: summarizeLatency(standardVerification),
      sqlite_ms: summarizeLatency(sqlite),
      end_to_end_ms: summarizeLatency(endToEnd),
    });
  }
  console.log(JSON.stringify({ iterations: ITERATIONS, results }, null, 2));
});
