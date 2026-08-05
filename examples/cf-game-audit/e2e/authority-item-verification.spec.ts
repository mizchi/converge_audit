import { expect, test } from "@playwright/test";
import { gotoApp } from "./_helpers";

test("checkpoint に束縛された item だけが authority 検証を完了する", async ({ page }) => {
  let releaseAuthority!: () => void;
  const authorityReleased = new Promise<void>((resolve) => {
    releaseAuthority = resolve;
  });
  let markAuthorityRequested!: () => void;
  const authorityRequested = new Promise<void>((resolve) => {
    markAuthorityRequested = resolve;
  });
  await page.route("**/game-item-verifications", async (route) => {
    markAuthorityRequested();
    await authorityReleased;
    await route.continue();
  });
  let releaseCancellation!: () => void;
  const cancellationReleased = new Promise<void>((resolve) => {
    releaseCancellation = resolve;
  });
  let markCancellationRequested!: () => void;
  const cancellationRequested = new Promise<void>((resolve) => {
    markCancellationRequested = resolve;
  });
  await page.route("**/game-market-listing-cancellations", async (route) => {
    markCancellationRequested();
    await cancellationReleased;
    await route.continue();
  });
  await gotoApp(page, { runId: `authority-smoke-e0-${crypto.randomUUID()}` });

  await expect(page.getByText("local checkpoint e0 / ACK待ち")).toBeVisible();

  await page.keyboard.down("ArrowRight");
  const item = page.getByText("ember-blade");
  await expect(item).toBeVisible();
  await authorityRequested;
  const awaitingAudit = page.getByRole("button", { name: "監査待ち" });
  await expect(awaitingAudit).toBeDisabled();
  await page.keyboard.up("ArrowRight");

  releaseAuthority();
  await expect(awaitingAudit).toBeHidden();
  await expect(item).toBeVisible();
  const marketListing = page.getByRole("button", { name: "マーケットへ出品" });
  await expect(marketListing).toBeEnabled();
  await expect(page.getByText("common · authority verified")).toBeVisible();
  await expect(page.getByText(/authority verified loot-v1:/)).toBeVisible();
  await expect(page.getByText("loot picked up (provisional)")).toBeVisible();

  await marketListing.click();
  const cancellation = page.getByRole("button", { name: "出品を取り消す" });
  await expect(cancellation).toBeEnabled();
  await expect(page.getByText("common · market listed")).toBeVisible();
  await expect(page.getByText(/market listed loot-v1:/)).toBeVisible();

  await cancellation.click();
  await cancellationRequested;
  await expect(page.getByRole("button", { name: "取消中" })).toBeDisabled();
  releaseCancellation();
  await expect(page.getByRole("button", { name: "マーケットへ出品" }))
    .toBeEnabled();
  await expect(page.getByText("common · authority verified")).toBeVisible();
  await expect(page.getByText(/market canceled loot-v1:/)).toBeVisible();
});

test("later epochのitemは未検証parentを順にbackfillする", async ({ page }) => {
  const requests: string[] = [];
  let releaseCheckpoint!: () => void;
  const checkpointReleased = new Promise<void>((resolve) => {
    releaseCheckpoint = resolve;
  });
  let markCheckpointRequested!: () => void;
  const checkpointRequested = new Promise<void>((resolve) => {
    markCheckpointRequested = resolve;
  });
  await page.route("**/game-checkpoint-verifications", async (route) => {
    requests.push("checkpoint");
    markCheckpointRequested();
    await checkpointReleased;
    await route.continue();
  });
  await page.route("**/game-item-verifications", async (route) => {
    requests.push("item");
    await route.continue();
  });
  await gotoApp(page, {
    runId: `authority-smoke-e1-${crypto.randomUUID()}`,
  });

  await page.keyboard.down("ArrowLeft");
  await expect(page.getByText("local checkpoint e0 / ACK待ち")).toBeVisible();
  await page.keyboard.up("ArrowLeft");
  await page.keyboard.down("ArrowRight");
  await checkpointRequested;
  await expect(page.getByRole("button", { name: "監査待ち" })).toBeDisabled();
  await page.keyboard.up("ArrowRight");

  releaseCheckpoint();
  await expect(page.getByRole("button", { name: "マーケットへ出品" }))
    .toBeEnabled();
  expect(requests).toEqual(["checkpoint", "item"]);
});
