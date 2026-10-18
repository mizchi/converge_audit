import { env } from "cloudflare:workers";
import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { expect, it } from "vitest";
import type { Env } from "../src/index.ts";
import { createStandardWebCryptoBackend } from "../../player-local-runtime/crypto-backend.ts";
import {
  EncounterAuthority, SqliteEncounterLedger, createEncounterChunks, signEncounterCommit,
} from "../game/encounter/index.ts";

it("the real Durable Object SQLite adapter pins one start, rejects stale writes and persists finality through eviction", async () => {
  const auditEnv = env as unknown as Env;
  const stub = auditEnv.AUDIT_SHARD.get(auditEnv.AUDIT_SHARD.idFromName(`encounter:${crypto.randomUUID()}`));
  const saved = await runInDurableObject(stub, async (_instance, state) => {
    // Structural compatibility is checked by TypeScript and real workerd SQL.
    const ledger = new SqliteEncounterLedger(state.storage.sql);
    const backend = createStandardWebCryptoBackend(crypto);
    const signer = (await backend.generateSigningKey()).signer;
    const owner = (await backend.generateSigningKey()).signer;
    let now = 1_000;
    const authority = new EncounterAuthority({ ledger, signer, crypto, now: () => now, retentionMs: 10_000 });
    const authorization = { unit: "workerd", startHead: "trusted-admission", playerId: "alice", ownerPublicKey: owner.publicKey };
    const [ticket, retry] = await Promise.all([authority.issue(authorization), authority.issue(authorization)]);
    expect(retry).toEqual(ticket);
    const inputs = Array.from({ length: 60 }, (_, i) => ({ tick: i + 1,
      horizontal: (i >= 30 && i < 40 ? 1 : 0) as 0 | 1, vertical: 0 as const }));
    const chunks = await createEncounterChunks(ticket, inputs, backend);
    now = ticket.commitNotBefore;
    await authority.commit(await signEncounterCommit(ticket, chunks, owner, backend));
    now = ticket.releaseAt;
    await authority.reveal(ticket.ticketId);
    const receipt = await authority.settle(ticket.ticketId, chunks);
    const before = ledger.byId(ticket.ticketId)!;
    expect(ledger.replace(before.revision, { ...before, revision: before.revision + 1, evidenceHold: true })).toBe(true);
    expect(ledger.replace(before.revision, { ...before, revision: before.revision + 1, phase: "issued" })).toBe(false);
    expect(ledger.byId(ticket.ticketId)!.phase).toBe("settled");
    await state.storage.sync();
    return { ticketId: ticket.ticketId, startKey: before.startKey, receiptId: receipt.receiptId };
  });
  await evictDurableObject(stub);
  await runInDurableObject(stub, (_instance, state) => {
    const ledger = new SqliteEncounterLedger(state.storage.sql);
    expect(ledger.byStart(saved.startKey)!.ticket.ticketId).toBe(saved.ticketId);
    expect(ledger.byId(saved.ticketId)!.receipt!.receiptId).toBe(saved.receiptId);
    expect(ledger.byId(saved.ticketId)!.evidenceHold).toBe(true);
  });
});

it("Durable Object SQLite preserves terminality and closed retention through eviction", async () => {
  const e = env as unknown as Env;
  const stub = e.AUDIT_SHARD.get(e.AUDIT_SHARD.idFromName(`terminal:${crypto.randomUUID()}`));
  const saved = await runInDurableObject(stub, async (_instance, state) => {
    const ledger = new SqliteEncounterLedger(state.storage.sql);
    const backend = createStandardWebCryptoBackend(crypto);
    const signer = (await backend.generateSigningKey()).signer;
    const owner = (await backend.generateSigningKey()).signer;
    let now = 1_000;
    const authority = new EncounterAuthority({ ledger, signer, crypto, now: () => now, retentionMs: 10_000 });
    const ticket = await authority.issue({ unit: "terminal", startHead: "earned", playerId: "alice", ownerPublicKey: owner.publicKey });
    const termination = await authority.terminate(ticket.ticketId, "abandoned");
    await expect(authority.closureGrant(ticket.ticketId, 2, 1)).rejects.toThrow(/retention/);
    now = termination.statement.retentionUntil;
    authority.setEvidenceHold(ticket.ticketId, true);
    await expect(authority.closureGrant(ticket.ticketId, 2, 1)).rejects.toThrow(/hold/);
    authority.setEvidenceHold(ticket.ticketId, false);
    expect((await authority.closureGrant(ticket.ticketId, 2, 1)).closureId).toBe(termination.terminationId);
    expect(() => authority.setEvidenceHold(ticket.ticketId, true)).toThrow(/closed/);
    await state.storage.sync();
    return { ticketId: ticket.ticketId, terminationId: termination.terminationId };
  });
  await evictDurableObject(stub);
  await runInDurableObject(stub, (_instance, state) => {
    const row = new SqliteEncounterLedger(state.storage.sql).byId(saved.ticketId)!;
    expect(row.phase).toBe("forfeited"); expect(row.receipt).toBeUndefined();
    expect(row.termination!.terminationId).toBe(saved.terminationId);
    expect(row.retentionReleased).toBe(true);
  });
});
