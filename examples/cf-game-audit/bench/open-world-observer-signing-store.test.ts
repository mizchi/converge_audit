import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { expect, it } from "vitest";
import { summarizeLatency } from "../src/benchmark-metrics";
import type { Env as AuditEnv } from "../src/index";
import { loadCheckpointRuntime } from "../src/moonbit";
import { OpenWorldObserverSigningStore } from "../src/open-world-observer-signing-store";

const OBSERVER_ID = "open-world-observer-benchmark";
const SIGNER_KEY = "11".repeat(32);
const AUDIT_PLAN = "22".repeat(32);
const SIZES = (process.env.AUDIT_OBSERVER_SIGNING_BENCH_SIZES ?? "1,64,256,1024")
  .split(",")
  .map(Number);
const ITERATIONS = Number(
  process.env.AUDIT_OBSERVER_SIGNING_BENCH_ITERATIONS ?? 3,
);

function digest(index: number): string {
  return (index + 1).toString(16).padStart(64, "0");
}

it("benchmarks durable observer reservation and snapshot costs", async () => {
  const auditEnv = env as unknown as AuditEnv;
  const results = [];
  for (const size of SIZES) {
    expect(Number.isSafeInteger(size) && size > 0 && size <= 16_384).toBe(true);
    expect(Number.isSafeInteger(ITERATIONS) && ITERATIONS > 0).toBe(true);
    const reservations: number[] = [];
    const snapshots: number[] = [];
    const sqliteBytes: number[] = [];
    const sqliteBytesPerReservation: number[] = [];
    const snapshotAdditionalBytes: number[] = [];
    for (let iteration = 0; iteration < ITERATIONS; iteration++) {
      const name =
        `observer-signing-bench:${size}:${iteration}:${crypto.randomUUID()}`;
      const target = auditEnv.AUDIT_SHARD.get(auditEnv.AUDIT_SHARD.idFromName(name));
      await runInDurableObject(target, async (_instance, state) => {
        const runtime = await loadCheckpointRuntime();
        const store = new OpenWorldObserverSigningStore(state.storage);
        store.open(runtime, { observerId: OBSERVER_ID, signerKey: SIGNER_KEY });
        const initialBytes = state.storage.sql.databaseSize;
        for (let index = 0; index < size; index++) {
          const started = performance.now();
          const reserved = store.reserve(runtime, {
            auditCheckpointDigest: AUDIT_PLAN,
            registrationIndex: index,
            encounterDigest: digest(index),
          }, index + 1);
          reservations.push(performance.now() - started);
          expect(reserved.decision).toBe("reserved");
        }
        const afterReservationsBytes = state.storage.sql.databaseSize;
        const snapshotStarted = performance.now();
        const anchor = store.snapshot(runtime, size + 1);
        snapshots.push(performance.now() - snapshotStarted);
        const afterSnapshotBytes = state.storage.sql.databaseSize;
        expect(anchor.size).toBe(size);
        sqliteBytes.push(afterSnapshotBytes);
        sqliteBytesPerReservation.push(
          (afterReservationsBytes - initialBytes) / size,
        );
        snapshotAdditionalBytes.push(
          afterSnapshotBytes - afterReservationsBytes,
        );
      });
    }
    const mean = (values: number[]) =>
      Math.round(
        (values.reduce((sum, value) => sum + value, 0) / values.length) * 10,
      ) / 10;
    results.push({
      reservations: size,
      iterations: ITERATIONS,
      reserve_ms: summarizeLatency(reservations),
      snapshot_ms: summarizeLatency(snapshots),
      sqlite_bytes_mean: mean(sqliteBytes),
      sqlite_bytes_per_reservation_mean: mean(sqliteBytesPerReservation),
      snapshot_additional_bytes_mean: mean(snapshotAdditionalBytes),
    });
  }
  console.log(JSON.stringify({ results }, null, 2));
});
