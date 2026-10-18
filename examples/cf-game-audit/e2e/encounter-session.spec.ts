import { expect, test, type Page, type APIRequestContext } from "@playwright/test";

async function assign(page: Page, request: APIRequestContext, unit: string, startHead = "earned-ui-start", generation = 0) {
  await expect(page.locator("#owner-key")).toHaveValue(/^[0-9a-f]{64}$/);
  const ownerPublicKey = await page.locator("#owner-key").inputValue();
  const response = await request.post(`/v1/pve/${unit}/encounter-admissions`, {
    headers: { authorization: "Bearer test-admin-token" }, data: { unit, startHead, playerId: "alice", ownerPublicKey, ...(generation > 0 ? { generation } : {}) },
  });
  expect(response.status()).toBe(201);
  await page.getByRole("button", { name: "状態を再確認" }).click();
  await expect(page.getByRole("button", { name: "戦闘を開始" })).toBeEnabled();
}
const tick = (page: Page) => page.locator("#tick").textContent().then((text) => Number.parseInt(text ?? "0"));

test("an initialization failure disables session actions and refresh reopens the same device safely", async ({ page }) => {
  let fail = true;
  await page.route("**/v1/pve/*/encounter", async (route) => {
    if (fail && route.request().postDataJSON()?.command.op === "admissions") {
      fail = false; await route.fulfill({ status: 503, contentType: "application/json", body: "{}" });
    } else await route.continue();
  });
  await page.goto(`/?unit=ui-retry-${crypto.randomUUID()}`);
  await expect(page.locator("#session-status")).toHaveText("接続・保存状態の確認が必要です");
  const key = await page.locator("#owner-key").inputValue(); expect(key).toMatch(/^[0-9a-f]{64}$/);
  for (const name of ["戦闘を開始", "中断して終了", "復旧用ログを解放"]) await expect(page.getByRole("button", { name, exact: true })).toBeDisabled();
  await page.getByRole("button", { name: "状態を再確認" }).click();
  await expect(page.locator("#session-status")).toHaveText("開始待ち");
  await expect(page.locator("#owner-key")).toHaveValue(key);
});

test("the default screen preserves old receipts while playing and restoring the next generation", async ({ page, request }) => {
  const unit = `ui-${crypto.randomUUID()}`; const calls: string[] = [];
  page.on("request", (request) => { if (request.url().includes("/v1/")) calls.push(request.url()); });
  await page.goto(`/?unit=${unit}`);
  await expect(page.locator("#session-status")).toHaveText("開始待ち");
  expect(await page.locator("#seed").count()).toBe(0);
  await assign(page, request, unit);
  await page.getByRole("button", { name: "戦闘を開始" }).click();
  await expect.poll(() => tick(page)).toBeGreaterThanOrEqual(24);
  await expect(page.locator("#inventory .item-card")).toHaveCount(0);
  await page.keyboard.down("KeyD");
  await expect.poll(() => tick(page)).toBeGreaterThanOrEqual(44); await page.keyboard.up("KeyD");
  await expect(page.locator("#session-status")).toHaveText("戦利品確定");
  await expect(page.locator("#inventory .item-card")).toHaveCount(1);
  await page.getByRole("button", { name: "市場へ持ち込む" }).click();
  await expect(page.getByRole("button", { name: "市場で受理済み" })).toBeDisabled();
  await page.screenshot({ path: test.info().outputPath("encounter-ui.png"), fullPage: true });
  await expect(page.getByRole("button", { name: "復旧用ログを解放", exact: true })).toBeEnabled({ timeout: 15_000 });
  await page.getByRole("button", { name: "復旧用ログを解放", exact: true }).click();
  await expect(page.locator("#storage-status")).toContainText("ログ 0 bytes / 予約 0 bytes");
  const key = await page.locator("#owner-key").inputValue(); await page.reload();
  await expect(page.locator("#session-status")).toHaveText("戦利品確定");
  await expect(page.locator("#owner-key")).toHaveValue(key);
  await expect(page.getByRole("button", { name: "市場で受理済み" })).toBeDisabled();
  const rolled = await request.post(`/v1/pve/${unit}/encounter-generation`, { headers: { authorization: "Bearer test-admin-token" }, data: { expectedGeneration: 0 } });
  expect(rolled.status()).toBe(200);
  await assign(page, request, unit, "earned-ui-start", 1);
  const nextStart = page.waitForResponse((r) => r.request().postDataJSON()?.command?.op === "start" && r.request().postDataJSON()?.command?.generation === 1);
  await page.getByRole("button", { name: "戦闘を開始" }).click(); expect((await nextStart).status()).toBe(200);
  await expect.poll(() => tick(page)).toBeGreaterThanOrEqual(24);
  await page.keyboard.down("KeyD"); await expect.poll(() => tick(page)).toBeGreaterThanOrEqual(44); await page.keyboard.up("KeyD");
  await expect(page.locator("#session-status")).toHaveText("戦利品確定");
  await expect(page.locator("#inventory .item-card")).toHaveCount(2);
  await page.reload(); await expect(page.locator("#session-status")).toHaveText("戦利品確定");
  await expect(page.locator("#owner-key")).toHaveValue(key); await expect(page.locator("#inventory .item-card")).toHaveCount(2);
  expect(calls.some((url) => url.includes("game-item-verifications"))).toBe(false);
});

test("another tab cannot start concurrently, and reload of an incomplete encounter offers termination rather than resumed inputs", async ({ page, request, context }) => {
  const unit = `ui-stop-${crypto.randomUUID()}`;
  await page.goto(`/?unit=${unit}`); await expect(page.locator("#session-status")).toHaveText("開始待ち");
  await assign(page, request, unit);
  const second = await context.newPage(); await second.goto(`/?unit=${unit}`);
  await expect(second.locator("#session-status")).toHaveText("別タブで進行中");
  await expect(second.getByRole("button", { name: "戦闘を開始" })).toBeDisabled();
  await second.close(); await page.bringToFront();
  await page.getByRole("button", { name: "戦闘を開始" }).click();
  await expect.poll(() => tick(page)).toBeGreaterThanOrEqual(30);
  await page.reload(); await expect(page.locator("#session-status")).toHaveText("中断を検出");
  await expect(page.getByRole("button", { name: "戦闘を開始" })).toBeDisabled();
  await page.getByRole("button", { name: "中断して終了" }).click();
  await expect(page.locator("#session-status")).toHaveText("終了済み");
  await expect(page.getByRole("button", { name: "復旧用ログを解放", exact: true })).toBeEnabled({ timeout: 15_000 });
  await page.getByRole("button", { name: "復旧用ログを解放", exact: true }).click();
  await expect(page.locator("#storage-status")).toContainText("ログ 0 bytes / 予約 0 bytes");
  await expect(page.locator("#inventory .item-card")).toHaveCount(0);
  await page.getByRole("button", { name: "終了した戦闘を片付ける", exact: true }).click();
  await expect(page.locator("#session-status")).toHaveText("開始待ち");
  const roll = await request.post(`/v1/pve/${unit}/encounter-generation`, {
    headers: { authorization: "Bearer test-admin-token" }, data: { expectedGeneration: 0 } });
  expect(roll.status()).toBe(200); await page.reload();
  await expect(page.locator("#session-status")).toHaveText("開始待ち");
  await expect(page.locator("#inventory .item-card")).toHaveCount(0);
});

test("archive handoff and receipt compaction survive reload while keeping an old item marketable and enabling the next start", async ({ page, request }) => {
  const unit = `ui-archive-${crypto.randomUUID()}`;
  await page.goto(`/?unit=${unit}`); await expect(page.locator("#session-status")).toHaveText("開始待ち");
  await assign(page, request, unit);
  await page.getByRole("button", { name: "戦闘を開始" }).click();
  await expect.poll(() => tick(page)).toBeGreaterThanOrEqual(24);
  await page.keyboard.down("KeyD"); await expect.poll(() => tick(page)).toBeGreaterThanOrEqual(44); await page.keyboard.up("KeyD");
  await expect(page.locator("#session-status")).toHaveText("戦利品確定");
  const upload = page.waitForResponse((response) => response.request().method() === "POST" && response.request().postDataJSON()?.command?.op === "archive-upload");
  const handoff = page.waitForResponse((response) => response.request().method() === "POST" && response.request().postDataJSON()?.command?.op === "archive-handoff");
  await page.getByRole("button", { name: "ログをサーバーへ預ける" }).click();
  expect((await upload).status()).toBe(200); expect((await handoff).status()).toBe(200);
  await expect(page.locator("#storage-status")).toContainText("ログ 0 bytes / 予約 0 bytes");
  await expect(page.getByRole("button", { name: "ログをサーバーへ預ける" })).toBeDisabled();
  await page.reload(); await expect(page.locator("#session-status")).toHaveText("戦利品確定");
  await expect(page.locator("#inventory .item-card")).toHaveCount(1);
  await expect(page.locator("#storage-status")).toContainText("ログ 0 bytes / 予約 0 bytes");
  await page.getByRole("button", { name: "レシートを集約", exact: true }).click();
  await expect(page.locator("#storage-status")).toContainText("端末レシート 0 / 16戦 · 集約済み 1戦");
  await expect(page.locator("#inventory .item-card")).toHaveCount(1);
  await page.getByRole("button", { name: "市場へ持ち込む", exact: true }).click();
  await expect(page.getByRole("button", { name: "市場で受理済み" })).toBeDisabled();
  await page.reload(); await expect(page.locator("#session-status")).toHaveText("開始待ち");
  await expect(page.getByRole("button", { name: "市場で受理済み" })).toBeDisabled();
  await expect(page.locator("#storage-status")).toContainText("集約済み 1戦");
  await assign(page, request, unit, "earned-second-start");
});

test("an empty receipt is retired after generation closure and a lost reply recovers from IndexedDB on reload", async ({ page, request }) => {
  const unit = `ui-empty-${crypto.randomUUID()}`;
  await page.goto(`/?unit=${unit}`); await expect(page.locator("#session-status")).toHaveText("開始待ち"); await assign(page, request, unit);
  await page.getByRole("button", { name: "戦闘を開始", exact: true }).click();
  await expect(page.locator("#session-status")).toHaveText("戦利品確定"); await expect(page.locator("#inventory .item-card")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "復旧用ログを解放", exact: true })).toBeEnabled({ timeout: 15_000 });
  await page.getByRole("button", { name: "復旧用ログを解放", exact: true }).click();
  await page.getByRole("button", { name: "レシートを集約", exact: true }).click();
  await expect(page.locator("#storage-status")).toContainText("集約済み 1戦");
  const rolled = await request.post(`/v1/pve/${unit}/encounter-generation`, { headers: { authorization: "Bearer test-admin-token" }, data: { expectedGeneration: 0 } });
  expect(rolled.status()).toBe(200);
  let retirementRequests = 0;
  await page.route("**/encounter", async (route) => {
    if (route.request().postDataJSON()?.command?.op === "inventory-retire-empty" && ++retirementRequests === 1) {
      const committed = await route.fetch(); expect(committed.status()).toBe(200); await committed.body(); await route.abort("connectionreset");
    } else await route.continue();
  });
  await page.getByRole("button", { name: "空のレシートを片付ける", exact: true }).click();
  await expect(page.locator("#session-error")).toBeVisible(); await page.reload();
  await expect(page.locator("#session-status")).toHaveText("開始待ち"); expect(retirementRequests).toBe(2);
  await expect(page.getByRole("button", { name: "空のレシートを片付ける", exact: true })).toBeDisabled();
  await expect(page.locator("#storage-status")).toContainText("集約済み 1戦");
});
