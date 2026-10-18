import {
  createStandardWebCryptoBackend, type AsyncAuditSigner,
} from "../../../player-local-runtime/crypto-backend.ts";
import { advanceGame, createInitialGame } from "../kernel.ts";
import { terminationAllowed, terminalCleanupAllowed } from "./termination-policy.ts";
import { archiveHandoffFrame, archiveReleaseFrame, verifyArchiveCustody, type ArchiveCustody, type ArchiveRelease } from "./archive.ts";
import {
  CHUNK_TICKS, ENCOUNTER_RULES, ENCOUNTER_TICKS,
  type AuditPayloadChunk, type EncounterAuthorization, type EncounterCommit,
  type EncounterLedger, type EncounterLedgerRow, type EncounterListing,
  type EncounterReceipt, type EncounterReceiptStatement, type EncounterTicket, type PayloadPruneGrant,
  type EncounterTermination, type EncounterTerminationReason, type EncounterTerminationStatement, type PayloadScopeClosureGrant,
  type EncounterStatus,
} from "./contracts.ts";
import {
  commitFrame, decodeEncounterLog, frame, isDigest, isTime, listingFrame, logRootFrame,
  pruneFrame, receiptFrame, revealFrame, encounterQueueId, ticketFrame,
  terminationFrame, scopeClosureFrame, encounterStartKey,
} from "./wire.ts";

export interface EncounterAuthorityOptions {
  ledger: EncounterLedger;
  /** Host persists this key and restores it on restart. Never generate per request. */
  signer: AsyncAuditSigner;
  crypto: Crypto;
  now(): number;
  retentionMs: number;
  /** Trusted synchronous view of every bound case, in the same durable store.
   * Adding a case must fence this ticket in the SAME transaction as the case. */
  hasEvidenceCases?(id: string): boolean;
  trustedArchiveKey?: string;
  currentGeneration?(unit: string): number;
}

/** Reference authority policy. The HTTP adapter authenticates its callers;
 * issue/setEvidenceHold remain TRUSTED host operations. */
export class EncounterAuthority {
  private readonly options: EncounterAuthorityOptions;
  private readonly cryptoBackend;
  constructor(options: EncounterAuthorityOptions) {
    if (!isTime(options.retentionMs) || !isDigest(options.signer.publicKey)) throw new Error("invalid authority configuration");
    this.options = options;
    this.cryptoBackend = createStandardWebCryptoBackend(options.crypto);
  }
  private time(): number {
    const now = this.options.now();
    if (!isTime(now)) throw new Error("invalid authority clock");
    return now;
  }
  private row(id: string): EncounterLedgerRow {
    const row = this.options.ledger.byId(id);
    if (!row || row.ticket.authorityKey !== this.options.signer.publicKey) throw new Error("unknown ticket or authority key changed");
    return row;
  }
  private replace(row: EncounterLedgerRow): boolean {
    return this.options.ledger.replace(row.revision, { ...row, revision: row.revision + 1 });
  }
  private held(row: EncounterLedgerRow): boolean {
    return row.evidenceHold || (this.options.hasEvidenceCases?.(row.ticket.ticketId) ?? false);
  }
  /** Trusted case service only; serialize its case insertion with this fence. */
  fenceEvidenceCase(id: string): void {
    const row = this.row(id);
    if (row.retentionReleased) throw new Error("retention already closed");
    if (!this.replace(row)) throw new Error("concurrent evidence case; retry");
  }
  status(id: string): EncounterStatus {
    const row = this.row(id);
    return structuredClone({ ticket: row.ticket, phase: row.phase, commitment: row.commitment,
      committedAt: row.committedAt, receipt: row.receipt, termination: row.termination,
      retentionReleased: row.retentionReleased, admittedAssets: row.admittedAssets });
  }
  async issue(input: EncounterAuthorization): Promise<EncounterTicket> {
    // Capture before the first await; caller mutation must not alter an admission.
    const authorization = { ...input };
    const generation = authorization.generation ?? 0;
    if (!isTime(generation) || generation !== (this.options.currentGeneration?.(authorization.unit) ?? 0)) throw new Error("start generation retired or unavailable");
    if (![authorization.unit, authorization.startHead, authorization.playerId].every((s) => typeof s === "string" && s.length > 0 && s.length <= 128) ||
        !isDigest(authorization.ownerPublicKey)) throw new Error("invalid start authorization");
    const startKey = await encounterStartKey(authorization.unit, authorization.startHead, this.cryptoBackend, generation);
    if (generation !== (this.options.currentGeneration?.(authorization.unit) ?? 0)) throw new Error("start generation changed");
    const existing = this.options.ledger.byStart(startKey);
    if (existing) {
      if (existing.ticket.authorityKey !== this.options.signer.publicKey ||
          existing.ticket.playerId !== authorization.playerId || existing.ticket.ownerPublicKey !== authorization.ownerPublicKey) {
        throw new Error("start already consumed by a different owner or authority");
      }
      return existing.ticket;
    }
    const ticketId = this.options.crypto.randomUUID();
    const secret = Array.from(this.options.crypto.getRandomValues(new Uint8Array(32)), (b) => b.toString(16).padStart(2, "0")).join("");
    const seedCommitment = await this.cryptoBackend.hashString(frame("encounter-seed-commitment-v1", ticketId, secret));
    const issuedAt = this.time();
    const commitNotBefore = issuedAt + ENCOUNTER_TICKS * 50;
    const releaseAt = commitNotBefore + 1_000;
    if (!isTime(releaseAt)) throw new Error("authority clock overflow");
    const unsigned: Omit<EncounterTicket, "ticketSignature"> = { ...authorization, version: 1, ticketId,
      authorityKey: this.options.signer.publicKey, rulesId: ENCOUNTER_RULES,
      queueId: await encounterQueueId(authorization.unit, authorization.startHead, this.cryptoBackend, generation), seedCommitment, issuedAt, commitNotBefore, releaseAt };
    const ticket: EncounterTicket = { ...unsigned,
      ticketSignature: await this.options.signer.signDigest(await this.cryptoBackend.hashString(ticketFrame(unsigned))) };
    const row: EncounterLedgerRow = { revision: 0, startKey, ticket, secret, phase: "issued",
      evidenceHold: false, retentionReleased: false, admittedAssets: [] };
    if (generation !== (this.options.currentGeneration?.(authorization.unit) ?? 0)) throw new Error("start generation changed");
    if (!this.options.ledger.insert(row)) return this.issue(authorization);
    return ticket;
  }
  async commit(input: EncounterCommit): Promise<{ root: string; committedAt: number }> {
    const commitment = { ...input, chunkDigests: [...input.chunkDigests] };
    const initial = this.row(commitment.ticketId);
    if (!isDigest(commitment.root) || commitment.chunkDigests.length !== ENCOUNTER_TICKS / CHUNK_TICKS ||
        !commitment.chunkDigests.every(isDigest) ||
        await this.cryptoBackend.hashString(logRootFrame(initial.ticket, commitment.chunkDigests)) !== commitment.root) {
      throw new Error("invalid committed root");
    }
    if (!await this.cryptoBackend.verify(initial.ticket.ownerPublicKey,
      await this.cryptoBackend.hashString(commitFrame(commitment)), commitment.ownerSignature)) throw new Error("invalid owner signature");
    for (let retry = 0; retry < 8; retry++) {
      const row = this.row(commitment.ticketId);
      if (row.phase === "forfeited") throw new Error("commit forfeited");
      if (row.commitment) {
        if (commitFrame(row.commitment) !== commitFrame(commitment)) throw new Error("committed root cannot change");
        return { root: commitment.root, committedAt: row.committedAt! };
      }
      const now = this.time();
      if (now < row.ticket.commitNotBefore || now >= row.ticket.releaseAt) throw new Error("outside commit window");
      if (this.replace({ ...row, phase: "committed", commitment, committedAt: now })) return { root: commitment.root, committedAt: now };
    }
    throw new Error("concurrent commit; retry same request");
  }
  async reveal(id: string) {
    for (let retry = 0; retry < 8; retry++) {
      const row = this.row(id);
      if (!row.commitment || row.phase === "forfeited") throw new Error("commit required before reveal");
      if (row.reveal) return row.reveal;
      if (!isDigest(row.secret)) throw new Error("replay evidence retired");
      const now = this.time();
      if (row.committedAt! >= row.ticket.releaseAt || now < row.ticket.releaseAt) throw new Error("before release time");
      const unsigned = { ticketId: id, root: row.commitment.root, seed: row.secret,
        committedAt: row.committedAt!, releasedAt: now };
      const signature = await this.options.signer.signDigest(await this.cryptoBackend.hashString(revealFrame(unsigned)));
      const reveal = { ...unsigned, signature };
      if (this.replace({ ...row, phase: "revealed", reveal })) return reveal;
    }
    throw new Error("concurrent reveal; retry same request");
  }
  async settle(id: string, input: readonly AuditPayloadChunk[]): Promise<EncounterReceipt> {
    const initial = this.row(id);
    if (initial.receipt) return initial.receipt;
    if (!initial.reveal || initial.phase !== "revealed") throw new Error("reveal required before settlement");
    // Own the bytes before asynchronous hashing. Bounds precede all copying.
    if (input.length !== 2 || input.some((c) => !(c.payload instanceof Uint8Array) || c.payload.byteLength > 4_096)) throw new Error("invalid input log bounds");
    const chunks = input.map((c) => ({ ...c, payload: c.payload.slice() }));
    const inputs = await decodeEncounterLog(initial.ticket, initial.commitment!, chunks, this.cryptoBackend);
    const seedDigest = await this.cryptoBackend.hashString(frame("encounter-game-seed-v1", id, initial.secret));
    let state = createInitialGame({ seed: Number.parseInt(seedDigest.slice(0, 8), 16), playerId: initial.ticket.playerId });
    for (const command of inputs) {
      const result = advanceGame(state, command);
      if (!result.ok) throw new Error("invalid game replay");
      state = result.state;
    }
    // Only picked-up items enter the economic boundary; namespacing also avoids
    // collisions between independent encounters using the same 32-bit kernel seed.
    const items = state.inventory.map(({ audit: _audit, ...item }) => ({ ...item, assetId: `encounter:${id}:${item.assetId}` }));
    const settledAt = this.time();
    const retentionUntil = settledAt + this.options.retentionMs;
    if (!isTime(retentionUntil) || settledAt < initial.reveal.releasedAt) throw new Error("invalid settlement clock");
    const statement: EncounterReceiptStatement = { version: 1, authorityKey: this.options.signer.publicKey,
      ticketId: id, unit: initial.ticket.unit, rulesId: ENCOUNTER_RULES, playerId: initial.ticket.playerId,
      ownerPublicKey: initial.ticket.ownerPublicKey, root: initial.commitment!.root,
      finalStateDigest: await this.cryptoBackend.hashString(frame("encounter-final-state-v1", id, state)),
      items, settledAt, retentionUntil };
    const receiptId = await this.cryptoBackend.hashString(receiptFrame(statement));
    const receipt = { statement, receiptId, signature: await this.options.signer.signDigest(receiptId) };
    for (let retry = 0; retry < 8; retry++) {
      const row = this.row(id);
      if (row.receipt) return row.receipt;
      if (row.phase !== "revealed" || row.commitment!.root !== statement.root) throw new Error("settlement root changed");
      if (this.replace({ ...row, phase: "settled", receipt })) return receipt;
    }
    throw new Error("concurrent settlement; retry same request");
  }
  async admitToMarket(input: EncounterListing): Promise<{ accepted: true; assetId: string }> {
    const listing = { ...input };
    const row = this.row(listing.ticketId);
    if (this.held(row)) throw new Error("item evidence hold still open");
    const receipt = row.receipt;
    if (!receipt || receipt.receiptId !== listing.receiptId || !receipt.statement.items.some((i) => i.assetId === listing.assetId)) {
      throw new Error("unverified item");
    }
    if (!await this.cryptoBackend.verify(row.ticket.ownerPublicKey,
      await this.cryptoBackend.hashString(listingFrame(listing)), listing.ownerSignature)) throw new Error("invalid listing signature");
    for (let retry = 0; retry < 8; retry++) {
      const current = this.row(listing.ticketId);
      if (this.held(current)) throw new Error("item evidence hold still open");
      if (current.admittedAssets.includes(listing.assetId) || this.replace({ ...current, admittedAssets: [...current.admittedAssets, listing.assetId] })) {
        return { accepted: true, assetId: listing.assetId };
      }
    }
    throw new Error("concurrent market admission; retry same request");
  }
  /** Trusted case service must open a hold before the retention boundary closes. */
  setEvidenceHold(id: string, hold: boolean): void {
    const row = this.row(id);
    if (row.retentionReleased) throw new Error("retention already closed");
    if (!this.replace({ ...row, evidenceHold: hold })) throw new Error("concurrent hold; retry");
  }
  forfeit(id: string): void {
    const row = this.row(id);
    if (row.phase === "settled" || row.phase === "forfeited") throw new Error("ticket already terminal");
    if (!this.replace({ ...row, phase: "forfeited" })) throw new Error("concurrent forfeit; retry");
  }
  async terminate(id: string, reason: EncounterTerminationReason): Promise<EncounterTermination> {
    if (reason !== "abandoned" && reason !== "expired") throw new Error("invalid termination reason");
    for (let retry = 0; retry < 8; retry++) {
      const row = this.row(id);
      if (row.receipt || row.phase === "settled") throw new Error("settled ticket cannot terminate");
      if (row.termination) return row.termination;
      const now = this.time();
      if (now < Math.max(row.ticket.issuedAt, row.committedAt ?? 0, row.reveal?.releasedAt ?? 0)) throw new Error("invalid termination clock");
      if (!await terminationAllowed(false, row.phase === "forfeited", reason === "expired",
        row.phase !== "issued" || row.commitment !== undefined, now, row.ticket.releaseAt)) throw new Error("expiry requires an uncommitted missed start");
      const retentionUntil = now + this.options.retentionMs;
      if (!isTime(retentionUntil)) throw new Error("termination clock overflow");
      const statement: EncounterTerminationStatement = { version: 1, authorityKey: this.options.signer.publicKey,
        ticketId: id, unit: row.ticket.unit, startHead: row.ticket.startHead, playerId: row.ticket.playerId,
        ownerPublicKey: row.ticket.ownerPublicKey, queueId: row.ticket.queueId, rulesId: row.ticket.rulesId,
        root: row.commitment?.root ?? null, reason: row.phase === "forfeited" ? "abandoned" : reason, terminatedAt: now, retentionUntil };
      const terminationId = await this.cryptoBackend.hashString(terminationFrame(statement));
      const termination = { statement, terminationId, signature: await this.options.signer.signDigest(terminationId) };
      if (this.replace({ ...row, phase: "forfeited", termination })) return termination;
    }
    throw new Error("concurrent termination; retry same request");
  }
  async closureGrant(id: string, expectedRevision: number, nextSequence: number): Promise<PayloadScopeClosureGrant> {
    if (!isTime(expectedRevision) || !isTime(nextSequence) || nextSequence > ENCOUNTER_TICKS / CHUNK_TICKS) throw new Error("invalid terminal queue snapshot");
    for (let retry = 0; retry < 8; retry++) {
      const row = this.row(id);
      if (row.phase !== "forfeited" || row.receipt || !row.termination) throw new Error("termination certificate required");
      const held = this.held(row);
      if (!await terminalCleanupAllowed(true, this.time(), row.termination.statement.retentionUntil, held)) {
        throw new Error(held ? "evidence hold still open" : "termination retention still open");
      }
      // An issued right cannot be revoked by a subsequently admitted hold.
      if (!row.retentionReleased && !this.replace({ ...row, retentionReleased: true })) continue;
      const unsigned = { queueId: row.ticket.queueId, expectedRevision, nextSequence, closureId: row.termination.terminationId };
      return { ...unsigned, authorization: await this.options.signer.signDigest(await this.cryptoBackend.hashString(scopeClosureFrame(unsigned))) };
    }
    throw new Error("concurrent terminal retention closure; retry");
  }
  private retireSettled(id: string): EncounterLedgerRow {
    for (let retry = 0; retry < 8; retry++) {
      const row = this.row(id);
      if (!row.receipt || this.time() < row.receipt.statement.retentionUntil) throw new Error("retention still open");
      if (this.held(row)) throw new Error("evidence hold still open");
      // Close admission of new holds atomically BEFORE issuing a deletion right.
      if (!row.retentionReleased && !this.replace({ ...row, retentionReleased: true })) continue;
      return { ...row, retentionReleased: true };
    }
    throw new Error("concurrent retention closure; retry");
  }
  async pruneGrant(id: string, expectedRevision: number): Promise<PayloadPruneGrant> {
    if (!isTime(expectedRevision)) throw new Error("invalid queue revision");
    const row = this.retireSettled(id);
    const unsigned = { queueId: row.ticket.queueId, expectedRevision,
      throughSequence: row.commitment!.chunkDigests.length - 1,
      throughCheckpointDigest: row.commitment!.chunkDigests.at(-1)!,
      deliveryAcknowledged: true, gameplayFinalized: true, retentionClosed: true, unresolvedReference: false };
    return { ...unsigned, authorization: await this.options.signer.signDigest(await this.cryptoBackend.hashString(pruneFrame(unsigned))) };
  }
  async acceptArchive(id: string, input: ArchiveCustody): Promise<void> {
    const text = JSON.stringify(input);
    if (new TextEncoder().encode(text).byteLength > 3_000 || !this.options.trustedArchiveKey) throw new Error("invalid archive custody configuration");
    const custody = JSON.parse(text) as ArchiveCustody; const c = custody.statement;
    const retained = this.row(id).archiveCustody;
    if (retained?.statement.archiveKey === this.options.trustedArchiveKey && JSON.stringify(retained) === text) return;
    if (!await verifyArchiveCustody(custody, this.options.trustedArchiveKey, this.cryptoBackend)) throw new Error("invalid archive custody");
    for (let retry = 0; retry < 8; retry++) {
      const row = this.row(id);
      if (!row.receipt || !isDigest(row.secret) || c.authorityKey !== row.ticket.authorityKey || c.ticketId !== id || c.unit !== row.ticket.unit ||
          c.queueId !== row.ticket.queueId || c.root !== row.commitment!.root || c.receiptId !== row.receipt.receiptId ||
          JSON.stringify(c.chunkDigests) !== JSON.stringify(row.commitment!.chunkDigests) || c.minRetainUntil < row.receipt.statement.retentionUntil) throw new Error("archive custody binding mismatch");
      if (row.archiveCustody) {
        if (row.archiveCustody.custodyId !== custody.custodyId) throw new Error("archive custody cannot change");
        return;
      }
      if (this.replace({ ...row, archiveCustody: custody })) return;
    }
    throw new Error("concurrent archive custody; retry");
  }
  async archiveHandoff(id: string, expectedRevision: number, nextSequence: number): Promise<PayloadScopeClosureGrant> {
    if (!isTime(expectedRevision) || nextSequence !== 2) throw new Error("invalid archive handoff snapshot");
    const row = this.row(id); const c = row.archiveCustody;
    if (!row.receipt || !c || c.statement.archiveKey !== this.options.trustedArchiveKey) throw new Error("archive custody required");
    // Close LOCAL custody only. All case/retention admission remains unchanged.
    const unsigned = { queueId: row.ticket.queueId, expectedRevision, nextSequence, closureId: c.custodyId };
    return { ...unsigned, authorization: await this.options.signer.signDigest(await this.cryptoBackend.hashString(archiveHandoffFrame(unsigned))) };
  }
  async archiveRelease(id: string): Promise<ArchiveRelease> {
    const before = this.row(id); const c = before.archiveCustody;
    if (!c || c.statement.archiveKey !== this.options.trustedArchiveKey) throw new Error("archive custody required");
    if (this.time() < c.statement.minRetainUntil) throw new Error("archive retention still open");
    const row = this.retireSettled(id);
    const statement = { version: 1 as const, authorityKey: row.ticket.authorityKey, ticketId: id, queueId: row.ticket.queueId,
      root: row.commitment!.root, custodyId: c.custodyId, closedAt: this.time() };
    const releaseId = await this.cryptoBackend.hashString(archiveReleaseFrame(statement));
    return { statement, releaseId, signature: await this.options.signer.signDigest(releaseId) };
  }
}
