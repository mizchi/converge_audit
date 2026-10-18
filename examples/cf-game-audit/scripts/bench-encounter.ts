import { DatabaseSync } from "node:sqlite";
import { createStandardWebCryptoBackend } from "../../player-local-runtime/crypto-backend.ts";
import {
  EncounterAuthority, SqliteEncounterLedger, createEncounterChunks,
  signEncounterCommit, signEncounterListing,
} from "../game/encounter/index.ts";

// CPU/service cost only. No network, fsync, browser quota or Worker scheduling.
const backend = createStandardWebCryptoBackend(crypto);
const signer = (await backend.generateSigningKey()).signer;
const owner = (await backend.generateSigningKey()).signer;
const db = new DatabaseSync(":memory:");
const ledger = new SqliteEncounterLedger({ exec(query, ...args) {
  const rows = db.prepare(query).all(...args);
  return { toArray: () => rows };
} });
let now = 1_000;
const authority = new EncounterAuthority({ ledger, signer, crypto, now: () => now, retentionMs: 10_000 });
const inputs = Array.from({ length: 60 }, (_, i) => ({ tick: i + 1,
  horizontal: (i >= 30 && i < 40 ? 1 : 0) as 0 | 1, vertical: 0 as const }));
const rounds = 200;
const warmup = 20;
const samples: Record<string, number[]> = {};
let measured = false;
async function timed<T>(name: string, operation: () => Promise<T>): Promise<T> {
  const start = performance.now();
  const value = await operation();
  if (measured) (samples[name] ??= []).push(performance.now() - start);
  return value;
}
const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).byteLength;
let transport = {};
try {
  for (let round = 0; round < rounds + warmup; round++) {
    measured = round >= warmup;
    now = 1_000 + round * 20_000;
    const ticket = await timed("issue", () => authority.issue({ unit: "benchmark", startHead: `start-${round}`,
      playerId: "alice", ownerPublicKey: owner.publicKey }));
    const chunks = await timed("encodeAndHashLog", () => createEncounterChunks(ticket, inputs, backend));
    const commitment = await signEncounterCommit(ticket, chunks, owner, backend);
    now = ticket.commitNotBefore;
    await timed("commit", () => authority.commit(commitment));
    now = ticket.releaseAt;
    await timed("reveal", () => authority.reveal(ticket.ticketId));
    const receipt = await timed("replayAndSettle60Ticks", () => authority.settle(ticket.ticketId, chunks));
    const item = receipt.statement.items[0];
    const listing = await signEncounterListing(receipt, item.assetId, owner, backend);
    await timed("marketAdmission", () => authority.admitToMarket(listing));
    await timed("settlementRetry", () => authority.settle(ticket.ticketId, []));
    now = receipt.statement.retentionUntil;
    const grant = await timed("prunePermit", () => authority.pruneGrant(ticket.ticketId, 2));
    transport = { rawLogBytes: chunks.reduce((n, c) => n + c.payload.byteLength, 0),
      chunkCount: chunks.length, receiptJsonBytes: bytes(receipt),
      listingRequestJsonBytes: bytes(listing), pruneGrantJsonBytes: bytes(grant),
      ledgerRowJsonBytes: bytes(ledger.byId(ticket.ticketId)) };
  }
  const timings = Object.fromEntries(Object.entries(samples).map(([name, values]) => {
    const ordered = [...values].sort((a, b) => a - b);
    return [name, { p50Ms: ordered[Math.floor(ordered.length * 0.5)], p95Ms: ordered[Math.floor(ordered.length * 0.95)] }];
  }));
  console.log(JSON.stringify({ benchmark: "encounter-lifecycle-v1", rounds, warmup,
    environment: { node: process.version, platform: process.platform, arch: process.arch,
      storage: "SQLite :memory:", networkIncluded: false, fsyncIncluded: false }, timings, transport }, null, 2));
} finally { db.close(); }
