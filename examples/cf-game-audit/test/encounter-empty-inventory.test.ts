import { env } from "cloudflare:workers";
import { SELF, evictDurableObject, runInDurableObject } from "cloudflare:test";
import { expect, it } from "vitest";
import type { Env } from "../src/index.ts";
import { createStandardWebCryptoBackend } from "../../player-local-runtime/crypto-backend.ts";
import { EncounterAuthority, SqliteEncounterLedger, createEncounterChunks, signEncounterCommit, signEncounterListing } from "../game/encounter/index.ts";
import { signEncounterRequest, type EncounterCommand } from "../game/encounter/http-wire.ts";
import { validInventoryPage, verifyInventoryCheckpoint, type InventoryCheckpoint } from "../game/encounter/inventory-checkpoint.ts";

it("empty retirement, sparse pages and original-item market admission survive actual DO eviction", async () => {
  const e = env as unknown as Env; const unit = `empty-${crypto.randomUUID()}`;
  const stub = e.AUDIT_SHARD.get(e.AUDIT_SHARD.idFromName(`pve:${unit}`));
  const backend = createStandardWebCryptoBackend(crypto); const owner = (await backend.generateSigningKey()).signer;
  const drained = async (pending: Promise<Response>) => { const r = await pending; return new Response(await r.text(), { status: r.status }); };
  const admin = (action: string, body: unknown) => drained(SELF.fetch(`https://example.test/v1/pve/${unit}/${action}`, {
    method: "POST", headers: { authorization: `Bearer ${e.ADMIN_TOKEN}` }, body: JSON.stringify(body) }));
  const command = async (c: EncounterCommand) => drained(SELF.fetch(`https://example.test/v1/pve/${unit}/encounter`, {
    method: "POST", body: JSON.stringify(await signEncounterRequest(unit, c, owner, backend, Date.now())) }));
  const results = [];
  for (let i = 0; i < 3; i++) {
    const authorization = { unit, startHead: `start-${i}`, playerId: "alice", ownerPublicKey: owner.publicKey };
    expect((await admin("encounter-admissions", authorization)).status).toBe(201);
    results.push(await runInDurableObject(stub, async (_instance, state) => {
      const signer = (await backend.importLegacySeed(e.ENCOUNTER_SIGNING_SEED_HEX!, e.ENCOUNTER_SIGNING_PUBLIC_KEY!)).signer; let now = 1_000;
      const authority = new EncounterAuthority({ ledger: new SqliteEncounterLedger(state.storage.sql), signer, crypto, now: () => now, retentionMs: 0 });
      const ticket = await authority.issue(authorization);
      const chunks = await createEncounterChunks(ticket, Array.from({ length: 60 }, (_, tick) => ({ tick: tick + 1, horizontal: (i === 1 && tick >= 30 && tick < 40 ? 1 : 0) as 0 | 1, vertical: 0 as const })), backend);
      now = ticket.commitNotBefore; await authority.commit(await signEncounterCommit(ticket, chunks, owner, backend));
      now = ticket.releaseAt; await authority.reveal(ticket.ticketId); const receipt = await authority.settle(ticket.ticketId, chunks);
      await authority.pruneGrant(ticket.ticketId, 0); await state.storage.sync(); return { ticket, receipt };
    }));
  }
  const initial = await command({ op: "inventory-compact", expectedCheckpointId: null, ticketIds: results.map((r) => r.ticket.ticketId) });
  expect(initial.status).toBe(200); const cp = await initial.json<InventoryCheckpoint>();
  expect((await admin("encounter-generation", { expectedGeneration: 0 })).status).toBe(200);
  const request: EncounterCommand = { op: "inventory-retire-empty", expectedCheckpointId: cp.checkpointId, ticketIds: [results[0].ticket.ticketId, results[2].ticket.ticketId] };
  const response = await command(request); expect(response.status).toBe(200); const retired = await response.json<InventoryCheckpoint>();
  expect(await verifyInventoryCheckpoint(retired, e.ENCOUNTER_SIGNING_PUBLIC_KEY!, backend)).toBe(true);
  await evictDurableObject(stub); expect(await (await command(request)).json()).toEqual(retired);
  const page = await (await command({ op: "inventory-page", checkpointId: retired.checkpointId, after: 0 })).json();
  expect(validInventoryPage(page, retired, 0)).toBe(true); expect(page).toMatchObject({ positions: [2], emptyRanges: [{ first: 1, last: 1 }, { first: 3, last: 3 }], next: null });
  const reward = results[1]; const listing = await signEncounterListing(reward.receipt, reward.receipt.statement.items[0].assetId, owner, backend);
  expect((await command({ op: "market", listing })).status).toBe(200);
  expect((await command({ op: "start", startHead: "start-0" })).status).toBe(403);
  const counts = await runInDurableObject(stub, (_instance, state) => ({
    origins: state.storage.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM encounter_origins_v1").toArray()[0].n,
    members: state.storage.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM encounter_inventory_members_v1").toArray()[0].n,
    ranges: state.storage.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM encounter_inventory_empty_ranges_v1").toArray()[0].n,
  }));
  expect(counts).toEqual({ origins: 1, members: 1, ranges: 2 });
});
