import { expect, test } from "@playwright/test";
import { gotoApp } from "./_helpers";

test("lineage隔離の期限とappeal後の回復を明示する", async ({ page }) => {
  let releaseAuthority!: () => void;
  const authorityReleased = new Promise<void>((resolve) => {
    releaseAuthority = resolve;
  });
  await page.route("**/game-item-verifications", async (route) => {
    await authorityReleased;
    await route.continue();
  });

  let assetId = "";
  await page.route("**/game-market-listings", async (route) => {
    const body = route.request().postDataJSON() as {
      asset_id: string;
      authority_receipt_id: string;
    };
    assetId = body.asset_id;
    await route.fulfill({
      status: 403,
      contentType: "application/json",
      body: JSON.stringify({
        ok: true,
        allowed: false,
        decision: "asset_lineage_revoked",
        asset_id: body.asset_id,
        open_revocations: 1,
        lineage_settlement: lineageStatus(
          body.asset_id,
          body.authority_receipt_id,
          "quarantined",
        ),
      }),
    });
  });

  let statusRequests = 0;
  let releaseExpiredStatus!: () => void;
  const expiredStatusReleased = new Promise<void>((resolve) => {
    releaseExpiredStatus = resolve;
  });
  await page.route("**/game-asset-lineage-status?asset_id=*", async (route) => {
    statusRequests += 1;
    if (statusRequests === 1) await expiredStatusReleased;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(statusRequests === 1
        ? lineageStatus(assetId, "a".repeat(64), "expired")
        : {
            ok: true,
            asset_id: assetId,
            eligibility: "eligible",
            settlement_status: "finalized",
            open_revocations: 0,
            lineage_cases: [],
          }),
    });
  });

  await gotoApp(page, {
    runId: `lineage-status-${crypto.randomUUID()}`,
  });
  await expect(page.getByText("local checkpoint e0 / ACK待ち")).toBeVisible();
  await page.keyboard.down("ArrowRight");
  await expect(page.getByText("common · provisional")).toBeVisible();
  await expect(page.getByRole("button", { name: "監査待ち" })).toBeDisabled();
  await page.keyboard.up("ArrowRight");

  releaseAuthority();
  const listing = page.getByRole("button", { name: "マーケットへ出品" });
  await expect(page.getByText("common · finalized")).toBeVisible();
  await expect(listing).toBeEnabled();
  await listing.click();

  await expect(page.getByText("common · quarantined · appeal open")).toBeVisible();
  const refresh = page.getByRole("button", { name: "監査状態を再確認" });
  await expect(refresh).toBeEnabled();
  await refresh.click();
  await expect(page.getByRole("button", { name: "状態確認中" })).toBeDisabled();
  releaseExpiredStatus();

  await expect(page.getByText("common · expired · listing blocked")).toBeVisible();
  await page.getByRole("button", { name: "監査状態を再確認" }).click();
  await expect(page.getByText("common · finalized")).toBeVisible();
  await expect(page.getByRole("button", { name: "マーケットへ出品" }))
    .toBeEnabled();
});

function lineageStatus(
  assetId: string,
  ancestorId: string,
  status: "quarantined" | "expired",
) {
  return {
    ok: true,
    asset_id: assetId,
    eligibility: "revoked",
    settlement_status: status,
    open_revocations: 1,
    lineage_cases: [{
      ancestor_id: ancestorId,
      ancestor_kind: "origin",
      revision: 1,
      decision_id: "d".repeat(64),
      reason_code: "origin_checkpoint_challenge_upheld",
      lifecycle: status === "quarantined" ? "appeal_open" : "expired",
      appeal_deadline_at_ms: 5000,
      finalized_at_ms: null,
      updated_at_ms: 1234,
    }],
  };
}
