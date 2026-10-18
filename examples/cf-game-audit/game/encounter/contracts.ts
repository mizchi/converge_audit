import type { InventoryItem } from "../contracts.ts";
import type { AuditPayloadChunk, PayloadPruneGrant } from "../../web/src/audit/bounded-payload-queue.ts";
import type { PayloadScopeClosureGrant } from "../../web/src/audit/payload-pool.ts";
import type { ArchiveCustody } from "./archive.ts";

// This example deliberately supports one fixed, 60-tick solo encounter.
export const ENCOUNTER_RULES = "reference-game-encounter-v1";
export const ENCOUNTER_TICKS = 60;
export const CHUNK_TICKS = 30;
export const MAX_CHUNK_BYTES = 4_096;

/** Supplied ONLY by the trusted admission layer after consuming a start resource.
 * startHead must not be a caller-selected nonce. Reissuance never refunds it. */
export interface EncounterAuthorization {
  /** Missing only on legacy generation-zero authorizations. */
  generation?: number;
  unit: string;
  startHead: string;
  playerId: string;
  ownerPublicKey: string;
}

export interface EncounterTicket extends EncounterAuthorization {
  version: 1;
  ticketId: string;
  authorityKey: string;
  rulesId: typeof ENCOUNTER_RULES;
  queueId: string;
  seedCommitment: string;
  issuedAt: number;
  commitNotBefore: number;
  releaseAt: number;
  ticketSignature: string;
}

export interface EncounterCommit {
  ticketId: string;
  root: string;
  chunkDigests: string[];
  ownerSignature: string;
}

export interface EncounterReveal {
  ticketId: string;
  root: string;
  seed: string;
  committedAt: number;
  releasedAt: number;
  signature: string;
}

export type EncounterItem = Omit<InventoryItem, "audit">;

export interface EncounterReceiptStatement {
  version: 1;
  authorityKey: string;
  ticketId: string;
  unit: string;
  rulesId: typeof ENCOUNTER_RULES;
  playerId: string;
  ownerPublicKey: string;
  root: string;
  finalStateDigest: string;
  items: EncounterItem[];
  settledAt: number;
  retentionUntil: number;
}

export interface EncounterReceipt {
  statement: EncounterReceiptStatement;
  receiptId: string;
  signature: string;
}

export interface EncounterListing {
  ticketId: string;
  receiptId: string;
  assetId: string;
  ownerSignature: string;
}

export type EncounterTerminationReason = "abandoned" | "expired";
export interface EncounterTerminationStatement extends EncounterAuthorization {
  version: 1;
  authorityKey: string;
  ticketId: string;
  queueId: string;
  rulesId: typeof ENCOUNTER_RULES;
  root: string | null;
  reason: EncounterTerminationReason;
  terminatedAt: number;
  retentionUntil: number;
}
export interface EncounterTermination {
  statement: EncounterTerminationStatement;
  terminationId: string;
  signature: string;
}
export interface EncounterConfiguration {
  version: 1;
  unit: string;
  authorityKey: string;
  rulesId: typeof ENCOUNTER_RULES;
  serverNow: number;
  archiveKey?: string;
  generation?: number;
}
/** Explicit public projection. Never spread a private ledger row into this. */
export interface EncounterStatus {
  ticket: EncounterTicket;
  phase: "issued" | "committed" | "revealed" | "settled" | "forfeited";
  commitment?: EncounterCommit;
  committedAt?: number;
  receipt?: EncounterReceipt;
  termination?: EncounterTermination;
  retentionReleased: boolean;
  admittedAssets: string[];
}

export interface EncounterLedgerRow {
  revision: number;
  startKey: string;
  ticket: EncounterTicket;
  /** Authority-private CSPRNG output. NEVER serialize a ledger row to a player. */
  secret: string;
  phase: "issued" | "committed" | "revealed" | "settled" | "forfeited";
  commitment?: EncounterCommit;
  committedAt?: number;
  reveal?: EncounterReveal;
  receipt?: EncounterReceipt;
  termination?: EncounterTermination;
  evidenceHold: boolean;
  retentionReleased: boolean;
  admittedAssets: string[];
  archiveCustody?: ArchiveCustody;
  /** Owner relinquished recovery of an assetless forfeit after local cleanup. */
  recoveryReleased?: boolean;
}

/** Each operation must be atomic and durable before returning. Copies of an
 * in-memory map do not implement the cross-process uniqueness contract. */
export interface EncounterLedger {
  byId(id: string): EncounterLedgerRow | undefined;
  byStart(key: string): EncounterLedgerRow | undefined;
  insert(row: EncounterLedgerRow): boolean;
  replace(expectedRevision: number, row: EncounterLedgerRow): boolean;
}

export type { AuditPayloadChunk, PayloadPruneGrant, PayloadScopeClosureGrant };
