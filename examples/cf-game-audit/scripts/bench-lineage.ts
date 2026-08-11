import { summarizeLatency } from "../src/benchmark-metrics";
import { verifyInventoryLineageAuthenticationTranscript } from "../src/inventory-lineage-proof";
import { verifyInventoryLineageSemantics } from "../src/inventory-lineage-semantics";
import { verifyInventoryCheckpointCertificateAuthentication } from "../src/inventory-checkpoint-certificate";
import {
  createStandardWebCryptoBackend,
} from "../../player-local-runtime/crypto-backend";
import type { VerifiedInventoryLineage } from "../src/moonbit";

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

function verify(fixture: LineageFixture): VerifiedInventoryLineage {
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
  ) as VerifiedInventoryLineage | { ok: false; error?: string };
  if (!result.ok) throw new Error(result.error ?? "lineage verification failed");
  return result;
}

const standardBackend = createStandardWebCryptoBackend(crypto);
const results = [];
for (const length of LENGTHS) {
  const fixture = generate(length);
  const warmVerification = verify(fixture);
  const warmStandard = await verifyInventoryLineageAuthenticationTranscript(
    warmVerification,
    standardBackend,
  );
  if (!warmStandard.ok) throw new Error(warmStandard.reason);
  const warmCheckpoint =
    await verifyInventoryCheckpointCertificateAuthentication(
      warmVerification.checkpoint_authentication,
      standardBackend,
    );
  if (!warmCheckpoint.ok) throw new Error(warmCheckpoint.reason);
  const warmSemantics = await verifyInventoryLineageSemantics(
    warmVerification,
    standardBackend,
  );
  if (!warmSemantics.ok) throw new Error(warmSemantics.reason);
  const generation: number[] = [];
  const verification: number[] = [];
  const standardAuthentication: number[] = [];
  const standardCheckpointAuthentication: number[] = [];
  const standardSemanticRoots: number[] = [];
  const standardTotalAuthentication: number[] = [];
  for (let index = 0; index < ITERATIONS; index++) {
    let started = performance.now();
    const generated = generate(length);
    generation.push(performance.now() - started);
    started = performance.now();
    const verified = verify(generated);
    verification.push(performance.now() - started);
    const standardStarted = performance.now();
    started = performance.now();
    const standardCheckpoint =
      await verifyInventoryCheckpointCertificateAuthentication(
        verified.checkpoint_authentication,
        standardBackend,
      );
    standardCheckpointAuthentication.push(performance.now() - started);
    if (!standardCheckpoint.ok) throw new Error(standardCheckpoint.reason);
    started = performance.now();
    const standard = await verifyInventoryLineageAuthenticationTranscript(
      verified,
      standardBackend,
    );
    standardAuthentication.push(performance.now() - started);
    if (!standard.ok) throw new Error(standard.reason);
    started = performance.now();
    const semantics = await verifyInventoryLineageSemantics(
      verified,
      standardBackend,
    );
    standardSemanticRoots.push(performance.now() - started);
    standardTotalAuthentication.push(performance.now() - standardStarted);
    if (!semantics.ok) throw new Error(semantics.reason);
  }
  results.push({
    transfer_count: length,
    bundle_bytes: fixture.bundle_bytes,
    bytes_per_transfer: Math.round(
      (fixture.bundle_bytes / length) * 1_000,
    ) / 1_000,
    generation_ms: summarizeLatency(generation),
    verification_ms: summarizeLatency(verification),
    standard_authentication_ms: summarizeLatency(standardAuthentication),
    standard_checkpoint_certificate_ms: summarizeLatency(
      standardCheckpointAuthentication,
    ),
    standard_semantic_roots_ms: summarizeLatency(standardSemanticRoots),
    standard_total_verification_ms: summarizeLatency(
      standardTotalAuthentication,
    ),
  });
}

console.log(JSON.stringify({ iterations: ITERATIONS, results }, null, 2));
