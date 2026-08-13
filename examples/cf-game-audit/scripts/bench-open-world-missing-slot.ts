import { summarizeLatency } from "../src/benchmark-metrics";
import { createStandardWebCryptoBackend } from "../../player-local-runtime/crypto-backend";
import {
  type OpenWorldMissingSlotTranscript,
  verifyOpenWorldMissingSlotSemantics,
} from "../src/open-world-missing-slot-semantics";
import {
  openWorldEncounterRegistrationKey,
  verifyOpenWorldMissingSlotProof,
} from "../src/moonbit";

type AuditModule = typeof import("../../../_build/js/release/build/x/game_audit/worker/worker.js");

const audit = await import(
  new URL(
    "../../../_build/js/release/build/x/game_audit/worker/worker.js",
    import.meta.url,
  ).href
) as AuditModule;

interface MissingSlotFixture {
  ok: true;
  expected_root: string;
  registered_count: number;
  registration_index: number;
  proof_entry_count: number;
  directions: Array<"left" | "right">;
  parent_keys: string[];
  parent_values: string[];
  sibling_digests: string[];
}

const ITERATIONS = Number(
  process.env.AUDIT_MISSING_SLOT_BENCH_ITERATIONS ?? 1_000,
);
const REGISTERED_COUNT = Number(
  process.env.AUDIT_MISSING_SLOT_BENCH_REGISTERED_COUNT ?? 10_000,
);
const REGISTRATION_INDEX = Number(
  process.env.AUDIT_MISSING_SLOT_BENCH_INDEX ?? 7_777,
);

const fixtureStarted = performance.now();
const decodedFixture = JSON.parse(
  audit.audit_benchmark_make_open_world_missing_slot_proof(
    REGISTERED_COUNT,
    REGISTRATION_INDEX,
  ),
) as MissingSlotFixture | { ok: false; error: string };
const fixtureGenerationMs = performance.now() - fixtureStarted;
if (!decodedFixture.ok) throw new Error(decodedFixture.error);
const fixture: MissingSlotFixture = decodedFixture;

async function openProof(): Promise<OpenWorldMissingSlotTranscript> {
  const result = await verifyOpenWorldMissingSlotProof({
    expectedRegistryRoot: fixture.expected_root,
    registeredCount: fixture.registered_count,
    registrationIndex: fixture.registration_index,
    proofEntryCount: fixture.proof_entry_count,
    directions: fixture.directions,
    parentKeys: fixture.parent_keys,
    parentValues: fixture.parent_values,
    siblingDigests: fixture.sibling_digests,
  });
  if (!result.ok) throw new Error(result.error);
  return result;
}

const expectedProofKey = await openWorldEncounterRegistrationKey(
  fixture.registration_index,
);
const backend = createStandardWebCryptoBackend(crypto);
const warm = await openProof();
const warmStandard = await verifyOpenWorldMissingSlotSemantics(
  warm,
  backend,
  fixture.expected_root,
  fixture.registered_count,
  fixture.registration_index,
  expectedProofKey,
);
if (!warmStandard.ok) throw new Error(warmStandard.reason);

const moonBitOpen: number[] = [];
const standardPlan: number[] = [];
for (let index = 0; index < ITERATIONS; index++) {
  let started = performance.now();
  const transcript = await openProof();
  moonBitOpen.push(performance.now() - started);
  started = performance.now();
  const standard = await verifyOpenWorldMissingSlotSemantics(
    transcript,
    backend,
    fixture.expected_root,
    fixture.registered_count,
    fixture.registration_index,
    expectedProofKey,
  );
  standardPlan.push(performance.now() - started);
  if (!standard.ok) throw new Error(standard.reason);
}

console.log(JSON.stringify({
  measured_at: new Date().toISOString(),
  iterations: ITERATIONS,
  registered_count: fixture.registered_count,
  registration_index: fixture.registration_index,
  proof_entry_count: fixture.proof_entry_count,
  path_steps: warm.path.length,
  hash_checks: warm.hash_check_count,
  fixture_generation_ms: Math.round(fixtureGenerationMs * 1_000) / 1_000,
  moonbit_open: summarizeLatency(moonBitOpen),
  standard_webcrypto_plan: summarizeLatency(standardPlan),
}, null, 2));
