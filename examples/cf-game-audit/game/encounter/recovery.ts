import type { EncounterTermination, EncounterTicket } from "./contracts.ts";
import { exactKeys, identifier } from "./validation.ts";
import { isDigest, isTime } from "./wire.ts";

/** Client-carried signed evidence makes a lost acknowledgment retryable even
 * after the old generation's row has gone. No per-ticket tombstone is needed. */
export interface EncounterRecoveryProof { ticket: EncounterTicket; termination: EncounterTermination }
export interface EncounterRecoveryRelease { released: true; ticketId: string; terminationId: string }
export const MAX_RECOVERY_PROOF_BYTES = 4_096;
const signature = (s: unknown): s is string => typeof s === "string" && /^[0-9a-f]{128}$/.test(s);
export function validRecoveryProof(p: unknown): p is EncounterRecoveryProof {
  if (!exactKeys(p, ["ticket", "termination"])) return false;
  const t = p.ticket; const end = p.termination;
  const keys = ["version", "unit", "startHead", "playerId", "ownerPublicKey", "ticketId", "authorityKey", "rulesId", "queueId", "seedCommitment", "issuedAt", "commitNotBefore", "releaseAt", "ticketSignature"];
  if (!(exactKeys(t, keys) || exactKeys(t, [...keys, "generation"]) && isTime(t.generation)) ||
      ![t.unit, t.startHead, t.playerId, t.ticketId, t.rulesId, t.queueId].every(identifier) ||
      ![t.authorityKey, t.ownerPublicKey, t.seedCommitment].every(isDigest) ||
      t.version !== 1 || ![t.issuedAt, t.commitNotBefore, t.releaseAt].every(isTime) || !signature(t.ticketSignature) ||
      !exactKeys(end, ["statement", "terminationId", "signature"]) || !isDigest(end.terminationId) || !signature(end.signature)) return false;
  const s = end.statement;
  // The termination v1 signed frame has no generation field. The ticket frame
  // supplies the authenticated generation; reject unsigned extra properties.
  return exactKeys(s, ["version", "authorityKey", "ticketId", "unit", "startHead", "playerId", "ownerPublicKey", "queueId", "rulesId", "root", "reason", "terminatedAt", "retentionUntil"]) &&
    s.version === 1 && [s.unit, s.startHead, s.playerId, s.ticketId, s.rulesId, s.queueId].every(identifier) &&
    [s.authorityKey, s.ownerPublicKey].every(isDigest) && (s.root === null || isDigest(s.root)) &&
    ["abandoned", "expired"].includes(s.reason as string) && [s.terminatedAt, s.retentionUntil].every(isTime) &&
    new TextEncoder().encode(JSON.stringify(p)).byteLength <= MAX_RECOVERY_PROOF_BYTES;
}
