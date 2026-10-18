import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { IDBFactory } from "fake-indexeddb";
import { createStandardWebCryptoBackend } from "../../player-local-runtime/crypto-backend.ts";
import { EncounterHttpApi } from "../src/encounter-api.ts";
import { HttpEncounterTransport } from "../web/src/audit/encounter-http.ts";
import { EncounterRecorder } from "../web/src/audit/encounter-recorder.ts";
import { IndexedDbAuditPayloadPool } from "../web/src/audit/payload-pool.ts";
import { signEncounterRequest } from "../game/encounter/http-wire.ts";

async function fixture() {
  const db = new DatabaseSync(":memory:");
  const sql = { exec(query: string, ...bindings: (string | number | null)[]) {
    const rows = db.prepare(query).all(...bindings);
    return { toArray: () => rows };
  } };
  const backend = createStandardWebCryptoBackend(crypto);
  const signer = (await backend.generateSigningKey()).signer;
  const owner = (await backend.generateSigningKey()).signer;
  let now = 1_000;
  const restart = () => new EncounterHttpApi({ sql, signer, crypto, adminToken: "admin",
    now: () => now, retentionMs: 10_000, maxAdmissions: 2 });
  let api = restart();
  const endpoint = "https://test/v1/pve/demo/encounter";
  const fetcher: typeof fetch = async (input, init) => api.fetch(new Request(input, init));
  const transport = new HttpEncounterTransport({ endpoint, unit: "demo", owner, cryptoBackend: backend,
    fetch: fetcher, now: () => now });
  const authorization = { unit: "demo", startHead: "trusted-start", playerId: "alice", ownerPublicKey: owner.publicKey };
  const provision = (body: unknown = authorization, token = "admin") => fetcher(`${endpoint}-admissions`, {
    method: "POST", headers: { authorization: `Bearer ${token}` }, body: JSON.stringify(body),
  });
  return { db, backend, signer, owner, endpoint, fetcher, transport, authorization, provision,
    setTime(t: number) { now = t; }, restart() { api = restart(); } };
}

test("the signed HTTP path records, settles, admits and prunes with a durable, single-use trusted start", async () => {
  const f = await fixture();
  try {
    assert.equal((await f.provision()).status, 201);
    assert.equal((await f.provision()).status, 200);
    const recorder = await EncounterRecorder.start({ factory: new IDBFactory(), authorization: f.authorization,
      owner: f.owner, cryptoBackend: f.backend, transport: f.transport, trustedAuthorityKey: f.signer.publicKey });
    const ticket = await f.transport.start(f.authorization.startHead);
    assert.equal(JSON.stringify(ticket).includes('"secret"'), false);
    const frames = Array.from({ length: 60 }, (_, i) => ({ tick: i + 1,
      horizontal: (i >= 30 && i < 40 ? 1 : 0) as 0 | 1, vertical: 0 as const }));
    await recorder.recordChunk(0, frames.slice(0, 30)); await recorder.recordChunk(1, frames.slice(30));
    f.setTime(ticket.commitNotBefore); await recorder.commit();
    f.restart(); f.setTime(ticket.releaseAt);
    const receipt = await recorder.settle();
    assert.equal(receipt.statement.items.length, 1);
    await recorder.admitToMarket(receipt, receipt.statement.items[0].assetId);
    f.setTime(receipt.statement.retentionUntil);
    assert.equal(await recorder.prune(), "pruned");
    assert.equal(await recorder.release(), "released");
    f.restart(); assert.deepEqual(await f.transport.start(f.authorization.startHead), ticket);
    assert.deepEqual(await EncounterRecorder.recoverReceipt({ ticket, transport: f.transport,
      trustedAuthorityKey: f.signer.publicKey, cryptoBackend: f.backend }), receipt);
    recorder.close();
  } finally { f.db.close(); }
});

test("signed HTTP abandonment releases partial logs and unused credits after retention, and a restart preserves its certificate", async () => {
  const f = await fixture(); const factory = new IDBFactory();
  const pool = await IndexedDbAuditPayloadPool.open({ factory, name: crypto.randomUUID(),
    limits: { maxBytes: 8_192, reservedBytes: 0, maxItems: 2, maxItemBytes: 4_096 }, maxQueues: 1 });
  try {
    await f.provision();
    const options = { factory, payloadPool: pool, authorization: f.authorization,
      owner: f.owner, cryptoBackend: f.backend, transport: f.transport, trustedAuthorityKey: f.signer.publicKey };
    let recorder = await EncounterRecorder.start(options);
    const frames = Array.from({ length: 30 }, (_, i) => ({ tick: i + 1, horizontal: 0 as const, vertical: 0 as const }));
    await recorder.recordChunk(0, frames);
    const certificate = await recorder.terminate("abandoned");
    await assert.rejects(recorder.recordChunk(1, frames.map((frame) => ({ ...frame, tick: frame.tick + 30 }))), /terminated/);
    await assert.rejects(recorder.cleanupTerminated(certificate), /409/);
    assert.equal((await pool.snapshot()).itemCount, 1);
    assert.equal((await pool.snapshot()).reservedItemCount, 1);
    recorder.close(); f.restart(); f.setTime(certificate.statement.retentionUntil);
    recorder = await EncounterRecorder.start(options);
    const recovered = await recorder.terminate("expired");
    assert.deepEqual(recovered, certificate);
    await assert.rejects(recorder.cleanupTerminated({ ...certificate, signature: "0".repeat(128) }), /termination/);
    assert.equal(await recorder.cleanupTerminated(certificate), "released");
    assert.equal((await pool.snapshot()).usedBytes, 0);
    assert.equal((await pool.snapshot()).reservedPayloadBytes, 0);
    assert.equal((await pool.snapshot()).reservedItemCount, 0);
    assert.equal((await pool.snapshot()).queueCount, 0);
    const retry = await f.transport.start(f.authorization.startHead);
    assert.equal(retry.ticketId, certificate.statement.ticketId);
    await assert.rejects(f.transport.reveal(retry.ticketId), /409/);
    recorder.close();
  } finally { pool.close(); f.db.close(); }
});

test("public callers cannot provision starts, impersonate owners, move signed requests or alter their arguments", async () => {
  const f = await fixture();
  try {
    assert.equal((await f.provision(undefined, "wrong")).status, 401);
    await assert.rejects(f.transport.start(f.authorization.startHead), /403/);
    await f.provision();
    const request = await signEncounterRequest("demo", { op: "start", startHead: f.authorization.startHead },
      f.owner, f.backend, 1_000);
    const send = (body: unknown, url = f.endpoint) => f.fetcher(url, { method: "POST", body: JSON.stringify(body) });
    assert.equal((await send({ ...request, command: { op: "start", startHead: "invented" } })).status, 401);
    assert.equal((await send(request, f.endpoint.replace("demo", "other"))).status, 401);
    const stranger = (await f.backend.generateSigningKey()).signer;
    assert.equal((await send(await signEncounterRequest("demo", request.command, stranger, f.backend, 1_000))).status, 403);
    const response = await send(request); assert.equal(response.status, 200);
    const ticket = await response.json() as { ticketId: string };
    assert.deepEqual(await (await send(request)).json(), ticket);
    assert.equal((await send(await signEncounterRequest("demo", { op: "reveal", ticketId: ticket.ticketId }, stranger, f.backend, 1_000))).status, 403);
    f.setTime(61_001); assert.equal((await send(request)).status, 401);
    f.setTime(Number.NaN); assert.equal((await send(request)).status, 503);
    assert.equal((await f.provision({ ...f.authorization, playerId: "mallory" })).status, 409);
  } finally { f.db.close(); }
});

test("HTTP decoding bounds body/chunks and admission metadata before verification or game execution", async () => {
  const f = await fixture();
  try {
    assert.equal((await f.fetcher(f.endpoint, { method: "POST", body: "x".repeat(16_385) })).status, 413);
    assert.equal((await f.fetcher(f.endpoint, { method: "POST", body: "{}" })).status, 400);
    await f.provision();
    assert.equal((await f.provision({ ...f.authorization, startHead: "second" })).status, 201);
    assert.equal((await f.provision({ ...f.authorization, startHead: "third" })).status, 429);
    const request = await signEncounterRequest("demo", { op: "start", startHead: "trusted-start" }, f.owner, f.backend, 1_000);
    const response = await f.fetcher(f.endpoint, { method: "POST", body: JSON.stringify({ ...request, extra: true }) });
    assert.equal(response.status, 400);
    const invalidChunk = { ...request, command: { op: "settle", ticketId: "missing",
      chunks: [0, 1].map((sequence) => ({ sequence, checkpointDigest: "a".repeat(64), payload: "YQ".repeat(2_800) })) } };
    assert.equal((await f.fetcher(f.endpoint, { method: "POST", body: JSON.stringify(invalidChunk) })).status, 400);
  } finally { f.db.close(); }
});

test("browser bootstrap exposes only public configuration and the owner's unspent starts; status never serializes private ledger data", async () => {
  const f = await fixture();
  try {
    const configResponse = await f.fetcher(`${f.endpoint}-configuration`);
    assert.equal(configResponse.status, 200);
    const config = await configResponse.json() as { authorityKey: string; serverNow: number };
    assert.equal(config.authorityKey, f.signer.publicKey); assert.equal(config.serverNow, 1_000);
    await f.provision();
    const stranger = (await f.backend.generateSigningKey()).signer;
    await f.provision({ ...f.authorization, startHead: "other-owner", ownerPublicKey: stranger.publicKey });
    assert.deepEqual(await f.transport.admissions(), [f.authorization]);
    const ticket = await f.transport.start(f.authorization.startHead);
    assert.deepEqual(await f.transport.admissions(), []);
    const status = await f.transport.status(ticket.ticketId);
    assert.equal(status.phase, "issued"); assert.equal(status.ticket.ticketId, ticket.ticketId);
    const text = JSON.stringify(status);
    assert.equal(text.includes('"secret"'), false); assert.equal(text.includes('"seed"'), false);
    const forged = await signEncounterRequest("demo", { op: "status", ticketId: ticket.ticketId }, stranger, f.backend, 1_000);
    assert.equal((await f.fetcher(f.endpoint, { method: "POST", body: JSON.stringify(forged) })).status, 403);
  } finally { f.db.close(); }
});
