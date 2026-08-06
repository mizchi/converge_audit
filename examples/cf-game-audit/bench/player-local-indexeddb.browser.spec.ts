import { expect, test } from "@playwright/test";

test("benchmarks the real Chromium IndexedDB adapter", async ({ page }) => {
  await page.goto("/?playerLocalBench=1");
  await page.waitForFunction(() =>
    typeof window.__convergePlayerLocalBenchmark === "function"
  );
  const result = await page.evaluate(async (epochs) =>
    window.__convergePlayerLocalBenchmark!(epochs), 128
  );
  console.log(JSON.stringify(result, null, 2));
  expect(result.restored).toEqual({
    checkpoint_count: 120,
    outbox_tombstones: 120,
    ack_evidence: 120,
    head_epoch: 127,
    retention_anchor_epoch: 7,
  });
  expect(result.logical_image_bytes).toBeLessThan(
    result.logical_image_bytes_before_prune,
  );
  expect(result.evidence_inbox_poll.messages).toBe(16);
  expect(result.evidence_inbox_poll.last_sequence).toBe(15);
});
