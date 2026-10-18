import type { AsyncAuditSigner, AuditCryptoBackend } from "../../../player-local-runtime/crypto-backend.ts";
import type { InputFrame } from "../contracts.ts";
import {
  CHUNK_TICKS, ENCOUNTER_RULES, ENCOUNTER_TICKS, MAX_CHUNK_BYTES,
  type AuditPayloadChunk, type EncounterCommit, type EncounterListing,
  type EncounterReceipt, type EncounterReceiptStatement, type EncounterTicket,
  type EncounterReveal,
  type PayloadPruneGrant,
  type EncounterTermination, type EncounterTerminationStatement, type PayloadScopeClosureGrant,
} from "./contracts.ts";

export const frame = (domain: string, ...values: unknown[]) => JSON.stringify([domain, ...values]);
export const isDigest = (value: unknown): value is string => typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
export const isTime = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

export async function encounterStartKey(unit: string, startHead: string, cryptoBackend: AuditCryptoBackend, generation = 0): Promise<string> {
  if (!isTime(generation)) throw new Error("invalid encounter generation");
  return cryptoBackend.hashString(generation === 0 ? frame("encounter-start-v1", unit, startHead) : frame("encounter-start-generation-v1", unit, generation, startHead));
}
export async function encounterQueueId(unit: string, startHead: string, cryptoBackend: AuditCryptoBackend, generation = 0): Promise<string> {
  return `encounter-start:${await encounterStartKey(unit, startHead, cryptoBackend, generation)}`;
}
export function ticketFrame(t: Omit<EncounterTicket, "ticketSignature">): string {
  const legacy = frame("encounter-ticket-v1", t.version, t.ticketId, t.unit, t.startHead, t.playerId,
    t.ownerPublicKey, t.authorityKey, t.rulesId, t.queueId, t.seedCommitment,
    t.issuedAt, t.commitNotBefore, t.releaseAt);
  return t.generation === undefined ? legacy : frame("encounter-ticket-generation-v1", t.generation, legacy);
}
export async function verifyEncounterTicket(ticket: EncounterTicket, trustedKey: string,
  cryptoBackend: AuditCryptoBackend): Promise<boolean> {
  try {
    if (ticket.version !== 1 || ticket.rulesId !== ENCOUNTER_RULES || ticket.authorityKey !== trustedKey ||
        !isDigest(trustedKey) || !isDigest(ticket.ownerPublicKey) || !isDigest(ticket.seedCommitment) || !isTime(ticket.generation ?? 0) ||
        ![ticket.ticketId, ticket.unit, ticket.startHead, ticket.playerId, ticket.queueId]
          .every((v) => typeof v === "string" && v.length > 0 && v.length <= 128) ||
        ![ticket.issuedAt, ticket.commitNotBefore, ticket.releaseAt].every(isTime) ||
        ticket.commitNotBefore !== ticket.issuedAt + ENCOUNTER_TICKS * 50 ||
        ticket.releaseAt !== ticket.commitNotBefore + 1_000 ||
        ticket.queueId !== await encounterQueueId(ticket.unit, ticket.startHead, cryptoBackend, ticket.generation ?? 0)) return false;
    return await cryptoBackend.verify(trustedKey, await cryptoBackend.hashString(ticketFrame(ticket)), ticket.ticketSignature);
  } catch { return false; }
}

function inputTuple(input: InputFrame, tick: number): [number, number, number] {
  if (input.tick !== tick || ![-1, 0, 1].includes(input.horizontal) || ![-1, 0, 1].includes(input.vertical)) {
    throw new Error("invalid input log");
  }
  return [input.tick, input.horizontal, input.vertical];
}

/** May be called every CHUNK_TICKS while recording, without retaining old frames. */
export async function encodeEncounterChunk(ticket: EncounterTicket, sequence: number,
  inputs: readonly InputFrame[], cryptoBackend: AuditCryptoBackend): Promise<AuditPayloadChunk> {
  if (!Number.isInteger(sequence) || sequence < 0 || sequence >= ENCOUNTER_TICKS / CHUNK_TICKS || inputs.length !== CHUNK_TICKS) {
    throw new Error("invalid input log length");
  }
  const text = frame("encounter-input-v1", ticket.ticketId, sequence,
    inputs.map((input, index) => inputTuple(input, sequence * CHUNK_TICKS + index + 1)));
  const payload = encoder.encode(text);
  if (payload.byteLength > MAX_CHUNK_BYTES) throw new Error("input log exceeds bound");
  return { sequence, payload, checkpointDigest: await cryptoBackend.hashString(text) };
}

export async function createEncounterChunks(ticket: EncounterTicket, inputs: readonly InputFrame[],
  cryptoBackend: AuditCryptoBackend): Promise<AuditPayloadChunk[]> {
  if (inputs.length !== ENCOUNTER_TICKS) throw new Error("invalid input log length");
  return Promise.all(Array.from({ length: ENCOUNTER_TICKS / CHUNK_TICKS }, (_, sequence) =>
    encodeEncounterChunk(ticket, sequence, inputs.slice(sequence * CHUNK_TICKS, (sequence + 1) * CHUNK_TICKS), cryptoBackend)));
}

export function logRootFrame(ticket: EncounterTicket, digests: readonly string[]): string {
  return frame("encounter-log-v1", ticket.ticketId, ticket.unit, ticket.startHead, ticket.playerId,
    ticket.ownerPublicKey, ticket.rulesId, ticket.queueId, ENCOUNTER_TICKS, digests);
}
export function commitFrame(commitment: Omit<EncounterCommit, "ownerSignature">): string {
  return frame("encounter-commit-v1", commitment.ticketId, commitment.root, commitment.chunkDigests);
}
export function revealFrame(reveal: Omit<EncounterReveal, "signature">): string {
  return frame("encounter-reveal-v1", reveal.ticketId, reveal.root, reveal.seed, reveal.committedAt, reveal.releasedAt);
}
export async function verifyEncounterReveal(ticket: EncounterTicket, commitment: EncounterCommit,
  reveal: EncounterReveal, cryptoBackend: AuditCryptoBackend): Promise<boolean> {
  if (reveal.ticketId !== ticket.ticketId || commitment.ticketId !== ticket.ticketId ||
      reveal.root !== commitment.root || !isDigest(reveal.seed) ||
      !isTime(reveal.committedAt) || !isTime(reveal.releasedAt) ||
      reveal.committedAt < ticket.commitNotBefore || reveal.committedAt >= ticket.releaseAt ||
      reveal.releasedAt < ticket.releaseAt) return false;
  if (await cryptoBackend.hashString(frame("encounter-seed-commitment-v1", ticket.ticketId, reveal.seed)) !== ticket.seedCommitment) return false;
  return cryptoBackend.verify(ticket.authorityKey, await cryptoBackend.hashString(revealFrame(reveal)), reveal.signature);
}
export async function signEncounterCommit(ticket: EncounterTicket, chunks: readonly AuditPayloadChunk[],
  signer: AsyncAuditSigner, cryptoBackend: AuditCryptoBackend): Promise<EncounterCommit> {
  const chunkDigests = chunks.map((chunk) => chunk.checkpointDigest);
  const root = await cryptoBackend.hashString(logRootFrame(ticket, chunkDigests));
  const unsigned = { ticketId: ticket.ticketId, root, chunkDigests };
  return { ...unsigned, ownerSignature: await signer.signDigest(await cryptoBackend.hashString(commitFrame(unsigned))) };
}

/** Validate exact framing and all bounds BEFORE running any game tick. */
export async function decodeEncounterLog(ticket: EncounterTicket, commitment: EncounterCommit,
  chunks: readonly AuditPayloadChunk[], cryptoBackend: AuditCryptoBackend): Promise<InputFrame[]> {
  if (chunks.length !== ENCOUNTER_TICKS / CHUNK_TICKS) throw new Error("incomplete input log");
  const inputs: InputFrame[] = [];
  for (let sequence = 0; sequence < chunks.length; sequence++) {
    const chunk = chunks[sequence];
    if (chunk.sequence !== sequence || !(chunk.payload instanceof Uint8Array) ||
        chunk.payload.byteLength === 0 || chunk.payload.byteLength > MAX_CHUNK_BYTES ||
        chunk.checkpointDigest !== commitment.chunkDigests[sequence]) throw new Error("invalid input log chunk");
    try {
      const text = decoder.decode(chunk.payload);
      const value = JSON.parse(text) as unknown;
      if (!Array.isArray(value) || value.length !== 4 || value[0] !== "encounter-input-v1" ||
          value[1] !== ticket.ticketId || value[2] !== sequence || !Array.isArray(value[3]) ||
          value[3].length !== CHUNK_TICKS) throw new Error("invalid frame");
      const chunkInputs = value[3].map((tuple: unknown, index: number): InputFrame => {
        if (!Array.isArray(tuple) || tuple.length !== 3) throw new Error("invalid tuple");
        const input = { tick: tuple[0], horizontal: tuple[1], vertical: tuple[2] } as InputFrame;
        inputTuple(input, sequence * CHUNK_TICKS + index + 1);
        return input;
      });
      const canonical = await encodeEncounterChunk(ticket, sequence, chunkInputs, cryptoBackend);
      if (decoder.decode(canonical.payload) !== text || canonical.checkpointDigest !== chunk.checkpointDigest) {
        throw new Error("digest mismatch");
      }
      inputs.push(...chunkInputs);
    } catch { throw new Error("invalid input log"); }
  }
  return inputs;
}

export function receiptFrame(s: EncounterReceiptStatement): string {
  return frame("encounter-receipt-v1", s.version, s.authorityKey, s.ticketId, s.unit, s.rulesId,
    s.playerId, s.ownerPublicKey, s.root, s.finalStateDigest,
    s.items.map((i) => [i.assetId, i.ownerId, i.itemType, i.rarity, i.power, i.sourceEnemyId, i.killTick, i.dropIndex]),
    s.settledAt, s.retentionUntil);
}
export async function verifyEncounterReceipt(receipt: EncounterReceipt, trustedKey: string,
  cryptoBackend: AuditCryptoBackend): Promise<boolean> {
  try {
    const s = receipt.statement;
    if (s.version !== 1 || s.authorityKey !== trustedKey || !isDigest(trustedKey) ||
        s.rulesId !== ENCOUNTER_RULES || !isDigest(s.root) || !isDigest(s.finalStateDigest) ||
        !isDigest(s.ownerPublicKey) || !isTime(s.settledAt) || !isTime(s.retentionUntil) ||
        s.retentionUntil < s.settledAt || !Array.isArray(s.items) || s.items.length > 1) return false;
    const id = await cryptoBackend.hashString(receiptFrame(s));
    return receipt.receiptId === id && await cryptoBackend.verify(trustedKey, id, receipt.signature);
  } catch { return false; }
}

export function listingFrame(listing: Omit<EncounterListing, "ownerSignature">): string {
  return frame("encounter-market-admission-v1", listing.ticketId, listing.receiptId, listing.assetId);
}
export async function signEncounterListing(receipt: EncounterReceipt, assetId: string,
  owner: AsyncAuditSigner, cryptoBackend: AuditCryptoBackend): Promise<EncounterListing> {
  const unsigned = { ticketId: receipt.statement.ticketId, receiptId: receipt.receiptId, assetId };
  return { ...unsigned, ownerSignature: await owner.signDigest(await cryptoBackend.hashString(listingFrame(unsigned))) };
}

export function pruneFrame(grant: Omit<PayloadPruneGrant, "authorization">): string {
  return frame("encounter-prune-v1", grant.queueId, grant.expectedRevision, grant.throughSequence,
    grant.throughCheckpointDigest, grant.deliveryAcknowledged, grant.gameplayFinalized,
    grant.retentionClosed, grant.unresolvedReference);
}
export async function verifyEncounterPruneGrant(grant: Readonly<PayloadPruneGrant>, trustedKey: string,
  cryptoBackend: AuditCryptoBackend): Promise<boolean> {
  if (!isDigest(trustedKey) || !grant.deliveryAcknowledged || !grant.gameplayFinalized ||
      !grant.retentionClosed || grant.unresolvedReference) return false;
  return cryptoBackend.verify(trustedKey, await cryptoBackend.hashString(pruneFrame(grant)), grant.authorization);
}

export function terminationFrame(s: EncounterTerminationStatement): string {
  return frame("encounter-termination-v1", s.version, s.authorityKey, s.ticketId, s.unit, s.startHead,
    s.playerId, s.ownerPublicKey, s.queueId, s.rulesId, s.root, s.reason, s.terminatedAt, s.retentionUntil);
}
export async function verifyEncounterTermination(ticket: EncounterTicket, termination: EncounterTermination,
  trustedKey: string, cryptoBackend: AuditCryptoBackend): Promise<boolean> {
  try {
    const s = termination.statement;
    if (!await verifyEncounterTicket(ticket, trustedKey, cryptoBackend) || s.version !== 1 || s.authorityKey !== trustedKey ||
        !["abandoned", "expired"].includes(s.reason) || !isTime(s.terminatedAt) || !isTime(s.retentionUntil) ||
        s.terminatedAt < ticket.issuedAt || s.retentionUntil < s.terminatedAt ||
        (s.root !== null && !isDigest(s.root)) ||
        (s.reason === "expired" && (s.root !== null || s.terminatedAt < ticket.releaseAt)) ||
        s.ticketId !== ticket.ticketId || s.unit !== ticket.unit || s.startHead !== ticket.startHead ||
        s.playerId !== ticket.playerId || s.ownerPublicKey !== ticket.ownerPublicKey ||
        s.queueId !== ticket.queueId || s.rulesId !== ticket.rulesId) return false;
    const id = await cryptoBackend.hashString(terminationFrame(s));
    return termination.terminationId === id && await cryptoBackend.verify(trustedKey, id, termination.signature);
  } catch { return false; }
}
export function scopeClosureFrame(grant: Omit<PayloadScopeClosureGrant, "authorization">): string {
  return frame("encounter-terminal-closure-v1", grant.queueId, grant.expectedRevision, grant.nextSequence, grant.closureId);
}
export async function verifyEncounterClosureGrant(grant: Readonly<PayloadScopeClosureGrant>, trustedKey: string,
  cryptoBackend: AuditCryptoBackend): Promise<boolean> {
  if (!isDigest(trustedKey) || !isDigest(grant.closureId) || !isTime(grant.expectedRevision) || !isTime(grant.nextSequence)) return false;
  return cryptoBackend.verify(trustedKey, await cryptoBackend.hashString(scopeClosureFrame(grant)), grant.authorization);
}
