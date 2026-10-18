import { expect, test } from "@playwright/test";

test("bounded payloads survive reload and serialize writes from two Chromium tabs", async ({ page, context }) => {
  const second = await context.newPage();
  await Promise.all([page.goto("/"), second.goto("/")]);
  const name = `payload-browser-${crypto.randomUUID()}`;
  const append = async (input: { name: string; sequence: number }) => {
    const modulePath = "/src/audit/bounded-payload-queue.ts";
    const { IndexedDbAuditPayloadQueue } = await import(modulePath);
    const queue = await IndexedDbAuditPayloadQueue.open({
      factory: indexedDB, name: input.name, queueId: "browser-test",
      limits: { maxBytes: 24_576, reservedBytes: 8_192, maxItemBytes: 8_192, maxItems: 2 },
      verifyPruneGrant: async () => false,
    });
    try {
      return await queue.append({ sequence: input.sequence,
        checkpointDigest: "a".repeat(64), payload: new Uint8Array(8_192) });
    } finally { queue.close(); }
  };
  expect(await page.evaluate(append, { name, sequence: 0 })).toBe("stored");
  const concurrent = await Promise.all([
    page.evaluate(append, { name, sequence: 1 }),
    second.evaluate(append, { name, sequence: 1 }),
  ]);
  expect(concurrent.sort()).toEqual(["duplicate", "stored"]);
  expect(await second.evaluate(append, { name, sequence: 2 })).toBe("backpressure");
  await page.reload();
  const restored = await page.evaluate(async (databaseName) => {
    const modulePath = "/src/audit/bounded-payload-queue.ts";
    const { IndexedDbAuditPayloadQueue } = await import(modulePath);
    const queue = await IndexedDbAuditPayloadQueue.open({
      factory: indexedDB, name: databaseName, queueId: "browser-test",
      limits: { maxBytes: 24_576, reservedBytes: 8_192, maxItemBytes: 8_192, maxItems: 2 },
      verifyPruneGrant: async () => false,
    });
    try { return await queue.snapshot(); } finally { queue.close(); }
  }, name);
  expect(restored).toEqual({ usedBytes: 16_384, itemCount: 2, firstSequence: 0, nextSequence: 2, revision: 2 });
});
