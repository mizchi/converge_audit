import type { AsyncAuditSigner, AuditCryptoBackend } from "../../../../player-local-runtime/crypto-backend.ts";
import { advanceGame, createInitialGame, type Axis, type GameState, type InputFrame } from "../../../game/kernel.ts";
import type { EncounterAuthorization, EncounterReceipt, EncounterStatus, EncounterTicket } from "../../../game/encounter/contracts.ts";
import { signEncounterListing, verifyEncounterClosureGrant, verifyEncounterReceipt, verifyEncounterTermination, verifyEncounterTicket } from "../../../game/encounter/wire.ts";
import { EncounterRecorder } from "./encounter-recorder.ts";
import { EncounterHttpError, type HttpEncounterTransport } from "./encounter-http.ts";
import type { IndexedDbAuditPayloadPool } from "./payload-pool.ts";
import type { IndexedDbEncounterSessionStore } from "./encounter-session-store.ts";
import { MAX_RECEIPT_HISTORY, type EncounterReceiptRecord, type EncounterSessionImage, type EncounterSessionRecord } from "./encounter-session-contracts.ts";
import { exactKeys } from "../../../game/encounter/http-wire.ts";
import { inventoryBatchDigest, inventoryNextRoot, verifyInventoryCheckpoint, inventoryRetiredCount, inventoryRetirementDigest, validInventoryPage,
  type InventoryReceiptRecord, type InventoryCheckpoint } from "../../../game/encounter/inventory-checkpoint.ts";

export type EncounterUiPhase = "idle" | "playing" | "ready" | "waiting" | "settled" | "terminated" | "interrupted" | "error";
interface SessionOptions {
  factory: IDBFactory;
  store: IndexedDbEncounterSessionStore;
  pool: IndexedDbAuditPayloadPool;
  owner: AsyncAuditSigner;
  backend: AuditCryptoBackend;
  transport: HttpEncounterTransport;
  trustedKey: string;
  trustedArchiveKey?: string;
  unit: string;
  now(): number;
  changed?(): void;
}
/** Input queues contain at most 30 RAM frames and 2 durable chunks. Recovery
never resumes simulation or guesses an incomplete chunk. The authority owns
phase/finality, while this controller owns presentation and bounded persistence. */
export class EncounterSessionController {
  private readonly o: SessionOptions;
  private image: EncounterSessionImage = { version: 1, revision: 0, current: null, history: [] };
  private recorder?: EncounterRecorder;
  private buffer: InputFrame[] = [];
  private preview?: GameState;
  private progress = 0;
  private savedChunks = 0;
  private catalog: InventoryReceiptRecord[] = [];
  private catalogAfter = 0;
  private catalogNext: number | null = null;
  phase: EncounterUiPhase = "idle";
  busy = false;
  error?: string;
  constructor(options: SessionOptions) { this.o = { ...options }; }
  get ticket() { return this.image.current?.ticket; }
  get receipt() { return this.image.current?.receipt; }
  get termination() { return this.image.current?.termination; }
  get current() { return structuredClone(this.image.current); }
  get history(): EncounterReceiptRecord[] { return structuredClone(this.image.history); }
  get checkpoint() { return structuredClone(this.image.checkpoint ?? null); }
  get inventoryPage(): InventoryReceiptRecord[] { return structuredClone(this.catalog); }
  get inventoryHasMore() { return this.catalogNext !== null; }
  get canCompact() { return !this.image.current || this.image.current.cleaned; }
  get tick() { return this.progress; }
  get durableChunks() { return this.savedChunks; }
  get game(): GameState | undefined { return this.preview; }
  private async run<T>(body: () => Promise<T>): Promise<T> {
    if (this.busy) throw new Error("another session operation is in progress");
    this.busy = true; this.error = undefined; this.o.changed?.();
    try { return await body(); }
    catch (error) { this.error = error instanceof Error ? error.message : String(error); this.phase = "error"; throw error; }
    finally { this.busy = false; this.o.changed?.(); }
  }
  private async save(current: EncounterSessionRecord | null, history = this.image.history) {
    this.image = await this.o.store.write({ ...this.image, current, history }, this.image.revision);
  }
  private async checkTicket(ticket: EncounterTicket, authorization?: EncounterAuthorization) {
    if (!await verifyEncounterTicket(ticket, this.o.trustedKey, this.o.backend) || ticket.unit !== this.o.unit ||
        ticket.ownerPublicKey !== this.o.owner.publicKey || (authorization &&
          (ticket.startHead !== authorization.startHead || ticket.playerId !== authorization.playerId || ticket.unit !== authorization.unit || (ticket.generation ?? 0) !== (authorization.generation ?? 0)))) throw new Error("invalid session ticket");
  }
  private async checkReceipt(ticket: EncounterTicket, receipt: EncounterReceipt) {
    const s = receipt.statement;
    await this.checkTicket(ticket);
    if (!await verifyEncounterReceipt(receipt, this.o.trustedKey, this.o.backend) || s.ticketId !== ticket.ticketId ||
        s.unit !== ticket.unit || s.ownerPublicKey !== ticket.ownerPublicKey || s.playerId !== ticket.playerId) throw new Error("invalid session receipt");
  }
  async initialize() { return this.run(async () => {
    const image = await this.o.store.read();
    for (const entry of image.history) await this.checkReceipt(entry.ticket, entry.receipt);
    if (image.checkpoint && (!await verifyInventoryCheckpoint(image.checkpoint, this.o.trustedKey, this.o.backend) ||
        image.checkpoint.statement.unit !== this.o.unit || image.checkpoint.statement.ownerPublicKey !== this.o.owner.publicKey)) throw new Error("invalid inventory checkpoint owner or unit");
    if (image.current && (image.current.authorization.ownerPublicKey !== this.o.owner.publicKey || image.current.authorization.unit !== this.o.unit)) throw new Error("retained session belongs to another owner or unit");
    this.image = image;
    if (image.pendingEmptyRetirement) await this.retireEmptyRetained();
    if (image.pendingCompaction) await this.compactRetained();
    await this.recoverCurrent(); await this.readInventory(0);
  }); }
  async refresh() { return this.run(async () => {
    if (this.image.pendingEmptyRetirement) await this.retireEmptyRetained();
    if (this.image.pendingCompaction) await this.compactRetained();
    await this.recoverCurrent(); await this.readInventory(this.catalogAfter);
  }); }
  private async recoverCurrent() {
    const current = this.image.current;
    if (!current) { this.phase = "idle"; return; }
    if (current.recoveryReleasePending) { await this.releaseTerminated(); return; }
    let ticket = current.ticket;
    if (!ticket) {
      const pending = await EncounterRecorder.start({ factory: this.o.factory, payloadPool: this.o.pool,
        trustedArchiveKey: this.o.trustedArchiveKey,
        authorization: current.authorization, trustedAuthorityKey: this.o.trustedKey,
        owner: this.o.owner, cryptoBackend: this.o.backend, transport: this.o.transport });
      ticket = { ...pending.ticket }; pending.close();
    }
    await this.checkTicket(ticket, current.authorization);
    const status = await this.o.transport.status(ticket.ticketId);
    await this.checkTicket(status.ticket, current.authorization);
    if (status.ticket.ticketId !== ticket.ticketId || !["issued", "committed", "revealed", "settled", "forfeited"].includes(status.phase)) throw new Error("invalid session status");
    let next: EncounterSessionRecord = { ...current, ticket };
    this.recorder?.close(); this.recorder = undefined;
    const snapshot = await this.o.pool.scopeSnapshot(ticket.queueId);
    this.savedChunks = snapshot?.itemCount ?? 0;
    this.progress = Math.min(60, (snapshot?.nextSequence ?? 0) * 30); this.buffer = []; this.preview = undefined;
    if (status.phase === "settled") {
      if (!status.receipt || !status.commitment || status.receipt.statement.root !== status.commitment.root) throw new Error("invalid settled session");
      await this.checkReceipt(ticket, status.receipt);
      next = { ...next, phase: "settled", receipt: status.receipt, admittedAssets: this.admitted(status), cleaned: !snapshot };
      this.progress = 60; this.phase = "settled";
    } else if (status.phase === "forfeited") {
      const termination = status.termination ?? await this.o.transport.terminate(ticket.ticketId, "abandoned");
      if (!await verifyEncounterTermination(ticket, termination, this.o.trustedKey, this.o.backend)) throw new Error("invalid stopped session");
      next = { ...next, phase: "terminated", termination }; this.phase = "terminated";
    } else if (snapshot?.nextSequence === 2 && snapshot.firstSequence === 0 && snapshot.itemCount === 2) {
      next = { ...next, phase: status.phase === "issued" ? "complete" : "committed" };
      this.phase = status.phase === "issued" ? (this.o.now() < ticket.releaseAt ? "ready" : "interrupted") : "waiting";
    } else this.phase = "interrupted";
    if (snapshot) this.recorder = await EncounterRecorder.open({ factory: this.o.factory, payloadPool: this.o.pool,
      trustedArchiveKey: this.o.trustedArchiveKey,
      ticket, trustedAuthorityKey: this.o.trustedKey, owner: this.o.owner, cryptoBackend: this.o.backend, transport: this.o.transport });
    await this.save(next);
  }
  private admitted(status: EncounterStatus): string[] {
    if (!Array.isArray(status.admittedAssets) || status.admittedAssets.length > 1 || status.admittedAssets.some((id) => !status.receipt?.statement.items.some((item) => item.assetId === id))) throw new Error("invalid admitted assets");
    return [...status.admittedAssets];
  }
  async start(authorization: EncounterAuthorization) { return this.run(async () => {
    if (this.image.pendingEmptyRetirement) await this.retireEmptyRetained();
    if (authorization.unit !== this.o.unit || authorization.ownerPublicKey !== this.o.owner.publicKey) throw new Error("invalid start owner");
    let previous = this.image.current;
    if (previous && !previous.cleaned) throw new Error("retained session must be closed and cleaned first");
    if (previous?.termination) { await this.releaseTerminated(); previous = this.image.current; }
    if (this.image.pendingCompaction || this.image.history.length + (previous?.receipt ? 1 : 0) >= MAX_RECEIPT_HISTORY) {
      await this.compactRetained(); await this.readInventory(0); previous = this.image.current;
    }
    const history = [...this.image.history];
    if (previous?.receipt && previous.ticket) history.push({ ticket: previous.ticket, receipt: previous.receipt, admittedAssets: previous.admittedAssets });
    // Reserve one eventual receipt slot before consuming the start resource.
    if (history.length >= MAX_RECEIPT_HISTORY) throw new Error("receipt history capacity exhausted");
    await this.save({ authorization: { ...authorization }, phase: "starting", cleaned: false, admittedAssets: [] }, history);
    this.recorder?.close();
    this.recorder = await EncounterRecorder.start({ factory: this.o.factory, payloadPool: this.o.pool,
      trustedArchiveKey: this.o.trustedArchiveKey,
      authorization, trustedAuthorityKey: this.o.trustedKey, owner: this.o.owner, cryptoBackend: this.o.backend, transport: this.o.transport });
    const ticket = { ...this.recorder.ticket };
    await this.save({ ...this.image.current!, ticket, phase: "playing" });
    if (this.o.now() >= ticket.releaseAt) { this.phase = "interrupted"; return; }
    this.preview = createInitialGame({ seed: 0, playerId: ticket.playerId });
    this.progress = 0; this.savedChunks = 0; this.buffer = []; this.phase = "playing";
  }); }
  async step(horizontal: Axis, vertical: Axis) { return this.run(async () => {
    if (this.phase !== "playing" || !this.preview || !this.recorder || this.progress >= 60) throw new Error("session is not playing");
    const input = { tick: this.progress + 1, horizontal, vertical };
    const result = advanceGame(this.preview, input); if (!result.ok) throw new Error(result.reason);
    this.buffer.push(input); this.preview = result.state; this.progress++;
    if (this.buffer.length === 30) {
      const result = await this.recorder.recordChunk(this.progress / 30 - 1, this.buffer);
      if (result !== "stored" && result !== "duplicate") throw new Error(`durable log refused: ${result}`);
      this.savedChunks = this.progress / 30;
      this.buffer = [];
    }
    if (this.progress === 60) { await this.save({ ...this.image.current!, phase: "complete" }); this.phase = "ready"; }
  }); }
  async advanceSettlement() { return this.run(async () => {
    const current = this.image.current;
    if (!current?.ticket || !this.recorder || !["complete", "committed"].includes(current.phase) || this.progress !== 60) throw new Error("complete durable log required");
    const ticket = current.ticket;
    if (current.phase === "complete") {
      if (this.o.now() < ticket.commitNotBefore) { this.phase = "ready"; return; }
      if (this.o.now() >= ticket.releaseAt) { this.phase = "interrupted"; return; }
      await this.recorder.commit(); await this.save({ ...current, phase: "committed" });
    }
    if (this.o.now() < ticket.releaseAt) { this.phase = "waiting"; return; }
    const receipt = await this.recorder.settle();
    await this.checkReceipt(ticket, receipt);
    await this.save({ ...this.image.current!, receipt, phase: "settled" }); this.phase = "settled";
  }); }
  async terminate() { return this.run(async () => {
    const current = this.image.current;
    if (!current?.ticket || current.receipt) throw new Error("unsettled session required");
    const termination = await this.o.transport.terminate(current.ticket.ticketId, "abandoned");
    if (!await verifyEncounterTermination(current.ticket, termination, this.o.trustedKey, this.o.backend)) throw new Error("invalid termination certificate");
    await this.save({ ...current, termination, phase: "terminated" }); this.buffer = []; this.phase = "terminated";
  }); }
  async cleanup() { return this.run(async () => {
    const current = this.image.current;
    if (!current?.ticket || (!current.receipt && !current.termination)) throw new Error("terminal session required");
    if (current.cleaned) return;
    const ticket = current.ticket;
    if (current.termination) {
      if (this.recorder) {
        if (await this.recorder.cleanupTerminated(current.termination) !== "released") throw new Error("terminal cleanup refused");
      } else {
        const grant = await this.o.transport.closureGrant(ticket.ticketId, 0, 0);
        if (grant.queueId !== ticket.queueId || grant.closureId !== current.termination.terminationId || !await verifyEncounterClosureGrant(grant, this.o.trustedKey, this.o.backend)) throw new Error("invalid terminal closure");
      }
    } else if (this.recorder) {
      const snapshot = await this.recorder.snapshot();
      if (snapshot.itemCount && await this.recorder.prune() !== "pruned") throw new Error("payload prune refused");
      if (snapshot.nextSequence === 0) {
        await this.o.transport.pruneGrant(ticket.ticketId, snapshot.revision);
        if (await this.recorder.releaseEmpty() !== "released") throw new Error("empty release refused");
      } else if (await this.recorder.release() !== "released") throw new Error("scope release refused");
    } else await this.o.transport.pruneGrant(ticket.ticketId, 0);
    this.recorder?.close(); this.recorder = undefined;
    this.savedChunks = 0;
    await this.save({ ...current, cleaned: true }); this.phase = current.receipt ? "settled" : "terminated";
  }); }
  async forgetTerminated() { return this.run(() => this.releaseTerminated()); }
  private async releaseTerminated() {
    const current = this.image.current;
    if (!current?.cleaned || !current.ticket || !current.termination || current.receipt || current.phase !== "terminated") throw new Error("cleaned terminated session required");
    const { ticket, termination } = current;
    await this.checkTicket(ticket, current.authorization);
    if (!await verifyEncounterTermination(ticket, termination, this.o.trustedKey, this.o.backend) || await this.o.pool.scopeSnapshot(ticket.queueId)) throw new Error("terminal cleanup required");
    if (!current.recoveryReleasePending) await this.save({ ...current, recoveryReleasePending: true });
    const ack = await this.o.transport.releaseRecovery(ticket, termination);
    if (!exactKeys(ack, ["released", "ticketId", "terminationId"]) || ack.released !== true || ack.ticketId !== ticket.ticketId || ack.terminationId !== termination.terminationId) throw new Error("invalid recovery release acknowledgment");
    // On failure, the exact signed proof and pending flag remain in IndexedDB.
    await this.save(null); this.recorder?.close(); this.recorder = undefined;
    this.buffer = []; this.preview = undefined; this.progress = 0; this.savedChunks = 0; this.phase = "idle";
  }
  async admit(assetId: string, ticketId = this.ticket?.ticketId) { return this.run(async () => {
    const current = this.image.current;
    const record = current && current.ticket && current.ticket.ticketId === ticketId && current.receipt ? { ticket: current.ticket, receipt: current.receipt, admittedAssets: current.admittedAssets } :
      this.image.history.find((item) => item.ticket.ticketId === ticketId);
    const selected = record ?? this.catalog.find((item) => item.ticket.ticketId === ticketId);
    if (!selected || !selected.receipt.statement.items.some((item) => item.assetId === assetId)) throw new Error("unknown receipt item");
    await this.checkReceipt(selected.ticket, selected.receipt);
    const listing = await signEncounterListing(selected.receipt, assetId, this.o.owner, this.o.backend);
    const result = await this.o.transport.admitToMarket(listing);
    if (result.accepted !== true || result.assetId !== assetId) throw new Error("invalid market response");
    if (current && current.ticket?.ticketId === ticketId) await this.save({ ...current, admittedAssets: [assetId] });
    else if (record) await this.save(current, this.image.history.map((entry) => entry.ticket.ticketId === ticketId ? { ...entry, admittedAssets: [assetId] } : entry));
    this.catalog = this.catalog.map((entry) => entry.ticket.ticketId === ticketId ? { ...entry, admittedAssets: [assetId] } : entry);
  }); }
  async compact() { return this.run(async () => { await this.compactRetained(); await this.readInventory(0); }); }
  private retainedReceipts(): EncounterReceiptRecord[] {
    const c = this.image.current;
    return [...this.image.history, ...(c?.ticket && c.receipt ? [{ ticket: c.ticket, receipt: c.receipt, admittedAssets: c.admittedAssets }] : [])];
  }
  private async compactRetained() {
    if (this.image.pendingEmptyRetirement) await this.retireEmptyRetained();
    const c = this.image.current;
    if (c && !c.cleaned) throw new Error("retained session must be closed and cleaned before compaction");
    const records = this.retainedReceipts();
    if (!records.length || records.length > MAX_RECEIPT_HISTORY) throw new Error("invalid compaction receipt count");
    if (c?.termination) await this.releaseTerminated();
    for (const record of records) await this.checkReceipt(record.ticket, record.receipt);
    const expected = { expectedCheckpointId: this.image.checkpoint?.checkpointId ?? null, ticketIds: records.map((r) => r.ticket.ticketId) };
    const pending = this.image.pendingCompaction;
    if (pending && (pending.expectedCheckpointId !== expected.expectedCheckpointId || JSON.stringify(pending.ticketIds) !== JSON.stringify(expected.ticketIds))) throw new Error("compaction intent does not match retained receipts");
    if (!pending) this.image = await this.o.store.write({ ...this.image, pendingCompaction: expected }, this.image.revision);
    const cp = await this.o.transport.compactInventory(expected.expectedCheckpointId, expected.ticketIds);
    if (!await verifyInventoryCheckpoint(cp, this.o.trustedKey, this.o.backend) || cp.statement.unit !== this.o.unit ||
        cp.statement.ownerPublicKey !== this.o.owner.publicKey || cp.statement.previousId !== expected.expectedCheckpointId ||
        cp.statement.revision !== (this.image.checkpoint?.statement.revision ?? 0) + 1 ||
        cp.statement.receiptCount !== (this.image.checkpoint?.statement.receiptCount ?? 0) + records.length ||
        cp.statement.itemCount !== (this.image.checkpoint?.statement.itemCount ?? 0) + records.reduce((n, r) => n + r.receipt.statement.items.length, 0) ||
        inventoryRetiredCount(cp) !== inventoryRetiredCount(this.image.checkpoint) || cp.statement.version === 2 && cp.statement.operation !== "append" ||
        this.image.checkpoint?.statement.version === 2 && cp.statement.version !== 2 ||
        cp.statement.batchDigest !== await inventoryBatchDigest(records, this.o.backend) ||
        cp.statement.root !== await inventoryNextRoot(this.image.checkpoint ?? null, cp.statement.batchDigest, this.o.backend)) throw new Error("invalid inventory compaction result");
    // Receipt removal and checkpoint adoption share one durable CAS transaction.
    this.image = await this.o.store.write({ ...this.image, current: null, history: [], checkpoint: cp, pendingCompaction: null }, this.image.revision);
    this.recorder?.close(); this.recorder = undefined; this.buffer = []; this.savedChunks = 0;
    this.preview = undefined; this.progress = 0; this.phase = "idle"; this.catalog = []; this.catalogNext = null; this.catalogAfter = 0;
  }
  async loadInventory(next = false) { return this.run(() => this.readInventory(next ? (this.catalogNext ?? 0) : 0)); }
  async retireEmptyInventory() { return this.run(async () => { await this.retireEmptyRetained(); await this.readInventory(0); }); }
  private async retireEmptyRetained() {
    const old = this.image.checkpoint; const c = this.image.current;
    if (!old || this.image.pendingCompaction || c && (!c.cleaned || c.recoveryReleasePending)) throw new Error("cleaned inventory checkpoint required");
    let command = this.image.pendingEmptyRetirement;
    if (!command) {
      const empty = this.catalog.filter((r) => r.receipt.statement.items.length === 0);
      if (!empty.length) throw new Error("no empty receipts on this page");
      for (const r of empty) await this.checkReceipt(r.ticket, r.receipt);
      command = { expectedCheckpointId: old.checkpointId, ticketIds: empty.map((r) => r.ticket.ticketId) };
    }
    if (command.expectedCheckpointId !== old.checkpointId || this.retainedReceipts().some((r) => command!.ticketIds.includes(r.ticket.ticketId))) throw new Error("empty retirement still has local recovery");
    if (!this.image.pendingEmptyRetirement) this.image = await this.o.store.write({ ...this.image, pendingEmptyRetirement: command }, this.image.revision);
    let cp: InventoryCheckpoint;
    try { cp = await this.o.transport.retireEmptyInventory(old.checkpointId, command.ticketIds); }
    catch (error) {
      // 409 is a definitive refusal from the trusted endpoint; no transaction
      // was committed. Keep ambiguous network/5xx failures pending for retry.
      if (error instanceof EncounterHttpError && error.status === 409) this.image = await this.o.store.write({ ...this.image, pendingEmptyRetirement: null }, this.image.revision);
      throw error;
    }
    if (!await verifyInventoryCheckpoint(cp, this.o.trustedKey, this.o.backend) || cp.statement.version !== 2 || cp.statement.operation !== "retire-empty" ||
        cp.statement.unit !== this.o.unit || cp.statement.ownerPublicKey !== this.o.owner.publicKey || cp.statement.previousId !== old.checkpointId ||
        cp.statement.revision !== old.statement.revision + 1 || cp.statement.receiptCount !== old.statement.receiptCount || cp.statement.itemCount !== old.statement.itemCount ||
        cp.statement.retiredEmptyCount !== inventoryRetiredCount(old) + command.ticketIds.length ||
        cp.statement.batchDigest !== await inventoryRetirementDigest(command.ticketIds, this.o.backend) ||
        cp.statement.root !== await inventoryNextRoot(old, cp.statement.batchDigest, this.o.backend, "retire-empty")) throw new Error("invalid empty retirement checkpoint");
    this.image = await this.o.store.write({ ...this.image, checkpoint: cp, pendingEmptyRetirement: null }, this.image.revision);
    this.catalog = []; this.catalogAfter = 0; this.catalogNext = null;
  }
  private async readInventory(after: number) {
    const cp = this.image.checkpoint;
    if (!cp) { this.catalog = []; this.catalogNext = null; this.catalogAfter = 0; return; }
    const page = await this.o.transport.inventoryPage(cp.checkpointId, after);
    if (!validInventoryPage(page, cp, after)) throw new Error("invalid inventory page");
    const ids = new Set<string>();
    for (const record of page.records) {
      if (!exactKeys(record, ["ticket", "receipt", "admittedAssets"]) || new TextEncoder().encode(JSON.stringify(record)).byteLength > 4_096) throw new Error("invalid inventory record");
      await this.checkReceipt(record.ticket, record.receipt);
      if (ids.has(record.ticket.ticketId) || !Array.isArray(record.admittedAssets) || record.admittedAssets.length > 1 ||
          record.admittedAssets.some((id) => !record.receipt.statement.items.some((item) => item.assetId === id))) throw new Error("invalid inventory record");
      ids.add(record.ticket.ticketId);
    }
    this.catalog = page.records; this.catalogAfter = after; this.catalogNext = page.next;
  }
  async archive() { return this.run(async () => {
    const current = this.image.current;
    if (!current?.receipt || current.cleaned || !this.recorder) throw new Error("retained settled log required for archive");
    const custody = await this.recorder.archive();
    if (await this.recorder.cleanupArchived(custody) !== "released") throw new Error("archive handoff refused");
    this.recorder.close(); this.recorder = undefined; this.savedChunks = 0;
    await this.save({ ...current, cleaned: true }); this.phase = "settled";
  }); }
  close() { this.recorder?.close(); this.recorder = undefined; }
  interrupt() { if (this.phase === "playing") { this.phase = "interrupted"; this.o.changed?.(); } }
}
