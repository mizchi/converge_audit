import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { createTestHarness, type TestHarness } from "wrangler";

let server: TestHarness;

before(async () => {
  server = createTestHarness({
    root: new URL("..", import.meta.url).pathname,
    workers: [{
      configPath: "./wrangler.jsonc",
      vars: {
        ADMIN_TOKEN: "test-admin-token",
        WITNESS_SOURCE_BUCKET_KEY: "test-source-bucket-key-000000000000",
      },
    }],
  });
  await server.listen();
});

after(async () => {
  await server.close();
});

test("serves the browser shell without shadowing Worker routes", async () => {
  const shell = await server.fetch("/");
  assert.equal(shell.status, 200);
  assert.match(shell.headers.get("content-type") ?? "", /text\/html/);
  assert.match(await shell.text(), /Audit Survivors/);

  const health = await server.fetch("/health");
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), {
    ok: true,
    service: "converge-game-audit",
  });
});
