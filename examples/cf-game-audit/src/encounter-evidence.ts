import type { EvidenceLineageCaseReference } from "../../player-local-runtime/evidence-lineage-case.ts";
import type { EncounterLedger, EncounterTicket, EncounterReceipt } from "../game/encounter/contracts.ts";
import type { EncounterSql } from "../game/encounter/ledger.ts";
import { isDigest } from "../game/encounter/wire.ts";

export const MAX_ENCOUNTER_CASES = 16;
export interface EncounterEvidenceContext {
  ticketId: string;
  assetId: string;
  ticket: EncounterTicket;
  receipt: EncounterReceipt;
}
/** Adapter to the EXISTING authenticated case/inbox service. Bindings and the
ticket fence must be written in its synchronous SQL transaction, before ACK.
Deciding a case is insufficient: its exact source resolution must be durable. */
export class EncounterEvidenceCases {
  private readonly o: { sql: EncounterSql; ledger: EncounterLedger; fence(id: string): void };
  constructor(options: { sql: EncounterSql; ledger: EncounterLedger; fence(id: string): void }) {
    this.o = options;
    options.sql.exec(`CREATE TABLE IF NOT EXISTS encounter_evidence_case_bindings (
      case_id TEXT PRIMARY KEY, ticket_id TEXT NOT NULL, asset_id TEXT NOT NULL
    )`);
    options.sql.exec(`CREATE INDEX IF NOT EXISTS encounter_evidence_case_ticket
      ON encounter_evidence_case_bindings(ticket_id, case_id)`);
  }
  context(assetId: string, unit: string): EncounterEvidenceContext | undefined {
    const match = /^encounter:([0-9a-f-]{36}):/.exec(assetId);
    if (!match) return undefined;
    const row = this.o.ledger.byId(match[1]);
    if (!row?.receipt || row.phase !== "settled" || row.ticket.unit !== unit ||
        !row.receipt.statement.items.some((item) => item.assetId === assetId)) return undefined;
    return { ticketId: row.ticket.ticketId, assetId, ticket: row.ticket, receipt: row.receipt };
  }
  matches(c: EncounterEvidenceContext, target: Pick<EvidenceLineageCaseReference, "ancestorId" | "ancestorKind" | "epoch" | "checkpointDigest" | "boundary">): boolean {
    const b = target.boundary;
    return target.ancestorKind === "origin" && target.ancestorId === c.receipt.receiptId && target.epoch === 0 &&
      target.checkpointDigest === c.receipt.statement.root && b.protocol_version === 1 && b.purpose === c.ticket.rulesId &&
      b.manifest_digest === c.ticket.seedCommitment && b.scope_id === c.ticket.playerId && b.unit_id === c.ticket.queueId;
  }
  /** Called only after source authentication, reference checks and cursor checks.
   * Returning a refusal performs no writes; any thrown error aborts the caller's
   * transaction, including case, inbox, binding and ticket revision together. */
  bind(context: EncounterEvidenceContext, caseId: string): { allowed: true } | { allowed: false; reason: string } {
    const current = this.context(context.assetId, context.ticket.unit);
    if (!isDigest(caseId) || !current || current.ticketId !== context.ticketId || current.receipt.receiptId !== context.receipt.receiptId) return { allowed: false, reason: "encounter_case_binding_mismatch" };
    if (this.o.ledger.byId(current.ticketId)!.retentionReleased) return { allowed: false, reason: "encounter_retention_closed" };
    if (this.o.sql.exec("SELECT case_id FROM encounter_evidence_case_bindings WHERE case_id = ?", caseId).toArray().length) return { allowed: false, reason: "encounter_case_binding_conflict" };
    const count = this.o.sql.exec("SELECT COUNT(*) AS n FROM encounter_evidence_case_bindings WHERE ticket_id = ?", current.ticketId).toArray()[0].n as number;
    if (count >= MAX_ENCOUNTER_CASES) return { allowed: false, reason: "encounter_case_capacity_exhausted" };
    this.o.fence(current.ticketId);
    this.o.sql.exec("INSERT INTO encounter_evidence_case_bindings (case_id, ticket_id, asset_id) VALUES (?, ?, ?)", caseId, current.ticketId, current.assetId);
    return { allowed: true };
  }
  hasHold(ticketId: string): boolean {
    // Standalone encounter adapters need not create the legacy case schema.
    if (!this.o.sql.exec("SELECT case_id FROM encounter_evidence_case_bindings WHERE ticket_id = ? LIMIT 1", ticketId).toArray().length) return false;
    return this.o.sql.exec(`SELECT b.case_id FROM encounter_evidence_case_bindings b
      LEFT JOIN reference_game_evidence_lineage_cases c ON c.case_id = b.case_id
      LEFT JOIN reference_game_evidence_case_resolution_notices n ON n.case_id = b.case_id
      WHERE b.ticket_id = ? AND (c.case_id IS NULL OR c.status <> 'decided' OR n.delivered_message_digest IS NULL)
      LIMIT 1`, ticketId).toArray().length > 0;
  }
}
