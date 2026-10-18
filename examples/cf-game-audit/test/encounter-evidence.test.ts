import { env } from "cloudflare:workers";
import { SELF, evictDurableObject, runInDurableObject } from "cloudflare:test";
import { expect, it } from "vitest";
import type { Env } from "../src/index.ts";
import { createStandardWebCryptoBackend } from "../../player-local-runtime/crypto-backend.ts";
import { audit_browser_ed25519_sign, audit_browser_sha256 } from "../../../_build/js/release/build/x/game_audit/browser_bridge/browser_bridge.js";
import { EncounterAuthority, SqliteEncounterLedger, createEncounterChunks, signEncounterCommit, signEncounterListing } from "../game/encounter/index.ts";
import { signEncounterRequest, wireChunks, type EncounterCommand } from "../game/encounter/http-wire.ts";
import { evidenceLineageCaseReferenceDigest, type EvidenceLineageCaseReference } from "../../player-local-runtime/evidence-lineage-case.ts";
import { playerLocalEvidenceHoldEnvelopeStatement, type PlayerLocalEvidenceHoldUnsignedEnvelope } from "../../player-local-runtime/evidence-hold-wire.ts";
import type { PlayerLocalEvidenceHoldResolution } from "../../player-local-runtime/contracts.ts";
import { canonicalEvidenceCaseDismissalStatement, type EvidenceCaseDismissalStatement } from "../src/evidence-case-dismissal-certificate.ts";

const sourceSeed = "e0e1e2e3e4e5e6e7e8e9eaebecedeeef" + "f0f1f2f3f4f5f6f7f8f9fafbfcfdfeff";
const arbiterSeed = "c0c1c2c3c4c5c6c7c8c9cacbcccdcecf" + "d0d1d2d3d4d5d6d7d8d9dadbdcdddedf";
const digest = { hashString: audit_browser_sha256 };
function envelope(unsigned: PlayerLocalEvidenceHoldUnsignedEnvelope) {
  const message_digest = digest.hashString(playerLocalEvidenceHoldEnvelopeStatement(unsigned));
  return { ...unsigned, message_digest, authentication: { scheme: "moonbit-ed25519-v1", signature: audit_browser_ed25519_sign(sourceSeed, message_digest) } };
}

it("existing authenticated cases fence encounter deletion and market admission until ALL exact source resolutions persist", async () => {
  const e = env as unknown as Env; const unit = `case-${crypto.randomUUID()}`;
  const stub = e.AUDIT_SHARD.get(e.AUDIT_SHARD.idFromName(`pve:${unit}`));
  const backend = createStandardWebCryptoBackend(crypto); const owner = (await backend.generateSigningKey()).signer;
  const saved = await runInDurableObject(stub, async (_instance, state) => {
    const signer = (await backend.importLegacySeed(e.ENCOUNTER_SIGNING_SEED_HEX!, e.ENCOUNTER_SIGNING_PUBLIC_KEY!)).signer;
    let now = 1_000;
    const authority = new EncounterAuthority({ ledger: new SqliteEncounterLedger(state.storage.sql), signer, crypto, now: () => now, retentionMs: 0 });
    const ticket = await authority.issue({ unit, startHead: "earned", playerId: "alice", ownerPublicKey: owner.publicKey });
    const frames = Array.from({ length: 60 }, (_, i) => ({ tick: i + 1, horizontal: (i >= 30 && i < 40 ? 1 : 0) as 0 | 1, vertical: 0 as const }));
    const chunks = await createEncounterChunks(ticket, frames, backend);
    now = ticket.commitNotBefore; await authority.commit(await signEncounterCommit(ticket, chunks, owner, backend));
    now = ticket.releaseAt; await authority.reveal(ticket.ticketId); const receipt = await authority.settle(ticket.ticketId, chunks);
    await state.storage.sync(); return { ticket, receipt, chunks };
  });
  const { ticket, receipt } = saved; const assetId = receipt.statement.items[0].assetId;
  const boundary = { protocol_version: 1, purpose: ticket.rulesId, manifest_digest: ticket.seedCommitment, scope_id: ticket.playerId, unit_id: ticket.queueId };
  async function post(action: string, body: unknown, admin = false) {
    const response = await SELF.fetch(`https://example.test/v1/pve/${unit}/${action}`, { method: "POST", headers: admin ? { authorization: `Bearer ${e.ADMIN_TOKEN}` } : {}, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json<Record<string, unknown>>() };
  }
  const command = async (c: EncounterCommand) => post("encounter", await signEncounterRequest(unit, c, owner, backend, Date.now()));
  const prune = () => command({ op: "prune", ticketId: ticket.ticketId, expectedRevision: 2 });
  const market = async () => command({ op: "market", listing: await signEncounterListing(receipt, assetId, owner, backend) });
  function proposal(index: number, sequence: number, previous: string, changedBoundary = boundary) {
    const target: EvidenceLineageCaseReference = { version: 1, scope: "reference-game", unit, assetId, ancestorId: receipt.receiptId, ancestorKind: "origin", boundary: changedBoundary,
      sourceId: "evidence-source-a", holdId: `hold-${index}`, epoch: 0, checkpointDigest: receipt.statement.root, holdKind: "challenge" };
    return { version: 1, scope: target.scope, unit, asset_id: assetId, ancestor_id: target.ancestorId, ancestor_kind: target.ancestorKind, boundary: changedBoundary, source_id: target.sourceId,
      hold_envelope: envelope({ version: 1, source_id: target.sourceId, message_id: target.holdId, sequence, previous_message_digest: previous,
        operation: { kind: "place", hold: { boundary: changedBoundary, hold_id: target.holdId, epoch: 0, checkpoint_digest: target.checkpointDigest,
          kind: "challenge", reference_digest: evidenceLineageCaseReferenceDigest(target, digest), state: { kind: "active" } } } }) };
  }
  const first = proposal(1, 0, "inbox-genesis");
  const forged = structuredClone(first); forged.hold_envelope.authentication.signature = "0".repeat(128);
  expect((await post("game-asset-lineage-cases", forged)).status).toBe(403);
  const wrongBoundary = proposal(1, 0, "inbox-genesis", { ...boundary, manifest_digest: "wrong-manifest" });
  expect((await post("game-asset-lineage-cases", wrongBoundary)).status).toBe(409);
  const opened1 = await post("game-asset-lineage-cases", first); expect(opened1.status).toBe(201);
  const case1 = (opened1.body.case as { case_id: string }).case_id;
  const second = proposal(2, 1, first.hold_envelope.message_digest);
  const opened2 = await post("game-asset-lineage-cases", second); expect(opened2.status).toBe(201);
  const case2 = (opened2.body.case as { case_id: string }).case_id;
  const archived = await command({ op: "archive-upload", ticketId: ticket.ticketId, chunks: wireChunks(saved.chunks) });
  expect(archived.status).toBe(200); expect(archived.body).toMatchObject({ statement: { root: receipt.statement.root, policy: "authority-release-v1" } });
  expect((await command({ op: "archive-handoff", ticketId: ticket.ticketId, expectedRevision: 2, nextSequence: 2 })).status).toBe(200);
  const compacted = await command({ op: "inventory-compact", expectedCheckpointId: null, ticketIds: [ticket.ticketId] });
  expect(compacted.status).toBe(200); expect(compacted.body).toMatchObject({ statement: { receiptCount: 1, itemCount: 1 } });
  expect((await command({ op: "archive-release", ticketId: ticket.ticketId })).status).toBe(409);
  expect((await prune()).status).toBe(409); expect((await market()).status).toBe(409);
  await evictDurableObject(stub); expect((await prune()).status).toBe(409);
  const page = await command({ op: "inventory-page", checkpointId: compacted.body.checkpointId as string, after: 0 });
  expect(page.status).toBe(200); expect(page.body).toMatchObject({ next: null, records: [{ receipt: { receiptId: receipt.receiptId }, admittedAssets: [] }] });
  const recovered = await command({ op: "archive-read", ticketId: ticket.ticketId });
  expect(recovered.status).toBe(200); expect(recovered.body).toMatchObject({ custody: { custodyId: archived.body.custodyId }, bundle: { reveal: { ticketId: ticket.ticketId } } });
  expect((recovered.body.bundle as { chunks: unknown[] }).chunks).toHaveLength(2);
  async function dismiss(caseId: string) {
    const now = Date.now(); const statement: EvidenceCaseDismissalStatement = { version: 1, scope: "reference-game", unit, evidenceCaseId: caseId,
      reasonCode: "cleared", issuedAtMs: now, expiresAtMs: now + 60_000 };
    const signature = audit_browser_ed25519_sign(arbiterSeed, digest.hashString(canonicalEvidenceCaseDismissalStatement(statement)));
    const result = await post("game-asset-lineage-case-dismissals", { statement: { version: 1, scope: "reference-game", unit, evidence_case_id: caseId,
      reason_code: "cleared", issued_at_ms: now, expires_at_ms: now + 60_000 }, authentication: { arbiter_id: "external-arbiter-a", scheme: "moonbit-ed25519-v1", signature } }, true);
    expect(result.status).toBe(201); return result.body.hold_resolution_draft as PlayerLocalEvidenceHoldResolution;
  }
  const resolution1 = await dismiss(case1); const resolution2 = await dismiss(case2);
  expect((await prune()).status).toBe(409);
  let previous = second.hold_envelope.message_digest;
  async function resolve(caseId: string, resolution: PlayerLocalEvidenceHoldResolution, sequence: number) {
    const signed = envelope({ version: 1, source_id: "evidence-source-a", message_id: resolution.hold_id, sequence, previous_message_digest: previous,
      operation: { kind: "resolve", resolution } });
    const result = await post("game-evidence-case-resolution-envelopes", { version: 1, case_id: caseId, envelope: signed });
    expect(result.status).toBe(201); previous = signed.message_digest;
  }
  const wrong = envelope({ version: 1, source_id: "evidence-source-a", message_id: resolution1.hold_id, sequence: 2, previous_message_digest: previous,
    operation: { kind: "resolve", resolution: { ...resolution1, resolution_digest: "0".repeat(64) } } });
  const rejected = await post("game-evidence-case-resolution-envelopes", { version: 1, case_id: case1, envelope: wrong });
  expect(rejected.status, JSON.stringify(rejected.body)).toBe(409);
  await resolve(case1, resolution1, 2); expect((await market()).status).toBe(409);
  await resolve(case2, resolution2, 3); await evictDurableObject(stub);
  expect((await market()).status).toBe(200); expect((await prune()).status).toBe(200);
  expect((await command({ op: "archive-release", ticketId: ticket.ticketId })).status).toBe(200);
  expect((await command({ op: "archive-read", ticketId: ticket.ticketId })).body.bundle).toBeNull();
  const late = await post("game-asset-lineage-cases", proposal(3, 4, previous));
  expect(late.status).toBe(409); expect(late.body).toMatchObject({ decision: "encounter_retention_closed" });
  expect((await post("game-asset-lineage-cases", first)).status).toBe(200);
  await runInDurableObject(stub, (_instance, state) => {
    expect(state.storage.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM encounter_evidence_case_bindings").toArray()[0].n).toBe(2);
    expect(state.storage.sql.exec<{ n: number }>("SELECT MAX(sequence) AS n FROM reference_game_evidence_inbox_messages").toArray()[0].n).toBe(3);
  });
});
