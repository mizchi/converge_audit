import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { createStandardWebCryptoBackend } from "../../player-local-runtime/crypto-backend.ts";
import { EncounterHttpApi } from "../src/encounter-api.ts";
import { HttpEncounterTransport } from "../web/src/audit/encounter-http.ts";

const db = new DatabaseSync(":memory:"); const backend = createStandardWebCryptoBackend(crypto);
const signer = (await backend.generateSigningKey()).signer; const owner = (await backend.generateSigningKey()).signer;
const sql = { exec(query: string, ...args: (string | number | null)[]) {
  const rows = db.prepare(query).all(...args); return { toArray: () => rows };
} };
const transaction = <T>(body: () => T): T => { db.exec("BEGIN"); try { const value = body(); db.exec("COMMIT"); return value; } catch (e) { db.exec("ROLLBACK"); throw e; } };
let now = 1_000;
const api = new EncounterHttpApi({ sql, signer, crypto, transaction, now: () => now, retentionMs: 0, adminToken: "bench" });
const transport = new HttpEncounterTransport({ endpoint: "https://test/v1/pve/benchmark/encounter", unit: "benchmark", owner, cryptoBackend: backend, now: () => now,
  fetch: async (url, init) => api.fetch(new Request(url, init)) });
const admin = async (action: string, body: unknown) => {
  const response = await api.fetch(new Request(`https://test/v1/pve/benchmark/${action}`, { method: "POST", headers: { authorization: "Bearer bench" }, body: JSON.stringify(body) }));
  assert.equal(response.status, 200); return response.text();
};
const percentile = (samples: number[]) => { const sorted = [...samples].sort((a, b) => a - b); return { samples: samples.length, p50Ms: sorted[Math.floor(sorted.length * .5)], p95Ms: sorted[Math.floor(sorted.length * .95)] }; };
const rounds = 20; const warmup = 1; const batchSize = 128; const release: number[] = []; const roll: number[] = [];
let hotBytesBeforeRoll = 0; let proofBytes = 0; let releaseBytes = 0;
try {
  for (let generation = 0; generation < rounds + warmup; generation++) {
    now = 1_000 + generation * 100_000;
    for (let i = 0; i < batchSize; i++) {
      const startHead = `earned-${i}`;
      const response = await api.fetch(new Request("https://test/v1/pve/benchmark/encounter-admissions", { method: "POST", headers: { authorization: "Bearer bench" },
        body: JSON.stringify({ unit: "benchmark", startHead, playerId: "alice", ownerPublicKey: owner.publicKey, ...(generation > 0 ? { generation } : {}) }) }));
      assert.equal(response.status, 201); await response.text();
      const ticket = await transport.start(startHead, generation); const termination = await transport.terminate(ticket.ticketId, "abandoned");
      await transport.closureGrant(ticket.ticketId, 0, 0);
      const start = performance.now(); const ack = await transport.releaseRecovery(ticket, termination); const elapsed = performance.now() - start;
      if (generation >= warmup) release.push(elapsed);
      proofBytes = Math.max(proofBytes, new TextEncoder().encode(JSON.stringify({ ticket, termination })).byteLength);
      releaseBytes = Math.max(releaseBytes, new TextEncoder().encode(JSON.stringify(ack)).byteLength);
    }
    hotBytesBeforeRoll = sql.exec("SELECT SUM(length(CAST(data AS BLOB))) AS n FROM encounter_tickets_v1").toArray()[0].n as number;
    const start = performance.now(); await admin("encounter-generation", { expectedGeneration: generation });
    if (generation >= warmup) roll.push(performance.now() - start);
    assert.equal(sql.exec("SELECT COUNT(*) AS n FROM encounter_tickets_v1").toArray()[0].n, 0);
    assert.equal(sql.exec("SELECT COUNT(*) AS n FROM encounter_origins_v1").toArray()[0].n, 0);
    assert.equal(sql.exec("SELECT COUNT(*) AS n FROM encounter_admissions_v2").toArray()[0].n, 0);
  }
  console.log(JSON.stringify({ benchmark: "encounter-recovery-release-v1", rounds, warmup, batchSize, totalForfeits: (rounds + warmup) * batchSize,
    environment: { node: process.version, platform: process.platform, arch: process.arch, storage: "SQLite :memory:",
      inProcessSignedHttpIncluded: true, networkIncluded: false, fsyncIncluded: false, workerSchedulingIncluded: false, caseBindings: 0, retainedOrigins: 0 },
    release: percentile(release), roll: percentile(roll), bytes: { maxProof: proofBytes, maxAcknowledgment: releaseBytes, hotJsonBeforeLastRoll: hotBytesBeforeRoll, coldJsonAfterRoll: 0 },
    retainedRows: { hot: 0, origins: 0, admissions: 0,
      generationHeads: sql.exec("SELECT COUNT(*) AS n FROM encounter_generations_v1").toArray()[0].n,
      generationFloors: sql.exec("SELECT COUNT(*) AS n FROM encounter_generation_floors_v1").toArray()[0].n },
  }, null, 2));
} finally { db.close(); }
