import { expect, test } from "@playwright/test";

test("two Chromium tabs cannot reserve the same free capacity and a reload preserves the winning credit", async ({ page, context }) => {
  const second = await context.newPage();
  await Promise.all([page.goto("/"), second.goto("/")]);
  const name = `reserved-browser-${crypto.randomUUID()}`;
  const operation = async (input: { name: string; queueId: string; action: "reserve" | "append" | "steal" | "status"; sequence?: number }) => {
    const modulePath = "/src/audit/payload-pool.ts";
    const { IndexedDbAuditPayloadPool } = await import(modulePath);
    const pool = await IndexedDbAuditPayloadPool.open({ factory: indexedDB, name: input.name,
      limits: { maxBytes: 8_192, reservedBytes: 0, maxItems: 2, maxItemBytes: 4_096 }, maxQueues: 3 });
    try {
      if (input.action === "status") return pool.snapshot();
      const options = { queueId: input.queueId,
        limits: { maxBytes: 8_192, reservedBytes: 0, maxItems: 2, maxItemBytes: 4_096 }, verifyPruneGrant: async () => false };
      const queue = input.action === "steal" ? await pool.queue(options) : await pool.reserve({ ...options, bytes: 8_192, items: 2 });
      if (input.action === "reserve") return "reserved";
      return queue.append({ sequence: input.sequence ?? 0, checkpointDigest: "a".repeat(64), payload: new Uint8Array(4_096) });
    } catch (e) {
      if (input.action === "reserve" && e instanceof Error && /capacity/.test(e.message)) return "full";
      throw e;
    } finally { pool.close(); }
  };
  const contenders = await Promise.all([
    page.evaluate(operation, { name, queueId: "a", action: "reserve" as const }),
    second.evaluate(operation, { name, queueId: "b", action: "reserve" as const }),
  ]);
  expect([...contenders].sort()).toEqual(["full", "reserved"]);
  const winner = contenders[0] === "reserved" ? "a" : "b";
  await Promise.all([page.reload(), second.reload()]);
  expect(await page.evaluate(operation, { name, queueId: winner, action: "status" as const }))
    .toMatchObject({ reservedPayloadBytes: 8_192, reservedItemCount: 2, usedBytes: 0 });
  expect(await second.evaluate(operation, { name, queueId: "other", action: "steal" as const })).toBe("backpressure");
  expect(await page.evaluate(operation, { name, queueId: winner, action: "append" as const, sequence: 0 })).toBe("stored");
  expect(await second.evaluate(operation, { name, queueId: winner, action: "append" as const, sequence: 1 })).toBe("stored");
  expect(await page.evaluate(operation, { name, queueId: winner, action: "status" as const }))
    .toMatchObject({ reservedPayloadBytes: 0, reservedItemCount: 0, usedBytes: 8_192 });
});

test("two Chromium tabs share the last free bytes across encounters, reload and authenticated retirement", async ({ page, context }) => {
  const second = await context.newPage();
  await Promise.all([page.goto("/"), second.goto("/")]);
  const name = `shared-payload-browser-${crypto.randomUUID()}`;
  const operation = async (input: { name: string; queueId: string; action: "register" | "append" | "retire" | "status" }) => {
    const modulePath = "/src/audit/payload-pool.ts";
    const { IndexedDbAuditPayloadPool } = await import(modulePath);
    const pool = await IndexedDbAuditPayloadPool.open({ factory: indexedDB, name: input.name,
      limits: { maxBytes: 12_288, reservedBytes: 4_096, maxItems: 4, maxItemBytes: 8_192 }, maxQueues: 3 });
    try {
      if (input.action === "status") return pool.snapshot();
      const queue = await pool.queue({ queueId: input.queueId,
        limits: { maxBytes: 16_384, reservedBytes: 4_096, maxItems: 4, maxItemBytes: 8_192 },
        // This test isolates real IDB behavior. The encounter browser test uses
        // actual authority signatures for this same gate.
        verifyPruneGrant: async (grant: { authorization: string }) => grant.authorization === "browser-test-closure" });
      try {
        if (input.action === "register") return "registered";
        if (input.action === "append") return queue.append({ sequence: 0, checkpointDigest: "a".repeat(64), payload: new Uint8Array(8_192) });
        const grant = { queueId: input.queueId, expectedRevision: (await queue.snapshot()).revision,
          throughSequence: 0, throughCheckpointDigest: "a".repeat(64), authorization: "browser-test-closure",
          deliveryAcknowledged: true, gameplayFinalized: true, retentionClosed: true, unresolvedReference: false };
        const pruned = await queue.prune(grant);
        const released = await queue.release({ ...grant, expectedRevision: (await queue.snapshot()).revision });
        return { pruned, released, pool: await pool.snapshot() };
      } finally { queue.close(); }
    } finally { pool.close(); }
  };
  await page.evaluate(operation, { name, queueId: "a", action: "register" as const });
  await second.evaluate(operation, { name, queueId: "b", action: "register" as const });
  const results = await Promise.all([
    page.evaluate(operation, { name, queueId: "a", action: "append" as const }),
    second.evaluate(operation, { name, queueId: "b", action: "append" as const }),
  ]);
  expect([...results].sort()).toEqual(["backpressure", "stored"]);
  await Promise.all([page.reload(), second.reload()]);
  const restored = await page.evaluate(operation, { name, queueId: "", action: "status" as const });
  expect(restored).toMatchObject({ usedBytes: 8_192, itemCount: 1, queueCount: 2 });
  const winner = results[0] === "stored" ? "a" : "b";
  const loser = winner === "a" ? "b" : "a";
  expect(await second.evaluate(operation, { name, queueId: loser, action: "append" as const })).toBe("backpressure");
  const retired = await page.evaluate(operation, { name, queueId: winner, action: "retire" as const });
  expect(retired).toMatchObject({ pruned: "pruned", released: "released", pool: { usedBytes: 0, itemCount: 0, queueCount: 1 } });
  expect(await second.evaluate(operation, { name, queueId: loser, action: "append" as const })).toBe("stored");
});
