import { summarizeLatency } from "../src/benchmark-metrics";

type AuditModule = typeof import("../../../_build/js/release/build/x/game_audit/worker/worker.js");

const audit = await import(
  new URL(
    "../../../_build/js/release/build/x/game_audit/worker/worker.js",
    import.meta.url,
  ).href
) as AuditModule;

const SEED =
  "000102030405060708090a0b0c0d0e0f" +
  "101112131415161718191a1b1c1d1e1f";
const PLAYER_SEED =
  "202122232425262728292a2b2c2d2e2f" +
  "303132333435363738393a3b3c3d3e3f";
const ITERATIONS = Number(process.env.AUDIT_LINEAGE_BENCH_ITERATIONS ?? 20);
const LENGTHS = [1, 8, 32, 64];

interface LineageFixture {
  ok: true;
  bundle_hex: string;
  bundle_bytes: number;
  authority_key: string;
  checkpoint_digest: string;
  game_manifest_digest: string;
  anchor_owner_id: string;
  anchor_version: number;
  anchor_last_event: string;
  anchor_lineage_root: string;
}

function generate(length: number): LineageFixture {
  const fixture = JSON.parse(
    audit.audit_benchmark_make_inventory_lineage_proof_bundle(
      SEED,
      PLAYER_SEED,
      "lineage-benchmark-session",
      "creation-checkpoint",
      1,
      "asset-1",
      "alice",
      "bob",
      "raid-token",
      1,
      "loot-event",
      0,
      length,
    ),
  ) as LineageFixture | { ok: false; error: string };
  if (!fixture.ok) throw new Error(fixture.error);
  return fixture;
}

function verify(fixture: LineageFixture): void {
  const result = JSON.parse(
    audit.audit_verify_inventory_lineage_proof_bundle(
      fixture.bundle_hex,
      "lineage-benchmark-session",
      fixture.authority_key,
      fixture.checkpoint_digest,
      fixture.game_manifest_digest,
      "asset-1",
      "alice",
      "raid-token",
      1,
      "loot-event",
      0,
      "bob",
      fixture.anchor_owner_id,
      fixture.anchor_version,
      fixture.anchor_last_event,
      fixture.anchor_lineage_root,
    ),
  ) as { ok: boolean; error?: string };
  if (!result.ok) throw new Error(result.error ?? "lineage verification failed");
}

const results = [];
for (const length of LENGTHS) {
  const fixture = generate(length);
  verify(fixture);
  const generation: number[] = [];
  const verification: number[] = [];
  for (let index = 0; index < ITERATIONS; index++) {
    let started = performance.now();
    const generated = generate(length);
    generation.push(performance.now() - started);
    started = performance.now();
    verify(generated);
    verification.push(performance.now() - started);
  }
  results.push({
    transfer_count: length,
    bundle_bytes: fixture.bundle_bytes,
    bytes_per_transfer: Math.round(
      (fixture.bundle_bytes / length) * 1_000,
    ) / 1_000,
    generation_ms: summarizeLatency(generation),
    verification_ms: summarizeLatency(verification),
  });
}

console.log(JSON.stringify({ iterations: ITERATIONS, results }, null, 2));
