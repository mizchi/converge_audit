import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

test("production MoonBit bridge exports no seed-backed producer", async () => {
  const audit = await import(
    "../../../_build/js/release/build/x/game_audit/worker/worker.js"
  );
  const forbidden = Object.keys(audit).filter((name) =>
    name.startsWith("audit_benchmark_make_") ||
    name.startsWith("audit_experimental_sign_")
  );

  assert.deepEqual(forbidden, []);
});

test("production browser seals game checkpoints through the asynchronous digest API", async () => {
  const source = await readFile(
    new URL("../web/src/main.ts", import.meta.url),
    "utf8",
  );

  assert.match(source, /createGameAuditJournalAsync/);
  assert.match(source, /appendAuditTickAsync/);
  assert.match(source, /captureRunSnapshot/);
  assert.match(source, /restoreRunSnapshotAsync/);
  assert.doesNotMatch(source, /\bcreateGameAuditJournal\(/);
  assert.doesNotMatch(source, /\bappendAuditTick\(/);
  assert.doesNotMatch(source, /moonBitAuditDigest/);
});
