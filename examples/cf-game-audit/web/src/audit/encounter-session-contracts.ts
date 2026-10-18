import type { EncounterAuthorization, EncounterReceipt, EncounterTermination, EncounterTicket } from "../../../game/encounter/contracts.ts";
import type { InventoryCheckpoint, InventoryCompaction } from "../../../game/encounter/inventory-checkpoint.ts";
export interface EncounterSessionRecord {
  authorization: EncounterAuthorization;
  phase: "starting" | "playing" | "complete" | "committed" | "settled" | "terminated";
  ticket?: EncounterTicket;
  receipt?: EncounterReceipt;
  termination?: EncounterTermination;
  cleaned: boolean;
  /** Persisted before relinquishing remote recovery; retry before status reads. */
  recoveryReleasePending?: boolean;
  admittedAssets: string[];
}
export interface EncounterReceiptRecord {
  ticket: EncounterTicket;
  receipt: EncounterReceipt;
  admittedAssets: string[];
}
export interface EncounterSessionImage {
  version: 1;
  revision: number;
  current: EncounterSessionRecord | null;
  history: EncounterReceiptRecord[];
  /** Optional on old v1 images; normalized to null on read without changing
   * the device key or resetting the CAS revision. */
  checkpoint?: InventoryCheckpoint | null;
  pendingCompaction?: InventoryCompaction | null;
  pendingEmptyRetirement?: InventoryCompaction | null;
}
export const MAX_RECEIPT_HISTORY = 16;
export const MAX_CONTROL_BYTES = 81_920;
