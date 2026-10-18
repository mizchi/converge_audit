import type { AuditCryptoBackend } from "../../../player-local-runtime/crypto-backend.ts";
import type { EncounterLedger } from "./contracts.ts";
import type { EncounterSql } from "./ledger.ts";
import { isTime, ticketFrame, verifyEncounterTermination } from "./wire.ts";
import { validRecoveryProof, type EncounterRecoveryProof, type EncounterRecoveryRelease } from "./recovery.ts";

interface Options {
  sql: EncounterSql;
  ledger: EncounterLedger;
  backend: AuditCryptoBackend;
  trustedKey: string;
  transaction<T>(body: () => T): T;
  currentGeneration(unit: string): number;
  held(ticketId: string): boolean;
  now(): number;
}
/** The owner gives up recovery only after local cleanup. The server requires
 * irreversible retention closure and never discards a settled receipt here. */
export class SqliteEncounterRecovery {
  private readonly o: Options;
  constructor(options: Options) { this.o = { ...options }; }
  async release(unit: string, owner: string, input: EncounterRecoveryProof): Promise<EncounterRecoveryRelease> {
    if (!validRecoveryProof(input)) throw new Error("invalid recovery proof");
    const { ticket, termination } = structuredClone(input);
    if (ticket.unit !== unit || ticket.ownerPublicKey !== owner ||
        !await verifyEncounterTermination(ticket, termination, this.o.trustedKey, this.o.backend)) throw new Error("invalid recovery authority or owner");
    const { audit_encounter_recovery_release_allowed: releaseAllowed, audit_encounter_recovery_forget_allowed: forgetAllowed } =
      await import("../../../../_build/js/release/build/x/game_audit/worker/worker.js");
    return this.o.transaction(() => {
      const current = this.o.currentGeneration(unit); const old = (ticket.generation ?? 0) < current; const now = this.o.now();
      if (!isTime(now) || now < termination.statement.retentionUntil || (ticket.generation ?? 0) > current) throw new Error("recovery retention still open");
      const ack: EncounterRecoveryRelease = { released: true, ticketId: ticket.ticketId, terminationId: termination.terminationId };
      const row = this.o.ledger.byId(ticket.ticketId);
      // Closing a generation already required every terminal retention fence.
      // Missing current-generation rows never count as completed requests.
      if (!row) { if (old) return ack; throw new Error("recovery ticket unavailable"); }
      if (ticketFrame(row.ticket) !== ticketFrame(ticket) || row.ticket.ticketSignature !== ticket.ticketSignature ||
          row.termination?.terminationId !== termination.terminationId || row.termination.signature !== termination.signature) throw new Error("recovery origin changed");
      const noAssets = !row.receipt && !row.archiveCustody && row.admittedAssets.length === 0 &&
        this.o.sql.exec("SELECT ticket_id FROM encounter_inventory_members_v1 WHERE ticket_id = ?", ticket.ticketId).toArray().length === 0;
      const clear = !row.evidenceHold && !this.o.held(ticket.ticketId);
      if (!releaseAllowed(row.phase === "forfeited", row.retentionReleased, clear, noAssets)) throw new Error("recovery release refused");
      if (forgetAllowed(true, row.retentionReleased, clear, noAssets, true, old)) {
        if (this.o.sql.exec("DELETE FROM encounter_origins_v1 WHERE id = ? AND revision = ? RETURNING id", ticket.ticketId, row.revision).toArray().length !== 1) throw new Error("recovery origin changed");
      } else if (!row.recoveryReleased && !this.o.ledger.replace(row.revision, { ...row, revision: row.revision + 1, recoveryReleased: true })) throw new Error("recovery revision changed");
      return ack;
    });
  }
}
