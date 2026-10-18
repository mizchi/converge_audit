import { test, expect } from "@playwright/test";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { createStandardWebCryptoBackend } from "../../../player-local-runtime/crypto-backend.ts";
import { EncounterAuthority, SqliteEncounterLedger } from "../../game/encounter/index.ts";
import type { EncounterCommit, EncounterListing, EncounterReceipt } from "../../game/encounter/contracts.ts";
import type { EncounterTransport } from "../../web/src/audit/encounter-recorder.ts";

test("Chromium recorder survives reload, admits replayed items and prunes only with real authority signatures", async ({ page }) => {
  const backend = createStandardWebCryptoBackend(crypto);
  const signer = (await backend.generateSigningKey()).signer;
  const owner = (await backend.generateSigningKey()).signer;
  const db = new DatabaseSync(":memory:");
  const ledger = new SqliteEncounterLedger({ exec(query: string, ...args: (string | number | null)[]) {
    const rows = db.prepare(query).all(...args);
    return { toArray: () => rows };
  } });
  let now = 1_000;
  const authority = new EncounterAuthority({ ledger, signer, crypto, now: () => now, retentionMs: 10_000 });
  const ticket = await authority.issue({ unit: "browser", startHead: "admitted-start", playerId: "alice", ownerPublicKey: owner.publicKey });
  // Test transport invokes the actual service. Key custody is tested separately.
  await page.exposeFunction("encounterSign", (digest: string) => owner.signDigest(digest));
  await page.exposeFunction("encounterCall", async (method: string, payload: unknown) => {
    switch (method) {
      case "commit": return authority.commit(payload as EncounterCommit);
      case "reveal": return authority.reveal(payload as string);
      case "settle": {
        const p = payload as { id: string; chunks: { sequence: number; checkpointDigest: string; payload: number[] }[] };
        return authority.settle(p.id, p.chunks.map((c) => ({ ...c, payload: new Uint8Array(c.payload) })));
      }
      case "market": return authority.admitToMarket(payload as EncounterListing);
      case "prune": return authority.pruneGrant(ticket.ticketId, payload as number);
      default: throw new Error("unknown test operation");
    }
  });
  const options = {
    ticket, trustedKey: signer.publicKey, name: `encounter-browser-${ticket.ticketId}`,
    recorderPath: "/src/audit/encounter-recorder.ts",
    cryptoPath: `/@fs${fileURLToPath(new URL("../../../player-local-runtime/crypto-backend.ts", import.meta.url))}`,
  };
  const operation = async ({ action, ...input }: typeof options & { action: "record" | "commit" | "settle" | "prune" }) => {
    const { EncounterRecorder } = await import(input.recorderPath);
    const { createStandardWebCryptoBackend } = await import(input.cryptoPath);
    const rpc = globalThis as unknown as {
      encounterSign(digest: string): Promise<string>;
      encounterCall(method: string, payload: unknown): Promise<unknown>;
    };
    const call = async <T,>(method: string, payload: unknown): Promise<T> => await rpc.encounterCall(method, payload) as T;
    const transport: EncounterTransport = {
      commit: (c) => call("commit", c), reveal: (id) => call("reveal", id),
      settle: (id, chunks) => call("settle", { id, chunks: chunks.map((c) => ({ ...c, payload: Array.from(c.payload) })) }),
      admitToMarket: (listing) => call("market", listing), pruneGrant: (_id, revision) => call("prune", revision),
    };
    const recorder = await EncounterRecorder.open({ factory: indexedDB, name: input.name, ticket: input.ticket,
      trustedAuthorityKey: input.trustedKey, cryptoBackend: createStandardWebCryptoBackend(crypto), transport,
      owner: { publicKey: input.ticket.ownerPublicKey, scheme: "ed25519-v1", signDigest: rpc.encounterSign } });
    try {
      switch (action) {
        case "record": {
          const inputs = Array.from({ length: 60 }, (_, i) => ({ tick: i + 1, horizontal: i >= 30 && i < 40 ? 1 : 0, vertical: 0 }));
          return [await recorder.recordChunk(0, inputs.slice(0, 30)), await recorder.recordChunk(1, inputs.slice(30))];
        }
        case "commit": return await recorder.commit();
        case "settle": {
          const receipt = await recorder.settle();
          const market = await recorder.admitToMarket(receipt, receipt.statement.items[0].assetId);
          return { receipt, market };
        }
        case "prune": {
          const original = transport.pruneGrant;
          transport.pruneGrant = async (...args) => ({ ...await original(...args), authorization: "0".repeat(128) });
          const forged = await recorder.prune();
          transport.pruneGrant = original;
          const accepted = await recorder.prune();
          return { forged, accepted, snapshot: await recorder.snapshot() };
        }
      }
    } finally { recorder.close(); }
  };
  try {
    await page.goto("/");
    expect(await page.evaluate(operation, { ...options, action: "record" as const })).toEqual(["stored", "stored"]);
    await page.reload();
    now = ticket.commitNotBefore;
    await page.evaluate(operation, { ...options, action: "commit" as const });
    now = ticket.releaseAt;
    const completed = await page.evaluate(operation, { ...options, action: "settle" as const }) as {
      receipt: EncounterReceipt; market: { accepted: boolean; assetId: string };
    };
    expect(completed.receipt.statement.items).toHaveLength(1);
    expect(completed.market).toEqual({ accepted: true, assetId: completed.receipt.statement.items[0].assetId });
    now = completed.receipt.statement.retentionUntil;
    const result = await page.evaluate(operation, { ...options, action: "prune" as const }) as {
      forged: string; accepted: string; snapshot: { usedBytes: number };
    };
    expect(result.forged).toBe("refused");
    expect(result.accepted).toBe("pruned");
    expect(result.snapshot.usedBytes).toBe(0);
  } finally { db.close(); }
});
