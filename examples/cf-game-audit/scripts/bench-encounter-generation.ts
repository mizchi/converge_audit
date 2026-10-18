import { DatabaseSync } from "node:sqlite";
import { createStandardWebCryptoBackend } from "../../player-local-runtime/crypto-backend.ts";
import { EncounterAuthority, SqliteEncounterLedger, createEncounterChunks, signEncounterCommit } from "../game/encounter/index.ts";
import { SqliteEncounterArchive } from "../game/encounter/archive-store.ts";
import { EncounterHttpApi } from "../src/encounter-api.ts";
const backend = createStandardWebCryptoBackend(crypto); const signer = (await backend.generateSigningKey()).signer;
const owner = (await backend.generateSigningKey()).signer; const rounds = 20; const warmup = 3;
const storage = () => {
  const db = new DatabaseSync(":memory:");
  const sql = { exec(query: string, ...args: (string | number | null)[]) { const rows = db.prepare(query).all(...args); return { toArray: () => rows }; } };
  const transaction = <T>(body: () => T): T => { db.exec("BEGIN"); try { const r = body(); db.exec("COMMIT"); return r; } catch (e) { db.exec("ROLLBACK"); throw e; } };
  return { db, sql, transaction };
};
const template = storage(); let now = 1_000;
const archive = new SqliteEncounterArchive({ ...template, signer, trustedAuthorityKey: signer.publicKey, crypto, now: () => now });
const ledger = new SqliteEncounterLedger(template.sql);
const authority = new EncounterAuthority({ ledger, signer, crypto, now: () => now, retentionMs: 0, trustedArchiveKey: archive.publicKey });
const inputs = Array.from({ length: 60 }, (_, i) => ({ tick: i + 1, horizontal: (i >= 30 && i < 40 ? 1 : 0) as 0 | 1, vertical: 0 as const }));
const sources = [];
try {
  for (let i = 0; i < 1_024; i++) {
    const authorization = { unit: "benchmark", startHead: `earned-${i}`, playerId: "alice", ownerPublicKey: owner.publicKey };
    const ticket = await authority.issue(authorization); const chunks = await createEncounterChunks(ticket, inputs, backend);
    const commitment = await signEncounterCommit(ticket, chunks, owner, backend);
    now = ticket.commitNotBefore; await authority.commit(commitment); now = ticket.releaseAt; const reveal = await authority.reveal(ticket.ticketId);
    const receipt = await authority.settle(ticket.ticketId, chunks);
    if (i < 128) {
      await authority.acceptArchive(ticket.ticketId, await archive.store({ ticket, commitment, reveal, receipt, chunks }));
      await archive.release(await authority.archiveRelease(ticket.ticketId));
    } else await authority.pruneGrant(ticket.ticketId, 0);
    sources.push({ authorization, row: ledger.byId(ticket.ticketId)! });
  }
  const tombstones = template.sql.exec("SELECT ticket_id, custody, stored_bytes, release FROM encounter_archive_objects_v1").toArray();
  const results = [];
  for (const batchSize of [16, 128, 1_024]) {
    const samples: number[] = []; let bytes = {};
    for (let round = 0; round < rounds + warmup; round++) {
      const sample = storage();
      try {
        const provider = new SqliteEncounterArchive({ ...sample, signer, trustedAuthorityKey: signer.publicKey, crypto, now: () => now });
        const api = new EncounterHttpApi({ ...sample, signer, crypto, archive: provider, now: () => now, retentionMs: 0, adminToken: "bench-admin" });
        for (const source of sources.slice(0, batchSize)) {
          const r = source.row;
          sample.sql.exec("INSERT INTO encounter_tickets_v1 VALUES (?, ?, ?, ?)", r.ticket.ticketId, r.startKey, r.revision, JSON.stringify(r));
          sample.sql.exec("INSERT INTO encounter_admissions_v2 VALUES (?, 0, ?, ?)", "benchmark", source.authorization.startHead, JSON.stringify(source.authorization));
        }
        const selected = new Set(sources.slice(0, batchSize).map((s) => s.row.ticket.ticketId));
        for (const t of tombstones.filter((t) => selected.has(t.ticket_id as string))) sample.sql.exec("INSERT INTO encounter_archive_objects_v1 (ticket_id, custody, bundle, stored_bytes, release, generation) VALUES (?, ?, NULL, ?, ?, 0)", t.ticket_id as string, t.custody as string, t.stored_bytes as number, t.release as string);
        sample.sql.exec("UPDATE encounter_archive_budget_v1 SET total_objects = ? WHERE id = 1", Math.min(batchSize, 128));
        const before = sample.sql.exec("SELECT SUM(length(CAST(data AS BLOB))) AS bytes FROM encounter_tickets_v1").toArray()[0].bytes;
        const start = performance.now();
        const response = await api.fetch(new Request("https://test/v1/pve/benchmark/encounter-generation", { method: "POST", headers: { authorization: "Bearer bench-admin" }, body: JSON.stringify({ expectedGeneration: 0 }) }));
        const elapsed = performance.now() - start;
        if (response.status !== 200) throw new Error(`rollover HTTP ${response.status}`);
        const sealText = await response.text();
        if (round >= warmup) samples.push(elapsed);
        bytes = { hotBefore: before, coldOriginsAfter: sample.sql.exec("SELECT SUM(length(CAST(data AS BLOB))) AS bytes FROM encounter_origins_v1").toArray()[0].bytes,
          seal: new TextEncoder().encode(sealText).byteLength, reclaimedArchiveObjects: Math.min(batchSize, 128), archiveObjectsAfter: provider.snapshot().totalObjects };
      } finally { sample.db.close(); }
    }
    samples.sort((a, b) => a - b);
    results.push({ batchSize, p50Ms: samples[Math.floor(samples.length * 0.5)], p95Ms: samples[Math.floor(samples.length * 0.95)], bytes });
  }
  console.log(JSON.stringify({ benchmark: "encounter-generation-v1", rounds, warmup, coldOriginsBeforeEachSample: 0,
    environment: { node: process.version, platform: process.platform, arch: process.arch, storage: "SQLite :memory:", networkIncluded: false, fsyncIncluded: false, workerSchedulingIncluded: false }, results }, null, 2));
} finally { template.db.close(); }
