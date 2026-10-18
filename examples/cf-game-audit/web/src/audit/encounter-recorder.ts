import type { AsyncAuditSigner, AuditCryptoBackend } from "../../../../player-local-runtime/crypto-backend.ts";
import type { InputFrame } from "../../../game/contracts.ts";
import { ENCOUNTER_RULES, type AuditPayloadChunk, type EncounterCommit, type EncounterListing,
  type EncounterReceipt, type EncounterReveal, type EncounterTicket, type EncounterAuthorization, type PayloadPruneGrant,
  type EncounterTermination, type EncounterTerminationReason, type PayloadScopeClosureGrant,
} from "../../../game/encounter/contracts.ts";
import { encodeEncounterChunk, isTime, signEncounterCommit, signEncounterListing,
  verifyEncounterPruneGrant, verifyEncounterReceipt, verifyEncounterReveal, encounterQueueId, verifyEncounterTicket,
  verifyEncounterTermination, verifyEncounterClosureGrant,
} from "../../../game/encounter/wire.ts";
import { IndexedDbAuditPayloadPool, type PooledAuditPayloadQueue } from "./payload-pool.ts";
import { verifyArchiveCustody, verifyArchiveHandoff, type ArchiveCustody } from "../../../game/encounter/archive.ts";

/** HTTP adaptation and authentication belong to the host. No authority-private
 * ledger state or signer is part of this player-facing contract. */
export interface EncounterTransport {
  commit(commitment: EncounterCommit): Promise<{ root: string; committedAt: number }>;
  reveal(ticketId: string): Promise<EncounterReveal>;
  settle(ticketId: string, chunks: readonly AuditPayloadChunk[]): Promise<EncounterReceipt>;
  admitToMarket(listing: EncounterListing): Promise<{ accepted: true; assetId: string }>;
  pruneGrant(ticketId: string, expectedRevision: number): Promise<PayloadPruneGrant>;
  /** Optional capability for existing host adapters; the HTTP adapter supports it. */
  terminate?(ticketId: string, reason: EncounterTerminationReason): Promise<EncounterTermination>;
  closureGrant?(ticketId: string, expectedRevision: number, nextSequence: number): Promise<PayloadScopeClosureGrant>;
  archiveUpload?(ticketId: string, chunks: readonly AuditPayloadChunk[]): Promise<ArchiveCustody>;
  archiveHandoff?(ticketId: string, expectedRevision: number, nextSequence: number): Promise<PayloadScopeClosureGrant>;
}
export interface EncounterStartTransport extends EncounterTransport {
  start(startHead: string, generation?: number): Promise<EncounterTicket>;
}
export type EncounterStartOptions = Omit<EncounterRecorderOptions, "ticket" | "transport"> & {
  authorization: EncounterAuthorization;
  transport: EncounterStartTransport;
};

export interface EncounterRecorderOptions {
  factory: IDBFactory;
  /** Shared application DB name; never derive it from the ticket ID. */
  name?: string;
  /** Reuse one pool connection for a whole application session. */
  payloadPool?: IndexedDbAuditPayloadPool;
  ticket: EncounterTicket;
  trustedAuthorityKey: string;
  trustedArchiveKey?: string;
  owner: AsyncAuditSigner;
  cryptoBackend: AuditCryptoBackend;
  transport: EncounterTransport;
}

export const ENCOUNTER_PAYLOAD_LIMITS = Object.freeze({
  maxBytes: 16_384, reservedBytes: 8_192, maxItems: 2, maxItemBytes: 4_096,
});
export const ENCOUNTER_POOL_LIMITS = Object.freeze({
  maxBytes: 1_048_576, reservedBytes: 131_072, maxItems: 256, maxItemBytes: 4_096,
});
export const ENCOUNTER_POOL_NAME = "converge-audit-encounter-payloads-v2";
export const ENCOUNTER_POOL_MAX_QUEUES = 128;

export type EncounterReceiptRecoveryOptions = Pick<EncounterRecorderOptions,
  "ticket" | "trustedAuthorityKey" | "cryptoBackend" | "transport">;

async function checkReceipt(options: EncounterReceiptRecoveryOptions, receipt: EncounterReceipt, root?: string): Promise<void> {
  const { ticket, cryptoBackend, trustedAuthorityKey } = options;
  const statement = receipt.statement;
  if (ticket.authorityKey !== trustedAuthorityKey || ticket.version !== 1 || ticket.rulesId !== ENCOUNTER_RULES ||
      !await verifyEncounterReceipt(receipt, trustedAuthorityKey, cryptoBackend) ||
      statement.ticketId !== ticket.ticketId || statement.unit !== ticket.unit ||
      statement.playerId !== ticket.playerId || statement.ownerPublicKey !== ticket.ownerPublicKey ||
      (root !== undefined && statement.root !== root)) throw new Error("invalid encounter receipt binding");
}

/** Records complete 30-tick chunks. Phase state is durable or authoritative;
 * incomplete, unpersisted chunks cannot mint. Every queue charges the same pool. */
export class EncounterRecorder {
  private readonly queue: PooledAuditPayloadQueue;
  private readonly pool: IndexedDbAuditPayloadPool;
  private readonly ownsPool: boolean;
  private readonly options: EncounterRecorderOptions;
  private terminated = false;
  private constructor(queue: PooledAuditPayloadQueue, pool: IndexedDbAuditPayloadPool, options: EncounterRecorderOptions) {
    this.queue = queue;
    this.pool = pool;
    this.ownsPool = options.payloadPool === undefined;
    this.options = options;
  }
  static async start(options: EncounterStartOptions): Promise<EncounterRecorder> {
    const input = { ...options, authorization: Object.freeze({ ...options.authorization }) };
    const authorization = input.authorization;
    if (authorization.ownerPublicKey !== input.owner.publicKey) throw new Error("start owner mismatch");
    const pool = input.payloadPool ?? await IndexedDbAuditPayloadPool.open({ factory: input.factory,
      name: input.name ?? ENCOUNTER_POOL_NAME, limits: ENCOUNTER_POOL_LIMITS, maxQueues: ENCOUNTER_POOL_MAX_QUEUES });
    let queue: PooledAuditPayloadQueue | undefined;
    try {
      const queueId = await encounterQueueId(authorization.unit, authorization.startHead, input.cryptoBackend, authorization.generation ?? 0);
      queue = await pool.reserve({ queueId, limits: ENCOUNTER_PAYLOAD_LIMITS, bytes: 8_192, items: 2,
        verifyClosureGrant: async (grant) => await verifyEncounterClosureGrant(grant, input.trustedAuthorityKey, input.cryptoBackend) || await verifyArchiveHandoff(grant, input.trustedAuthorityKey, input.cryptoBackend),
        verifyPruneGrant: (grant) => verifyEncounterPruneGrant(grant, input.trustedAuthorityKey, input.cryptoBackend) });
      const ticket = Object.freeze({ ...await input.transport.start(authorization.startHead, authorization.generation ?? 0) });
      if (!await verifyEncounterTicket(ticket, input.trustedAuthorityKey, input.cryptoBackend) ||
          ticket.queueId !== queueId || ticket.unit !== authorization.unit || ticket.startHead !== authorization.startHead ||
          ticket.playerId !== authorization.playerId || ticket.ownerPublicKey !== authorization.ownerPublicKey || (ticket.generation ?? 0) !== (authorization.generation ?? 0)) throw new Error("invalid start ticket binding");
      return new EncounterRecorder(queue, pool, { ...input, ticket });
    } catch (error) {
      // An ambiguous network failure must not refund a potentially consumed start.
      queue?.close(); if (!input.payloadPool) pool.close(); throw error;
    }
  }
  static async open(input: EncounterRecorderOptions): Promise<EncounterRecorder> {
    const options = { ...input, ticket: Object.freeze({ ...input.ticket }) };
    if (!await verifyEncounterTicket(options.ticket, options.trustedAuthorityKey, options.cryptoBackend) ||
        options.ticket.ownerPublicKey !== options.owner.publicKey) throw new Error("ticket trust or owner mismatch");
    const pool = options.payloadPool ?? await IndexedDbAuditPayloadPool.open({ factory: options.factory,
      name: options.name ?? ENCOUNTER_POOL_NAME, limits: ENCOUNTER_POOL_LIMITS, maxQueues: ENCOUNTER_POOL_MAX_QUEUES });
    try {
      const queue = await pool.queue({ queueId: options.ticket.queueId, limits: ENCOUNTER_PAYLOAD_LIMITS,
        verifyClosureGrant: async (grant) => await verifyEncounterClosureGrant(grant, options.trustedAuthorityKey, options.cryptoBackend) || await verifyArchiveHandoff(grant, options.trustedAuthorityKey, options.cryptoBackend),
        verifyPruneGrant: (grant) => verifyEncounterPruneGrant(grant, options.trustedAuthorityKey, options.cryptoBackend) });
      return new EncounterRecorder(queue, pool, options);
    } catch (error) { if (!options.payloadPool) pool.close(); throw error; }
  }
  snapshot() { return this.queue.snapshot(); }
  get ticket(): Readonly<EncounterTicket> { return this.options.ticket; }
  releaseEmpty() { return this.queue.releaseEmpty(); }
  close() { this.queue.close(); if (this.ownsPool) this.pool.close(); }
  async recordChunk(sequence: number, inputs: readonly InputFrame[]) {
    if (this.terminated) throw new Error("encounter already terminated");
    const chunk = await encodeEncounterChunk(this.options.ticket, sequence, inputs, this.options.cryptoBackend);
    if (this.terminated) throw new Error("encounter already terminated");
    return this.queue.append(chunk);
  }
  private async prepared() {
    const snapshot = await this.queue.snapshot();
    if (snapshot.firstSequence !== 0 || snapshot.itemCount !== 2 || snapshot.nextSequence !== 2) throw new Error("complete durable input log required");
    const chunks = await this.queue.readBatch(2);
    const commitment = await signEncounterCommit(this.options.ticket, chunks, this.options.owner, this.options.cryptoBackend);
    return { chunks, commitment };
  }
  async commit(): Promise<{ root: string; committedAt: number }> {
    const { commitment } = await this.prepared();
    const receipt = await this.options.transport.commit(commitment);
    if (receipt.root !== commitment.root || !isTime(receipt.committedAt) ||
        receipt.committedAt < this.options.ticket.commitNotBefore || receipt.committedAt >= this.options.ticket.releaseAt) {
      throw new Error("invalid commit receipt");
    }
    return receipt;
  }
  private async checkReceipt(receipt: EncounterReceipt, root?: string): Promise<void> {
    await checkReceipt(this.options, receipt, root);
  }
  async settle(): Promise<EncounterReceipt> {
    const { chunks, commitment } = await this.prepared();
    const reveal = await this.options.transport.reveal(this.options.ticket.ticketId);
    if (!await verifyEncounterReveal(this.options.ticket, commitment, reveal, this.options.cryptoBackend)) throw new Error("invalid encounter reveal");
    const receipt = await this.options.transport.settle(this.options.ticket.ticketId, chunks);
    await this.checkReceipt(receipt, commitment.root);
    return receipt;
  }
  /** Recovers an already-settled receipt after local payload deletion/restart.
   * An unsettled authority rejects this empty-log request; it cannot mint. */
  async restoreReceipt(): Promise<EncounterReceipt> {
    return EncounterRecorder.recoverReceipt(this.options);
  }
  /** Receipt recovery allocates no queue or IndexedDB storage. */
  static async recoverReceipt(input: EncounterReceiptRecoveryOptions): Promise<EncounterReceipt> {
    const options = { ...input, ticket: Object.freeze({ ...input.ticket }) };
    if (!await verifyEncounterTicket(options.ticket, options.trustedAuthorityKey, options.cryptoBackend)) throw new Error("invalid recovery ticket");
    const receipt = await options.transport.settle(options.ticket.ticketId, []);
    await checkReceipt(options, receipt);
    return receipt;
  }
  async admitToMarket(receipt: EncounterReceipt, assetId: string): Promise<{ accepted: true; assetId: string }> {
    await this.checkReceipt(receipt);
    if (!receipt.statement.items.some((item) => item.assetId === assetId)) throw new Error("unknown receipt item");
    const listing = await signEncounterListing(receipt, assetId, this.options.owner, this.options.cryptoBackend);
    const result = await this.options.transport.admitToMarket(listing);
    if (result.accepted !== true || result.assetId !== assetId) throw new Error("invalid market response");
    return result;
  }
  async prune() {
    const snapshot = await this.queue.snapshot();
    const grant = await this.options.transport.pruneGrant(this.options.ticket.ticketId, snapshot.revision);
    return this.queue.prune(grant);
  }
  async release() {
    const snapshot = await this.queue.snapshot();
    const grant = await this.options.transport.pruneGrant(this.options.ticket.ticketId, snapshot.revision);
    return this.queue.release(grant);
  }
  async terminate(reason: EncounterTerminationReason): Promise<EncounterTermination> {
    if (!this.options.transport.terminate) throw new Error("transport does not support termination");
    const certificate = await this.options.transport.terminate(this.options.ticket.ticketId, reason);
    if (!await verifyEncounterTermination(this.options.ticket, certificate, this.options.trustedAuthorityKey, this.options.cryptoBackend)) throw new Error("invalid termination certificate");
    this.terminated = true;
    return certificate;
  }
  async cleanupTerminated(input: EncounterTermination) {
    // Own the certificate before waiting for network/cryptographic verification.
    const certificate = structuredClone(input);
    if (!this.options.transport.closureGrant) throw new Error("transport does not support terminal closure");
    if (!await verifyEncounterTermination(this.options.ticket, certificate, this.options.trustedAuthorityKey, this.options.cryptoBackend)) throw new Error("invalid termination certificate");
    this.terminated = true;
    const snapshot = await this.queue.snapshot();
    const grant = await this.options.transport.closureGrant(this.options.ticket.ticketId, snapshot.revision, snapshot.nextSequence);
    if (grant.closureId !== certificate.terminationId) throw new Error("invalid termination closure binding");
    return this.queue.releaseClosed(grant);
  }
  private async checkArchive(custody: ArchiveCustody, root: string): Promise<void> {
    const s = custody.statement; const { ticket, trustedArchiveKey, trustedAuthorityKey, cryptoBackend } = this.options;
    if (!trustedArchiveKey || !await verifyArchiveCustody(custody, trustedArchiveKey, cryptoBackend) ||
        s.ticketId !== ticket.ticketId || s.unit !== ticket.unit || s.authorityKey !== trustedAuthorityKey ||
        s.queueId !== ticket.queueId || s.root !== root) throw new Error("invalid archive custody");
  }
  async archive(): Promise<ArchiveCustody> {
    if (!this.options.trustedArchiveKey || !this.options.transport.archiveUpload) throw new Error("archive custody transport unavailable");
    const { chunks, commitment } = await this.prepared();
    const custody = await this.options.transport.archiveUpload(this.options.ticket.ticketId, chunks);
    await this.checkArchive(custody, commitment.root); return custody;
  }
  async cleanupArchived(input: ArchiveCustody) {
    const text = JSON.stringify(input);
    if (new TextEncoder().encode(text).byteLength > 3_000 || !this.options.transport.archiveHandoff) throw new Error("archive custody transport unavailable");
    const custody = JSON.parse(text) as ArchiveCustody;
    const { commitment } = await this.prepared(); await this.checkArchive(custody, commitment.root);
    const snapshot = await this.queue.snapshot();
    const grant = await this.options.transport.archiveHandoff(this.options.ticket.ticketId, snapshot.revision, snapshot.nextSequence);
    if (grant.closureId !== custody.custodyId) throw new Error("archive custody handoff mismatch");
    return this.queue.releaseClosed(grant);
  }
}
