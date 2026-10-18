import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { createStandardWebCryptoBackend } from "../../player-local-runtime/crypto-backend.ts";
import { EncounterAuthority, SqliteEncounterLedger, createEncounterChunks, signEncounterCommit, signEncounterListing } from "../game/encounter/index.ts";
import { EncounterEvidenceCases, MAX_ENCOUNTER_CASES } from "../src/encounter-evidence.ts";

async function fixture() {
  const db = new DatabaseSync(":memory:");
  db.exec(`CREATE TABLE reference_game_evidence_lineage_cases (case_id TEXT PRIMARY KEY, status TEXT NOT NULL);
    CREATE TABLE reference_game_evidence_case_resolution_notices (case_id TEXT PRIMARY KEY, delivered_message_digest TEXT);`);
  const sql = { exec(query: string, ...args: (string | number | null)[]) { const rows = db.prepare(query).all(...args); return { toArray: () => rows }; } };
  const backend = createStandardWebCryptoBackend(crypto); const signer = (await backend.generateSigningKey()).signer;
  const owner = (await backend.generateSigningKey()).signer; const ledger = new SqliteEncounterLedger(sql);
  let now = 1_000; let beforeRetire: (() => void) | undefined; let writeFault = false;
  const authority = new EncounterAuthority({ ledger: { ...ledger, byId: (id) => ledger.byId(id), byStart: (id) => ledger.byStart(id), insert: (row) => ledger.insert(row),
    replace(revision, row) { if (row.retentionReleased && beforeRetire) { const f = beforeRetire; beforeRetire = undefined; f(); } return ledger.replace(revision, row); } },
    signer, crypto, now: () => now, retentionMs: 0, hasEvidenceCases: (id) => cases.hasHold(id) });
  const cases = new EncounterEvidenceCases({ sql, ledger, fence: (id) => authority.fenceEvidenceCase(id) });
  const ticket = await authority.issue({ unit: "demo", startHead: "earned", playerId: "alice", ownerPublicKey: owner.publicKey });
  const inputs = Array.from({ length: 60 }, (_, i) => ({ tick: i + 1, horizontal: (i >= 30 && i < 40 ? 1 : 0) as 0 | 1, vertical: 0 as const }));
  const chunks = await createEncounterChunks(ticket, inputs, backend);
  now = ticket.commitNotBefore; await authority.commit(await signEncounterCommit(ticket, chunks, owner, backend));
  now = ticket.releaseAt; await authority.reveal(ticket.ticketId); const receipt = await authority.settle(ticket.ticketId, chunks);
  const assetId = receipt.statement.items[0].assetId; const context = cases.context(assetId, "demo")!;
  const listing = await signEncounterListing(receipt, assetId, owner, backend);
  const open = (number: number) => {
    const caseId = number.toString(16).padStart(64, "0");
    db.exec("BEGIN");
    try {
      const result = cases.bind(context, caseId); if (!result.allowed) { db.exec("ROLLBACK"); return result; }
      sql.exec("INSERT INTO reference_game_evidence_lineage_cases VALUES (?, 'open')", caseId);
      if (writeFault) throw new Error("injected case write failure");
      db.exec("COMMIT"); return result;
    } catch (error) { db.exec("ROLLBACK"); throw error; }
  };
  const decide = (number: number) => {
    const id = number.toString(16).padStart(64, "0");
    sql.exec("UPDATE reference_game_evidence_lineage_cases SET status = 'decided' WHERE case_id = ?", id);
    sql.exec("INSERT INTO reference_game_evidence_case_resolution_notices VALUES (?, NULL)", id);
  };
  const deliver = (number: number) => sql.exec("UPDATE reference_game_evidence_case_resolution_notices SET delivered_message_digest = 'signed-resolution' WHERE case_id = ?", number.toString(16).padStart(64, "0"));
  return { db, sql, ledger, authority, cases, ticket, receipt, context, listing, open, decide, deliver,
    raceBeforeRetire(f: () => void) { beforeRetire = f; }, failAfterCaseWrite() { writeFault = true; } };
}

test("every unresolved case blocks market and deletion; a decision alone or clearing a manual hold cannot release it", async () => {
  const f = await fixture();
  try {
    assert.equal(f.open(1).allowed, true); assert.equal(f.open(2).allowed, true);
    f.authority.setEvidenceHold(f.ticket.ticketId, false);
    await assert.rejects(f.authority.admitToMarket(f.listing), /hold/); await assert.rejects(f.authority.pruneGrant(f.ticket.ticketId, 2), /hold/);
    f.decide(1); f.decide(2); await assert.rejects(f.authority.pruneGrant(f.ticket.ticketId, 2), /hold/);
    f.deliver(1); assert.equal(f.cases.hasHold(f.ticket.ticketId), true);
    await assert.rejects(f.authority.admitToMarket(f.listing), /hold/);
    f.deliver(2); assert.equal(f.cases.hasHold(f.ticket.ticketId), false);
    await f.authority.admitToMarket(f.listing); await f.authority.pruneGrant(f.ticket.ticketId, 2);
    assert.deepEqual(f.open(3), { allowed: false, reason: "encounter_retention_closed" });
  } finally { f.db.close(); }
});
test("the case fence wins a concurrent retention CAS and a failed case transaction rolls back its fence and binding", async () => {
  const f = await fixture();
  try {
    f.raceBeforeRetire(() => { assert.equal(f.open(1).allowed, true); });
    await assert.rejects(f.authority.pruneGrant(f.ticket.ticketId, 2), /hold/);
    assert.equal(f.ledger.byId(f.ticket.ticketId)!.retentionReleased, false);
    const revision = f.ledger.byId(f.ticket.ticketId)!.revision;
    f.failAfterCaseWrite(); assert.throws(() => f.open(2), /injected/);
    assert.equal(f.ledger.byId(f.ticket.ticketId)!.revision, revision);
    assert.equal(f.sql.exec("SELECT COUNT(*) AS n FROM encounter_evidence_case_bindings").toArray()[0].n, 1);
    assert.equal(f.sql.exec("SELECT COUNT(*) AS n FROM reference_game_evidence_lineage_cases").toArray()[0].n, 1);
  } finally { f.db.close(); }
});
test("a case accepted while owner signature verification awaits still blocks market admission", async () => {
  const f = await fixture();
  try {
    const pending = f.authority.admitToMarket(f.listing);
    assert.equal(f.open(1).allowed, true);
    await assert.rejects(pending, /hold/);
    assert.deepEqual(f.ledger.byId(f.ticket.ticketId)!.admittedAssets, []);
  } finally { f.db.close(); }
});
test("case metadata has a lifetime cap, exact receipt context, and missing case rows fail closed", async () => {
  const f = await fixture();
  try {
    assert.equal(f.cases.context(f.context.assetId, "other"), undefined);
    assert.equal(f.cases.context(f.context.assetId + "forged", "demo"), undefined);
    assert.equal(f.cases.matches(f.context, { ancestorId: f.receipt.receiptId, ancestorKind: "origin", epoch: 0,
      checkpointDigest: f.receipt.statement.root, boundary: { protocol_version: 1, purpose: f.ticket.rulesId,
        manifest_digest: f.ticket.seedCommitment, scope_id: f.ticket.playerId, unit_id: f.ticket.queueId } }), true);
    assert.equal(f.cases.matches(f.context, { ancestorId: f.receipt.receiptId, ancestorKind: "origin", epoch: 0,
      checkpointDigest: "0".repeat(64), boundary: { protocol_version: 1, purpose: f.ticket.rulesId,
        manifest_digest: f.ticket.seedCommitment, scope_id: f.ticket.playerId, unit_id: f.ticket.queueId } }), false);
    for (let i = 1; i <= MAX_ENCOUNTER_CASES; i++) { assert.equal(f.open(i).allowed, true); f.decide(i); f.deliver(i); }
    assert.deepEqual(f.open(MAX_ENCOUNTER_CASES + 1), { allowed: false, reason: "encounter_case_capacity_exhausted" });
    f.sql.exec("DELETE FROM reference_game_evidence_lineage_cases WHERE case_id = ?", "1".padStart(64, "0"));
    assert.equal(f.cases.hasHold(f.ticket.ticketId), true);
  } finally { f.db.close(); }
});
