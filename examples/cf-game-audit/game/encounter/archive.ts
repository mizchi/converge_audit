import type { AuditCryptoBackend } from "../../../player-local-runtime/crypto-backend.ts";
import type { EncounterTicket, EncounterCommit, EncounterReveal, EncounterReceipt, AuditPayloadChunk, PayloadScopeClosureGrant } from "./contracts.ts";
import { decodePayload, wireChunks } from "./http-wire.ts";
import { frame, isDigest, isTime, commitFrame, verifyEncounterTicket, verifyEncounterReceipt, verifyEncounterReveal, decodeEncounterLog } from "./wire.ts";

export const MAX_ARCHIVE_BUNDLE_BYTES = 11_000;
export interface EncounterArchiveBundle {
  ticket: EncounterTicket;
  commitment: EncounterCommit;
  reveal: EncounterReveal;
  receipt: EncounterReceipt;
  chunks: AuditPayloadChunk[];
}
export interface ArchiveCustodyStatement {
  version: 1;
  archiveKey: string;
  authorityKey: string;
  ticketId: string;
  unit: string;
  queueId: string;
  root: string;
  receiptId: string;
  chunkDigests: string[];
  bundleDigest: string;
  storedBytes: number;
  storedAt: number;
  minRetainUntil: number;
  /** No expiry-based eviction: authority release is ALSO required. */
  policy: "authority-release-v1";
}
export interface ArchiveCustody { statement: ArchiveCustodyStatement; custodyId: string; signature: string }
export interface ArchiveRelease {
  statement: { version: 1; authorityKey: string; ticketId: string; queueId: string; root: string; custodyId: string; closedAt: number };
  releaseId: string;
  signature: string;
}
export interface EncounterArchive {
  minimumGeneration?(unit: string): number;
  canRetireGeneration?(unit: string, generation: number): boolean;
  sharesGenerationStorage?(storage: unknown): boolean;
  /** Trusted host operation, inside the authority's SAME SQLite transaction. */
  retireGenerationInTransaction?(unit: string, generation: number): void;
  readonly publicKey: string;
  store(bundle: EncounterArchiveBundle): Promise<ArchiveCustody>;
  read(ticketId: string): { custody: ArchiveCustody; bundle: EncounterArchiveBundle | null; release?: ArchiveRelease } | undefined;
  release(certificate: ArchiveRelease): Promise<ArchiveRelease>;
}
export function archiveCustodyFrame(s: ArchiveCustodyStatement): string {
  return frame("encounter-archive-custody-v1", s.version, s.archiveKey, s.authorityKey, s.ticketId, s.unit, s.queueId,
    s.root, s.receiptId, s.chunkDigests, s.bundleDigest, s.storedBytes, s.storedAt, s.minRetainUntil, s.policy);
}
export function archiveReleaseFrame(s: ArchiveRelease["statement"]): string {
  return frame("encounter-archive-release-v1", s.version, s.authorityKey, s.ticketId, s.queueId, s.root, s.custodyId, s.closedAt);
}
export function archiveHandoffFrame(g: Omit<PayloadScopeClosureGrant, "authorization">): string {
  return frame("encounter-archive-handoff-v1", g.queueId, g.expectedRevision, g.nextSequence, g.closureId);
}
export async function verifyArchiveCustody(c: ArchiveCustody, trustedKey: string, backend: AuditCryptoBackend): Promise<boolean> {
  try {
    const s = c.statement;
    if (s.version !== 1 || s.archiveKey !== trustedKey || ![trustedKey, s.authorityKey, s.root, s.receiptId, s.bundleDigest].every(isDigest) ||
        ![s.ticketId, s.unit, s.queueId].every((v) => typeof v === "string" && v.length > 0 && v.length <= 128) ||
        s.policy !== "authority-release-v1" || ![s.storedBytes, s.storedAt, s.minRetainUntil].every(isTime) ||
        s.storedBytes < 1 || s.storedBytes > MAX_ARCHIVE_BUNDLE_BYTES || !Array.isArray(s.chunkDigests) ||
        s.chunkDigests.length !== 2 || !s.chunkDigests.every(isDigest) || new TextEncoder().encode(JSON.stringify(c)).byteLength > 3_000) return false;
    const id = await backend.hashString(archiveCustodyFrame(s));
    return c.custodyId === id && await backend.verify(trustedKey, id, c.signature);
  } catch { return false; }
}
export async function verifyArchiveHandoff(g: Readonly<PayloadScopeClosureGrant>, authorityKey: string, backend: AuditCryptoBackend): Promise<boolean> {
  return isDigest(g.closureId) && isTime(g.expectedRevision) && g.nextSequence === 2 &&
    await backend.verify(authorityKey, await backend.hashString(archiveHandoffFrame(g)), g.authorization);
}
export function encodeArchiveBundle(b: EncounterArchiveBundle): string {
  const text = JSON.stringify({ ticket: b.ticket, commitment: b.commitment, reveal: b.reveal, receipt: b.receipt, chunks: wireChunks(b.chunks) });
  if (new TextEncoder().encode(text).byteLength > MAX_ARCHIVE_BUNDLE_BYTES) throw new Error("archive bundle capacity exhausted");
  return text;
}
export function decodeArchiveBundle(text: string): EncounterArchiveBundle {
  if (new TextEncoder().encode(text).byteLength > MAX_ARCHIVE_BUNDLE_BYTES) throw new Error("archive bundle capacity exhausted");
  const b = JSON.parse(text);
  return { ...b, chunks: b.chunks.map((c: { sequence: number; checkpointDigest: string; payload: string }) => ({ ...c, payload: decodePayload(c.payload) })) };
}
/** Verify restored bytes, not merely the existence of a signed promise. */
export async function verifyArchivedBundle(custody: ArchiveCustody, bundle: EncounterArchiveBundle,
  authorityKey: string, archiveKey: string, backend: AuditCryptoBackend): Promise<boolean> {
  try {
    const c = custody.statement; const { ticket, commitment, receipt, reveal, chunks } = bundle;
    const text = encodeArchiveBundle(bundle);
    if (!await verifyArchiveCustody(custody, archiveKey, backend) || c.authorityKey !== authorityKey ||
        !await verifyEncounterTicket(ticket, authorityKey, backend) || !await verifyEncounterReceipt(receipt, authorityKey, backend) ||
        !await verifyEncounterReveal(ticket, commitment, reveal, backend) ||
        !await backend.verify(ticket.ownerPublicKey, await backend.hashString(commitFrame(commitment)), commitment.ownerSignature) ||
        commitment.ticketId !== ticket.ticketId || receipt.statement.unit !== ticket.unit || receipt.statement.ownerPublicKey !== ticket.ownerPublicKey ||
        receipt.statement.playerId !== ticket.playerId ||
        c.ticketId !== ticket.ticketId || c.unit !== ticket.unit || c.queueId !== ticket.queueId || c.receiptId !== receipt.receiptId ||
        c.root !== commitment.root || receipt.statement.root !== c.root || receipt.statement.ticketId !== ticket.ticketId ||
        c.minRetainUntil < receipt.statement.retentionUntil || c.storedBytes !== new TextEncoder().encode(text).byteLength ||
        c.bundleDigest !== await backend.hashString(text) || JSON.stringify(c.chunkDigests) !== JSON.stringify(commitment.chunkDigests)) return false;
    await decodeEncounterLog(ticket, commitment, chunks, backend); return true;
  } catch { return false; }
}
