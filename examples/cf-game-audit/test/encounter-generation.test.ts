import { env } from "cloudflare:workers";
import { SELF, evictDurableObject, runInDurableObject } from "cloudflare:test";
import { expect, it } from "vitest";
import type { Env } from "../src/index.ts";
import { createStandardWebCryptoBackend } from "../../player-local-runtime/crypto-backend.ts";
import { EncounterAuthority, SqliteEncounterLedger, createEncounterChunks, signEncounterCommit, signEncounterListing } from "../game/encounter/index.ts";
import { signEncounterRequest, wireChunks, type EncounterCommand } from "../game/encounter/http-wire.ts";
import { verifyGenerationSeal } from "../game/encounter/generation.ts";

it("an owner-released forfeit is deleted and its signed retry survives a real Durable Object eviction", async () => {
  const e = env as unknown as Env; const unit = `recovery-${crypto.randomUUID()}`;
  const stub = e.AUDIT_SHARD.get(e.AUDIT_SHARD.idFromName(`pve:${unit}`));
  const backend = createStandardWebCryptoBackend(crypto); const owner = (await backend.generateSigningKey()).signer;
  const drained = async (pending: Promise<Response>) => { const r = await pending; return new Response(await r.text(), { status: r.status }); };
  const admin = (action: string, body: unknown) => drained(SELF.fetch(`https://example.test/v1/pve/${unit}/${action}`, {
    method: "POST", headers: { authorization: `Bearer ${e.ADMIN_TOKEN}` }, body: JSON.stringify(body) }));
  const command = async (c: EncounterCommand) => drained(SELF.fetch(`https://example.test/v1/pve/${unit}/encounter`, {
    method: "POST", body: JSON.stringify(await signEncounterRequest(unit, c, owner, backend, Date.now())) }));
  const authorization = { unit, startHead: "stopped", playerId: "alice", ownerPublicKey: owner.publicKey };
  expect((await admin("encounter-admissions", authorization)).status).toBe(201);
  const proof = await runInDurableObject(stub, async (_instance, state) => {
    const signer = (await backend.importLegacySeed(e.ENCOUNTER_SIGNING_SEED_HEX!, e.ENCOUNTER_SIGNING_PUBLIC_KEY!)).signer;
    const authority = new EncounterAuthority({ ledger: new SqliteEncounterLedger(state.storage.sql), signer, crypto, now: () => 1_000, retentionMs: 0 });
    const ticket = await authority.issue(authorization); const termination = await authority.terminate(ticket.ticketId, "abandoned");
    await authority.closureGrant(ticket.ticketId, 0, 0); await state.storage.sync(); return { ticket, termination };
  });
  const ack = await command({ op: "release-recovery", ...proof }); expect(ack.status).toBe(200);
  const expected = await ack.json();
  expect((await admin("encounter-generation", { expectedGeneration: 0 })).status).toBe(200);
  await evictDurableObject(stub);
  const retry = await command({ op: "release-recovery", ...proof }); expect(retry.status).toBe(200); expect(await retry.json()).toEqual(expected);
  expect((await command({ op: "start", startHead: "stopped" })).status).toBe(403);
  expect((await command({ op: "status", ticketId: proof.ticket.ticketId })).status).toBe(403);
  const counts = await runInDurableObject(stub, (_instance, state) => ({
    hot: state.storage.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM encounter_tickets_v1").toArray()[0].n,
    cold: state.storage.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM encounter_origins_v1").toArray()[0].n,
    floor: state.storage.sql.exec<{ minimum_generation: number }>("SELECT minimum_generation FROM encounter_generation_floors_v1 WHERE unit = ?", unit).toArray()[0].minimum_generation,
  }));
  expect(counts).toEqual({ hot: 0, cold: 0, floor: 1 });
});

it("the admin generation route durably recycles archive and admission slots while old origins survive DO eviction", async () => {
  const e = env as unknown as Env; const unit = `generation-${crypto.randomUUID()}`;
  const stub = e.AUDIT_SHARD.get(e.AUDIT_SHARD.idFromName(`pve:${unit}`));
  const backend = createStandardWebCryptoBackend(crypto); const owner = (await backend.generateSigningKey()).signer;
  // Drain actual fetch bodies before eviction; an open response stream keeps
  // the Durable Object request alive in the Workers test harness.
  const drained = async (pending: Promise<Response>) => { const r = await pending; return new Response(await r.text(), { status: r.status, headers: r.headers }); };
  const admin = async (action: string, body: unknown, authorized = true) => drained(SELF.fetch(`https://example.test/v1/pve/${unit}/${action}`, {
    method: "POST", headers: authorized ? { authorization: `Bearer ${e.ADMIN_TOKEN}` } : {}, body: JSON.stringify(body) }));
  const command = async (c: EncounterCommand) => drained(SELF.fetch(`https://example.test/v1/pve/${unit}/encounter`, { method: "POST", body: JSON.stringify(await signEncounterRequest(unit, c, owner, backend, Date.now())) }));
  const settle = async (generation: number) => {
    const authorization = { unit, startHead: "earned", playerId: "alice", ownerPublicKey: owner.publicKey, ...(generation > 0 ? { generation } : {}) };
    expect((await admin("encounter-admissions", authorization)).status).toBe(201);
    return runInDurableObject(stub, async (_instance, state) => {
      const signer = (await backend.importLegacySeed(e.ENCOUNTER_SIGNING_SEED_HEX!, e.ENCOUNTER_SIGNING_PUBLIC_KEY!)).signer; let now = 1_000;
      const authority = new EncounterAuthority({ ledger: new SqliteEncounterLedger(state.storage.sql), signer, crypto, now: () => now, retentionMs: 0,
        currentGeneration: () => state.storage.sql.exec<{ generation: number }>("SELECT generation FROM encounter_generations_v1 WHERE unit = ?", unit).toArray()[0]?.generation ?? 0 });
      const ticket = await authority.issue(authorization);
      const frames = Array.from({ length: 60 }, (_, i) => ({ tick: i + 1, horizontal: (i >= 30 && i < 40 ? 1 : 0) as 0 | 1, vertical: 0 as const }));
      const chunks = await createEncounterChunks(ticket, frames, backend);
      now = ticket.commitNotBefore; await authority.commit(await signEncounterCommit(ticket, chunks, owner, backend));
      now = ticket.releaseAt; await authority.reveal(ticket.ticketId); const receipt = await authority.settle(ticket.ticketId, chunks);
      await state.storage.sync(); return { ticket, receipt, chunks };
    });
  };
  const first = await settle(0);
  expect((await admin("encounter-generation", { expectedGeneration: 0 }, false)).status).toBe(401);
  expect((await admin("encounter-generation", { expectedGeneration: 0 })).status).toBe(409);
  expect((await command({ op: "archive-upload", ticketId: first.ticket.ticketId, chunks: wireChunks(first.chunks) })).status).toBe(200);
  expect((await command({ op: "archive-release", ticketId: first.ticket.ticketId })).status).toBe(200);
  const response = await admin("encounter-generation", { expectedGeneration: 0 }); expect(response.status).toBe(200);
  const seal = await response.json(); expect(await verifyGenerationSeal(seal, e.ENCOUNTER_SIGNING_PUBLIC_KEY!, backend)).toBe(true);
  await evictDurableObject(stub);
  const recovered = await command({ op: "start", startHead: "earned" }); expect(recovered.status).toBe(200);
  expect((await recovered.json<{ ticketId: string }>()).ticketId).toBe(first.ticket.ticketId);
  const listing = await signEncounterListing(first.receipt, first.receipt.statement.items[0].assetId, owner, backend);
  expect((await command({ op: "market", listing })).status).toBe(200);
  const second = await settle(1); expect(second.ticket.generation).toBe(1); expect(second.ticket.queueId).not.toBe(first.ticket.queueId);
  expect((await command({ op: "archive-upload", ticketId: second.ticket.ticketId, chunks: wireChunks(second.chunks) })).status).toBe(200);
  expect((await command({ op: "archive-release", ticketId: second.ticket.ticketId })).status).toBe(200);
  expect((await admin("encounter-generation", { expectedGeneration: 1 })).status).toBe(200);
  await evictDurableObject(stub);
  const cp = await command({ op: "inventory-compact", expectedCheckpointId: null, ticketIds: [first.ticket.ticketId, second.ticket.ticketId] });
  expect(cp.status).toBe(200); expect(await cp.json()).toMatchObject({ statement: { receiptCount: 2, itemCount: 2 } });
  const persisted = await runInDurableObject(stub, (_instance, state) => ({
    hot: state.storage.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM encounter_tickets_v1").toArray()[0].n,
    origins: state.storage.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM encounter_origins_v1").toArray()[0].n,
    archive: state.storage.sql.exec<{ total_objects: number }>("SELECT total_objects FROM encounter_archive_budget_v1").toArray()[0].total_objects,
  }));
  expect(persisted).toEqual({ hot: 0, origins: 2, archive: 0 });
});
