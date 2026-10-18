import type { AsyncAuditSigner, AuditCryptoBackend } from "../../../player-local-runtime/crypto-backend.ts";
import type { AuditPayloadChunk, EncounterCommit, EncounterListing } from "./contracts.ts";
import { MAX_CHUNK_BYTES } from "./contracts.ts";
import { frame, isDigest, isTime, ticketFrame, terminationFrame } from "./wire.ts";
import { validRecoveryProof, type EncounterRecoveryProof } from "./recovery.ts";
import { validInventoryCompaction } from "./inventory-checkpoint.ts";
import { identifier, isObject as object, exactKeys } from "./validation.ts";
export { identifier, exactKeys } from "./validation.ts";

export const MAX_ENCOUNTER_HTTP_BYTES = 16_384;
export type EncounterCommand =
  | { op: "admissions" }
  | ({ op: "release-recovery" } & EncounterRecoveryProof)
  | { op: "inventory-compact"; expectedCheckpointId: string | null; ticketIds: string[] }
  | { op: "inventory-retire-empty"; expectedCheckpointId: string; ticketIds: string[] }
  | { op: "inventory-page"; checkpointId: string; after: number }
  | { op: "start"; startHead: string; generation?: number }
  | { op: "commit"; commitment: EncounterCommit }
  | { op: "reveal" | "receipt" | "status"; ticketId: string }
  | { op: "settle"; ticketId: string; chunks: { sequence: number; checkpointDigest: string; payload: string }[] }
  | { op: "archive-upload"; ticketId: string; chunks: { sequence: number; checkpointDigest: string; payload: string }[] }
  | { op: "archive-read" | "archive-release"; ticketId: string }
  | { op: "archive-handoff"; ticketId: string; expectedRevision: number; nextSequence: number }
  | { op: "market"; listing: EncounterListing }
  | { op: "terminate"; ticketId: string; reason: "abandoned" | "expired" }
  | { op: "closure"; ticketId: string; expectedRevision: number; nextSequence: number }
  | { op: "prune"; ticketId: string; expectedRevision: number };
export interface EncounterHttpRequest {
  version: 1;
  unit: string;
  ownerPublicKey: string;
  issuedAt: number;
  expiresAt: number;
  command: EncounterCommand;
  signature: string;
}
const signature = (s: unknown): s is string => typeof s === "string" && /^[0-9a-f]{128}$/.test(s);

export function encodePayload(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}
export function decodePayload(text: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/.test(text) || text.length > Math.ceil(MAX_CHUNK_BYTES * 4 / 3)) throw new Error("invalid payload encoding");
  const result = Uint8Array.from(atob(text.replaceAll("-", "+").replaceAll("_", "/")), (c) => c.charCodeAt(0));
  if (!result.length || result.length > MAX_CHUNK_BYTES || encodePayload(result) !== text) throw new Error("noncanonical payload encoding");
  return result;
}
export function wireChunks(chunks: readonly AuditPayloadChunk[]): Extract<EncounterCommand, { op: "settle" }>["chunks"] {
  if (chunks.length !== 2 || chunks.some((c) => !(c.payload instanceof Uint8Array) || c.payload.byteLength < 1 || c.payload.byteLength > MAX_CHUNK_BYTES)) throw new Error("invalid chunk bounds");
  return chunks.map((c) => ({ sequence: c.sequence, checkpointDigest: c.checkpointDigest, payload: encodePayload(c.payload) }));
}
function validCommand(c: unknown): c is EncounterCommand {
  if (!object(c)) return false;
  switch (c.op) {
    case "admissions": return exactKeys(c, ["op"]);
    case "release-recovery": return exactKeys(c, ["op", "ticket", "termination"]) && validRecoveryProof({ ticket: c.ticket, termination: c.termination });
    case "inventory-compact": case "inventory-retire-empty": return exactKeys(c, ["op", "expectedCheckpointId", "ticketIds"]) &&
      (c.op !== "inventory-retire-empty" || isDigest(c.expectedCheckpointId)) && validInventoryCompaction({ expectedCheckpointId: c.expectedCheckpointId, ticketIds: c.ticketIds });
    case "inventory-page": return exactKeys(c, ["op", "checkpointId", "after"]) && isDigest(c.checkpointId) && isTime(c.after);
    case "start": {
      const { generation, startHead } = c;
      return (exactKeys(c, ["op", "startHead"]) || exactKeys(c, ["op", "startHead", "generation"]) && isTime(generation)) && identifier(startHead);
    }
    case "reveal": case "receipt": case "status": case "archive-read": case "archive-release": return exactKeys(c, ["op", "ticketId"]) && identifier(c.ticketId);
    case "commit": {
      const x = c.commitment;
      return exactKeys(c, ["op", "commitment"]) && exactKeys(x, ["ticketId", "root", "chunkDigests", "ownerSignature"]) &&
        identifier(x.ticketId) && isDigest(x.root) && Array.isArray(x.chunkDigests) && x.chunkDigests.length === 2 &&
        x.chunkDigests.every(isDigest) && signature(x.ownerSignature);
    }
    case "market": {
      const x = c.listing;
      return exactKeys(c, ["op", "listing"]) && exactKeys(x, ["ticketId", "receiptId", "assetId", "ownerSignature"]) &&
        identifier(x.ticketId) && isDigest(x.receiptId) && identifier(x.assetId) && signature(x.ownerSignature);
    }
    case "prune": return exactKeys(c, ["op", "ticketId", "expectedRevision"]) && identifier(c.ticketId) && isTime(c.expectedRevision);
    case "terminate": return exactKeys(c, ["op", "ticketId", "reason"]) && identifier(c.ticketId) &&
      (c.reason === "abandoned" || c.reason === "expired");
    case "closure": case "archive-handoff": return exactKeys(c, ["op", "ticketId", "expectedRevision", "nextSequence"]) &&
      identifier(c.ticketId) && isTime(c.expectedRevision) && isTime(c.nextSequence) && c.nextSequence <= 2;
    case "settle": case "archive-upload": return exactKeys(c, ["op", "ticketId", "chunks"]) && identifier(c.ticketId) && Array.isArray(c.chunks) &&
      c.chunks.length === 2 && c.chunks.every((x, i) => {
        if (!exactKeys(x, ["sequence", "checkpointDigest", "payload"]) || x.sequence !== i || !isDigest(x.checkpointDigest) || typeof x.payload !== "string") return false;
        try { decodePayload(x.payload); return true; } catch { return false; }
      });
    default: return false;
  }
}
/** All signed arguments have an explicit positional encoding, independent of
JSON object key order. Extra fields and alternate binary encodings are refused. */
function commandTuple(c: EncounterCommand): unknown[] {
  switch (c.op) {
    case "admissions": return [c.op];
    case "release-recovery": return [c.op, ticketFrame(c.ticket), c.ticket.ticketSignature, terminationFrame(c.termination.statement), c.termination.terminationId, c.termination.signature];
    case "inventory-compact": case "inventory-retire-empty": return [c.op, c.expectedCheckpointId, c.ticketIds];
    case "inventory-page": return [c.op, c.checkpointId, c.after];
    case "start": return c.generation === undefined ? [c.op, c.startHead] : [c.op, c.startHead, c.generation];
    case "commit": return [c.op, c.commitment.ticketId, c.commitment.root, c.commitment.chunkDigests, c.commitment.ownerSignature];
    case "reveal": case "receipt": case "status": case "archive-read": case "archive-release": return [c.op, c.ticketId];
    case "settle": case "archive-upload": return [c.op, c.ticketId, c.chunks.map((x) => [x.sequence, x.checkpointDigest, x.payload])];
    case "market": return [c.op, c.listing.ticketId, c.listing.receiptId, c.listing.assetId, c.listing.ownerSignature];
    case "prune": return [c.op, c.ticketId, c.expectedRevision];
    case "terminate": return [c.op, c.ticketId, c.reason];
    case "closure": case "archive-handoff": return [c.op, c.ticketId, c.expectedRevision, c.nextSequence];
  }
}
export function encounterRequestFrame(r: Omit<EncounterHttpRequest, "signature">): string {
  return frame("encounter-http-v1", r.version, r.unit, r.ownerPublicKey, r.issuedAt, r.expiresAt, commandTuple(r.command));
}
export function decodeEncounterRequest(value: unknown): EncounterHttpRequest | undefined {
  if (!exactKeys(value, ["version", "unit", "ownerPublicKey", "issuedAt", "expiresAt", "command", "signature"]) ||
      value.version !== 1 || !identifier(value.unit) || !isDigest(value.ownerPublicKey) ||
      !isTime(value.issuedAt) || !isTime(value.expiresAt) || value.expiresAt <= value.issuedAt ||
      value.expiresAt - value.issuedAt > 60_000 || !signature(value.signature) || !validCommand(value.command)) return undefined;
  return value as unknown as EncounterHttpRequest;
}
export async function signEncounterRequest(unit: string, command: EncounterCommand, owner: AsyncAuditSigner,
  backend: AuditCryptoBackend, now: number): Promise<EncounterHttpRequest> {
  // Capture before signing; caller mutation cannot change the signed request.
  const unsigned = { version: 1 as const, unit, ownerPublicKey: owner.publicKey, issuedAt: now,
    expiresAt: now + 60_000, command: structuredClone(command) };
  if (!decodeEncounterRequest({ ...unsigned, signature: "0".repeat(128) })) throw new Error("invalid encounter request");
  return { ...unsigned, signature: await owner.signDigest(await backend.hashString(encounterRequestFrame(unsigned))) };
}

/** Cancel as soon as the encoded body exceeds the bound, including chunked
requests. Content-Length alone is never trusted. */
export async function readBoundedEncounterJson(request: Request): Promise<unknown> {
  if (!request.body) throw new Error("invalid_json");
  const reader = request.body.getReader(); const parts: Uint8Array[] = []; let size = 0;
  try {
    for (;;) {
      const next = await reader.read(); if (next.done) break;
      size += next.value.byteLength;
      if (size > MAX_ENCOUNTER_HTTP_BYTES) { await reader.cancel(); throw new Error("body_too_large"); }
      parts.push(next.value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size); let offset = 0;
  for (const part of parts) { bytes.set(part, offset); offset += part.byteLength; }
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
}
