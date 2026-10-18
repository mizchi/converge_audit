import { env } from "cloudflare:workers";
import { SELF, evictDurableObject } from "cloudflare:test";
import { expect, it } from "vitest";
import type { Env } from "../src/index.ts";
import { createStandardWebCryptoBackend } from "../../player-local-runtime/crypto-backend.ts";
import { signEncounterRequest } from "../game/encounter/http-wire.ts";
import { verifyEncounterTicket } from "../game/encounter/wire.ts";
import type { EncounterTicket, EncounterTermination } from "../game/encounter/contracts.ts";
import { verifyEncounterTermination } from "../game/encounter/wire.ts";

it("Worker authenticates starts, persists the same signed ticket across DO eviction and rate-limits invalid callers", async () => {
  const e = env as unknown as Env;
  const unit = `http-${crypto.randomUUID()}`;
  const endpoint = `https://example.com/v1/pve/${unit}/encounter`;
  const backend = createStandardWebCryptoBackend(crypto);
  const owner = (await backend.generateSigningKey()).signer;
  const admission = { unit, startHead: "earned-start", playerId: "alice", ownerPublicKey: owner.publicKey };
  const fully = async (url: string, init: RequestInit) => {
    const response = await SELF.fetch(url, init);
    return new Response(await response.text(), { status: response.status, headers: response.headers });
  };
  const provision = (token: string) => fully(`${endpoint}-admissions`, { method: "POST",
    headers: { authorization: `Bearer ${token}` }, body: JSON.stringify(admission) });
  expect((await provision("wrong")).status).toBe(401);
  expect((await provision(e.ADMIN_TOKEN)).status).toBe(201);
  const request = await signEncounterRequest(unit, { op: "start", startHead: admission.startHead }, owner, backend, Date.now());
  const send = (body: unknown = request) => fully(endpoint, { method: "POST",
    headers: { "cf-connecting-ip": "192.0.2.10" }, body: JSON.stringify(body) });
  expect((await send({ ...request, signature: "0".repeat(128) })).status).toBe(401);
  const response = await send(); expect(response.status).toBe(200);
  const ticket = await response.json<EncounterTicket>();
  expect(await verifyEncounterTicket(ticket, e.ENCOUNTER_SIGNING_PUBLIC_KEY!, backend)).toBe(true);
  expect("secret" in ticket).toBe(false);
  const stub = e.AUDIT_SHARD.get(e.AUDIT_SHARD.idFromName(`pve:${unit}`));
  await evictDurableObject(stub);
  expect(await (await send()).json()).toEqual(ticket);
  const stranger = (await backend.generateSigningKey()).signer;
  expect((await send(await signEncounterRequest(unit, request.command, stranger, backend, Date.now()))).status).toBe(403);
  // Four attempts above; the same per-source bucket survives object eviction.
  for (let i = 4; i < 30; i++) expect((await send({})).status).toBe(400);
  const limited = await send({}); expect(limited.status).toBe(429);
  expect(limited.headers.get("retry-after")).not.toBeNull();
});

it("Worker requires owner signatures to terminate, preserves one certificate and refuses early terminal cleanup", async () => {
  const e = env as unknown as Env;
  const unit = `terminal-${crypto.randomUUID()}`;
  const endpoint = `https://example.com/v1/pve/${unit}/encounter`;
  const backend = createStandardWebCryptoBackend(crypto);
  const owner = (await backend.generateSigningKey()).signer;
  const stranger = (await backend.generateSigningKey()).signer;
  const admission = { unit, startHead: "earned", playerId: "alice", ownerPublicKey: owner.publicKey };
  const provision = await SELF.fetch(`${endpoint}-admissions`, { method: "POST", headers: { authorization: `Bearer ${e.ADMIN_TOKEN}` }, body: JSON.stringify(admission) });
  expect(provision.status).toBe(201); await provision.text();
  const send = async (command: Parameters<typeof signEncounterRequest>[1], key = owner) => {
    const response = await SELF.fetch(endpoint, { method: "POST", body: JSON.stringify(await signEncounterRequest(unit, command, key, backend, Date.now())) });
    return new Response(await response.text(), { status: response.status });
  };
  const ticket = await (await send({ op: "start", startHead: admission.startHead })).json<EncounterTicket>();
  const command = { op: "terminate" as const, ticketId: ticket.ticketId, reason: "abandoned" as const };
  expect((await send(command, stranger)).status).toBe(403);
  const certificate = await (await send(command)).json<EncounterTermination>();
  expect(await verifyEncounterTermination(ticket, certificate, e.ENCOUNTER_SIGNING_PUBLIC_KEY!, backend)).toBe(true);
  const stub = e.AUDIT_SHARD.get(e.AUDIT_SHARD.idFromName(`pve:${unit}`)); await evictDurableObject(stub);
  expect(await (await send({ ...command, reason: "expired" })).json()).toEqual(certificate);
  expect((await send({ op: "closure", ticketId: ticket.ticketId, expectedRevision: 1, nextSequence: 0 })).status).toBe(409);
  expect((await send({ op: "receipt", ticketId: ticket.ticketId })).status).toBe(409);
});
