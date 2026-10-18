import type { AuditCryptoBackend } from "../../../player-local-runtime/crypto-backend.ts";
import { ENCOUNTER_RULES, type EncounterTicket, type EncounterReceipt } from "./contracts.ts";
import { exactKeys, identifier } from "./validation.ts";
import { frame, isDigest, isTime } from "./wire.ts";

export const MAX_INVENTORY_BATCH = 16;
export const INVENTORY_PAGE_SIZE = 3;
export const MAX_INVENTORY_RECEIPTS = Number.MAX_SAFE_INTEGER;
export interface InventoryReceiptRecord {
  ticket: EncounterTicket;
  receipt: EncounterReceipt;
  admittedAssets: string[];
}
export interface InventoryCompaction {
  expectedCheckpointId: string | null;
  ticketIds: string[];
}
interface InventoryCheckpointFields {
  authorityKey: string;
  unit: string;
  ownerPublicKey: string;
  rulesId: typeof ENCOUNTER_RULES;
  revision: number;
  previousId: string | null;
  batchDigest: string;
  root: string;
  receiptCount: number;
  itemCount: number;
  createdAt: number;
}
export type InventoryCheckpointStatement = InventoryCheckpointFields &
  ({ version: 1 } | { version: 2; operation: "append" | "retire-empty"; retiredEmptyCount: number });
export interface InventoryCheckpoint {
  statement: InventoryCheckpointStatement;
  checkpointId: string;
  signature: string;
}
export interface InventoryPage {
  checkpointId: string;
  after: number;
  next: number | null;
  records: InventoryReceiptRecord[];
  /** Version 2 pages cover at most three records/ranges in ordinal order. */
  positions?: number[];
  emptyRanges?: { first: number; last: number }[];
}
export const inventoryRetiredCount = (cp: InventoryCheckpoint | null | undefined): number => cp?.statement.version === 2 ? cp.statement.retiredEmptyCount : 0;
export function validInventoryCompaction(value: unknown): value is InventoryCompaction {
  return exactKeys(value, ["expectedCheckpointId", "ticketIds"]) &&
    (value.expectedCheckpointId === null || isDigest(value.expectedCheckpointId)) &&
    Array.isArray(value.ticketIds) && value.ticketIds.length > 0 && value.ticketIds.length <= MAX_INVENTORY_BATCH &&
    value.ticketIds.every(identifier) && new Set(value.ticketIds).size === value.ticketIds.length;
}
export function validInventoryCheckpoint(value: unknown): value is InventoryCheckpoint {
  if (!exactKeys(value, ["statement", "checkpointId", "signature"]) || !isDigest(value.checkpointId) ||
      typeof value.signature !== "string" || !/^[0-9a-f]{128}$/.test(value.signature)) return false;
  const s = value.statement;
  const keys = ["version", "authorityKey", "unit", "ownerPublicKey", "rulesId", "revision", "previousId", "batchDigest", "root", "receiptCount", "itemCount", "createdAt"];
  if (!(exactKeys(s, keys) && s.version === 1 || exactKeys(s, [...keys, "operation", "retiredEmptyCount"]) && s.version === 2)) return false;
  const retired = s.version === 2 ? s.retiredEmptyCount : 0;
  return (s.version === 1 || ["append", "retire-empty"].includes(s.operation as string) && isTime(retired) && retired > 0) &&
    s.rulesId === ENCOUNTER_RULES && identifier(s.unit) && isDigest(s.authorityKey) && isDigest(s.ownerPublicKey) &&
    isTime(s.revision) && s.revision > 0 && (s.previousId === null || isDigest(s.previousId)) &&
    (s.revision === 1) === (s.previousId === null) && isDigest(s.batchDigest) && isDigest(s.root) &&
    isTime(s.receiptCount) && s.receiptCount > 0 && s.receiptCount <= MAX_INVENTORY_RECEIPTS &&
    isTime(s.itemCount) && s.itemCount <= s.receiptCount && isTime(retired) && retired <= s.receiptCount - s.itemCount &&
    Math.max(0, s.revision - s.receiptCount) <= retired && isTime(s.createdAt) &&
    new TextEncoder().encode(JSON.stringify(value)).byteLength <= 2_048;
}
export function inventoryCheckpointFrame(s: InventoryCheckpointStatement): string {
  const legacy = frame("encounter-inventory-checkpoint-v1", 1, s.authorityKey, s.unit, s.ownerPublicKey, s.rulesId,
    s.revision, s.previousId, s.batchDigest, s.root, s.receiptCount, s.itemCount, s.createdAt);
  return s.version === 1 ? legacy : frame("encounter-inventory-checkpoint-v2", s.operation, s.retiredEmptyCount, legacy);
}
export async function inventoryBatchDigest(records: readonly InventoryReceiptRecord[], backend: AuditCryptoBackend): Promise<string> {
  return backend.hashString(frame("encounter-inventory-batch-v1", records.map((r) => [r.ticket.ticketId, r.receipt.receiptId])));
}
export async function inventoryRetirementDigest(ticketIds: readonly string[], backend: AuditCryptoBackend): Promise<string> {
  return backend.hashString(frame("encounter-inventory-retire-empty-v1", ticketIds));
}
export async function inventoryNextRoot(previous: InventoryCheckpoint | null, batchDigest: string, backend: AuditCryptoBackend, operation: "append" | "retire-empty" = "append"): Promise<string> {
  return backend.hashString(previous?.statement.version === 2 || operation === "retire-empty" ?
    frame("encounter-inventory-root-v2", previous?.statement.root ?? null, operation, batchDigest) :
    frame("encounter-inventory-root-v1", previous?.statement.root ?? null, batchDigest));
}
/** Checks bounded coverage and cursor arithmetic. It is not a Merkle proof of
 * completeness; range membership comes from the authenticated authority API. */
export function validInventoryPage(value: unknown, cp: InventoryCheckpoint, after: number): value is InventoryPage {
  const keys = ["checkpointId", "after", "next", "records"];
  if (!isTime(after) || after >= cp.statement.receiptCount ||
      !exactKeys(value, cp.statement.version === 1 ? keys : [...keys, "positions", "emptyRanges"]) ||
      value.checkpointId !== cp.checkpointId || value.after !== after || !Array.isArray(value.records) || value.records.length > INVENTORY_PAGE_SIZE) return false;
  if (cp.statement.version === 1) return value.records.length === Math.min(INVENTORY_PAGE_SIZE, cp.statement.receiptCount - after) &&
    value.next === (after + value.records.length < cp.statement.receiptCount ? after + value.records.length : null);
  if (!Array.isArray(value.positions) || value.positions.length !== value.records.length || !value.positions.every(isTime) ||
      !Array.isArray(value.emptyRanges) || value.emptyRanges.length > INVENTORY_PAGE_SIZE) return false;
  const ranges: { first: number; last: number }[] = [];
  let retired = 0;
  for (const range of value.emptyRanges) {
    if (!exactKeys(range, ["first", "last"]) || !isTime(range.first) || !isTime(range.last) || range.first > range.last || range.last > cp.statement.receiptCount) return false;
    retired += range.last - range.first + 1;
    if (!isTime(retired) || retired > cp.statement.retiredEmptyCount) return false;
    ranges.push({ first: range.first, last: range.last });
  }
  for (const ordinal of value.positions) ranges.push({ first: ordinal, last: ordinal });
  if (!ranges.length || ranges.length > INVENTORY_PAGE_SIZE) return false;
  ranges.sort((a, b) => a.first - b.first);
  let cursor = after;
  for (const range of ranges) { if (range.first !== cursor + 1) return false; cursor = range.last; }
  return cursor <= cp.statement.receiptCount && value.next === (cursor < cp.statement.receiptCount ? cursor : null) &&
    (cursor === cp.statement.receiptCount || ranges.length === INVENTORY_PAGE_SIZE);
}
export async function verifyInventoryCheckpoint(value: unknown, trustedKey: string, backend: AuditCryptoBackend): Promise<boolean> {
  try {
    if (!validInventoryCheckpoint(value) || value.statement.authorityKey !== trustedKey || !isDigest(trustedKey)) return false;
    return value.checkpointId === await backend.hashString(inventoryCheckpointFrame(value.statement)) &&
      await backend.verify(trustedKey, value.checkpointId, value.signature);
  } catch { return false; }
}
