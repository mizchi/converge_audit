import { expect, test } from "@playwright/test";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { createStandardWebCryptoBackend } from "../../../player-local-runtime/crypto-backend.ts";
import { EncounterHttpApi } from "../../src/encounter-api.ts";
import type { EncounterTermination } from "../../game/encounter/contracts.ts";

test("Chromium sends signed HTTP envelopes after reserving durable capacity, then settles and retires after reload", async ({ page }) => {
  const backend = createStandardWebCryptoBackend(crypto);
  const owner = (await backend.generateSigningKey()).signer;
  const signer = (await backend.generateSigningKey()).signer;
  const db = new DatabaseSync(":memory:");
  const sql = { exec(query: string, ...args: (string | number | null)[]) {
    const rows = db.prepare(query).all(...args); return { toArray: () => rows };
  } };
  let now = 1_000;
  const api = new EncounterHttpApi({ sql, signer, crypto, adminToken: "browser-admin", now: () => now, retentionMs: 10_000 });
  const endpoint = "https://encounter.test/v1/pve/browser/encounter";
  const authorization = { unit: "browser", startHead: "earned-browser-start", playerId: "alice", ownerPublicKey: owner.publicKey };
  await api.fetch(new Request(`${endpoint}-admissions`, { method: "POST", headers: { authorization: "Bearer browser-admin" }, body: JSON.stringify(authorization) }));
  // Real browser Fetch and wire bytes; intercept only the network/TLS boundary.
  // SQL and the complete authentication/game service run in Node here; a
  // separate workerd test covers the actual edge and Durable Object routes.
  await page.route("https://encounter.test/**", async (route) => {
    const req = route.request();
    const response = await api.fetch(new Request(req.url(), { method: req.method(), headers: req.headers(), body: req.postData() }));
    const headers: Record<string, string> = { "access-control-allow-origin": "*" };
    response.headers.forEach((value, key) => { headers[key] = value; });
    await route.fulfill({ status: response.status, headers, body: await response.text() });
  });
  await page.exposeFunction("httpEncounterSign", (digest: string) => owner.signDigest(digest));
  const options = { endpoint, authorization, name: `http-browser-${crypto.randomUUID()}`, trustedKey: signer.publicKey,
    cryptoPath: `/@fs${fileURLToPath(new URL("../../../player-local-runtime/crypto-backend.ts", import.meta.url))}` };
  const operation = async (input: typeof options & { now: number; action: "record" | "commit" | "settle" | "prune" | "abandon" | "cleanup"; termination?: EncounterTermination }) => {
    const recorderPath = "/src/audit/encounter-recorder.ts";
    const transportPath = "/src/audit/encounter-http.ts";
    const { EncounterRecorder } = await import(recorderPath);
    const { HttpEncounterTransport } = await import(transportPath);
    const { createStandardWebCryptoBackend } = await import(input.cryptoPath);
    const rpc = globalThis as unknown as { httpEncounterSign(digest: string): Promise<string> };
    const backend = createStandardWebCryptoBackend(crypto);
    const owner = { scheme: "ed25519-v1", publicKey: input.authorization.ownerPublicKey, signDigest: rpc.httpEncounterSign };
    const transport = new HttpEncounterTransport({ endpoint: input.endpoint, unit: input.authorization.unit,
      owner, cryptoBackend: backend, now: () => input.now });
    const recorder = await EncounterRecorder.start({ factory: indexedDB, name: input.name,
      authorization: input.authorization, owner, cryptoBackend: backend, transport, trustedAuthorityKey: input.trustedKey });
    try {
      switch (input.action) {
        case "record": {
          const frames = Array.from({ length: 60 }, (_, i) => ({ tick: i + 1, horizontal: i >= 30 && i < 40 ? 1 : 0, vertical: 0 }));
          if (await recorder.recordChunk(0, frames.slice(0, 30)) !== "stored" || await recorder.recordChunk(1, frames.slice(30)) !== "stored") throw new Error("failed durable record");
          return await transport.start(input.authorization.startHead);
        }
        case "commit": return await recorder.commit();
        case "settle": {
          const receipt = await recorder.settle();
          await recorder.admitToMarket(receipt, receipt.statement.items[0].assetId);
          return receipt;
        }
        case "prune": {
          const pruned = await recorder.prune(); const released = await recorder.release();
          return { pruned, released };
        }
        case "abandon": {
          const frames = Array.from({ length: 30 }, (_, i) => ({ tick: i + 1, horizontal: 0, vertical: 0 }));
          if (await recorder.recordChunk(0, frames) !== "stored") throw new Error("failed partial record");
          return await recorder.terminate("abandoned");
        }
        case "cleanup": {
          const recovered = await recorder.terminate("expired");
          const before = await recorder.snapshot();
          const original = transport.closureGrant.bind(transport);
          transport.closureGrant = async (...args: Parameters<typeof original>) => ({ ...await original(...args), authorization: "0".repeat(128) });
          const forged = await recorder.cleanupTerminated(input.termination!);
          transport.closureGrant = original;
          const released = await recorder.cleanupTerminated(input.termination!);
          return { recovered, before, forged, released };
        }
      }
    } finally { recorder.close(); }
  };
  try {
    await page.goto("/");
    const ticket = await page.evaluate(operation, { ...options, now, action: "record" as const });
    await page.reload(); now = ticket.commitNotBefore;
    await page.evaluate(operation, { ...options, now, action: "commit" as const });
    now = ticket.releaseAt;
    const receipt = await page.evaluate(operation, { ...options, now, action: "settle" as const });
    expect(receipt.statement.items).toHaveLength(1);
    now = receipt.statement.retentionUntil;
    expect(await page.evaluate(operation, { ...options, now, action: "prune" as const })).toEqual({ pruned: "pruned", released: "released" });
    const abandonedAuthorization = { ...authorization, startHead: "abandoned-browser-start" };
    await api.fetch(new Request(`${endpoint}-admissions`, { method: "POST", headers: { authorization: "Bearer browser-admin" }, body: JSON.stringify(abandonedAuthorization) }));
    const abandonedOptions = { ...options, authorization: abandonedAuthorization };
    const termination = await page.evaluate(operation, { ...abandonedOptions, now, action: "abandon" as const });
    await page.reload(); now = termination.statement.retentionUntil;
    const cleaned = await page.evaluate(operation, { ...abandonedOptions, now, action: "cleanup" as const, termination });
    expect(cleaned.before.itemCount).toBe(1);
    expect(cleaned.recovered).toEqual(termination);
    expect(cleaned.forged).toBe("refused"); expect(cleaned.released).toBe("released");
  } finally { db.close(); }
});
