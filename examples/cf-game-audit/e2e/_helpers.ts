import type { Page } from "@playwright/test";

export async function gotoApp(
  page: Page,
  input: { seed?: number; runId?: string } = {},
): Promise<void> {
  const seed = input.seed ?? 4661;
  const runId = input.runId ?? "authority-smoke-epoch0";
  await page.goto(`/?seed=${seed}&run=${runId}`);
  await page.getByRole("heading", { name: "Audit Survivors" }).waitFor();
}
