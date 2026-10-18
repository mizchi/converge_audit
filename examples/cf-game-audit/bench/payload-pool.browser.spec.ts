import { expect, test } from "@playwright/test";
import { writeFile } from "node:fs/promises";
import type { PooledAuditPayloadQueue } from "../web/src/audit/payload-pool.ts";

test("measure one shared pool with 64 encounters and bounded metadata recycling", async ({ page, browser }) => {
  await page.goto("/");
  const result = await page.evaluate(async () => {
    const modulePath = "/src/audit/payload-pool.ts";
    const { IndexedDbAuditPayloadPool } = await import(modulePath);
    const options = { factory: indexedDB, name: `payload-benchmark-${crypto.randomUUID()}`,
      limits: { maxBytes: 1_048_576, reservedBytes: 131_072, maxItems: 256, maxItemBytes: 4_096 }, maxQueues: 128 };
    const scope = (queueId: string) => ({ queueId,
      limits: { maxBytes: 16_384, reservedBytes: 8_192, maxItems: 2, maxItemBytes: 4_096 },
      verifyPruneGrant: async () => true }); // excludes crypto and game-policy verification
    const grant = async (queueId: string, queue: PooledAuditPayloadQueue) => ({ queueId,
      expectedRevision: (await queue.snapshot()).revision, throughSequence: 1,
      throughCheckpointDigest: "a".repeat(64), authorization: "benchmark-final-closure",
      deliveryAcknowledged: true, gameplayFinalized: true, retentionClosed: true, unresolvedReference: false });
    const payload = new Uint8Array(4_096);
    const samples: Record<string, number[]> = {};
    let measured = false;
    const timed = async <T,>(name: string, operation: () => Promise<T>): Promise<T> => {
      const before = performance.now(); const value = await operation();
      if (measured) (samples[name] ??= []).push(performance.now() - before);
      return value;
    };
    let pool = await IndexedDbAuditPayloadPool.open(options);
    try {
      for (let i = 0; i < 8; i++) {
        const id = `warmup-${i}`; const queue = await pool.queue(scope(id));
        for (let sequence = 0; sequence < 2; sequence++) await queue.append({ sequence, checkpointDigest: "a".repeat(64), payload });
        await queue.prune(await grant(id, queue)); await queue.release(await grant(id, queue)); queue.close();
      }
      measured = true;
      for (let i = 0; i < 64; i++) {
        const id = `encounter-${i}`;
        const queue = await timed<PooledAuditPayloadQueue>("registerQueue", () => pool.queue(scope(id)));
        for (let sequence = 0; sequence < 2; sequence++) {
          const status = await timed("append4096Bytes", () => queue.append({ sequence, checkpointDigest: "a".repeat(64), payload }));
          if (status !== "stored") throw new Error(`unexpected append: ${status}`);
        }
        queue.close();
      }
      const full = await pool.snapshot(); pool.close();
      const reopenStart = performance.now();
      pool = await IndexedDbAuditPayloadPool.open(options);
      const reopenAndValidateMs = performance.now() - reopenStart;
      for (let i = 0; i < 64; i++) {
        const id = `encounter-${i}`; const queue = await pool.queue(scope(id));
        const prune = await grant(id, queue);
        await timed("prune8192Bytes", () => queue.prune(prune));
        const release = await grant(id, queue);
        await timed("releaseMetadata", () => queue.release(release)); queue.close();
      }
      const timings = Object.fromEntries(Object.entries(samples).map(([name, values]) => {
        const ordered = [...values].sort((a, b) => a - b);
        return [name, { samples: ordered.length, p50Ms: ordered[Math.floor(ordered.length * 0.5)], p95Ms: ordered[Math.floor(ordered.length * 0.95)] }];
      }));
      return { benchmark: "indexeddb-shared-payload-pool-v1", userAgent: navigator.userAgent,
        environment: { browserContext: "ephemeral", networkIncluded: false,
          cryptographicVerificationIncluded: false, physicalDiskDurabilityMeasured: false },
        warmupQueues: 8, measuredQueues: 64, poolLimits: options.limits, maxQueues: options.maxQueues,
        full, timings, reopenAndValidateMs, afterRelease: await pool.snapshot() };
    } finally { pool.close(); }
  });
  expect(result.full).toMatchObject({ usedBytes: 524_288, itemCount: 128, queueCount: 64 });
  expect(result.afterRelease).toMatchObject({ usedBytes: 0, itemCount: 0, queueCount: 0 });
  const artifact = { ...result, browserVersion: browser.version(),
    host: { node: process.version, platform: process.platform, arch: process.arch } };
  await writeFile(new URL("../benchmarks/payload-pool-chromium-2026-10-17.json", import.meta.url), `${JSON.stringify(artifact, null, 2)}\n`);
});
