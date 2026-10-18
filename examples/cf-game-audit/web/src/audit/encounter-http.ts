import type { AsyncAuditSigner, AuditCryptoBackend } from "../../../../player-local-runtime/crypto-backend.ts";
import type { InventoryCheckpoint, InventoryPage } from "../../../game/encounter/inventory-checkpoint.ts";
import type { AuditPayloadChunk, EncounterCommit, EncounterListing, EncounterReceipt, EncounterReveal, EncounterTicket, PayloadPruneGrant, EncounterTermination, EncounterTerminationReason, PayloadScopeClosureGrant } from "../../../game/encounter/contracts.ts";
import { signEncounterRequest, wireChunks, type EncounterCommand } from "../../../game/encounter/http-wire.ts";
import type { EncounterStartTransport } from "./encounter-recorder.ts";
import type { EncounterAuthorization, EncounterStatus } from "../../../game/encounter/contracts.ts";
import { decodeArchiveBundle, type ArchiveCustody, type ArchiveRelease, type EncounterArchive } from "../../../game/encounter/archive.ts";
import { isTime } from "../../../game/encounter/wire.ts";
import type { EncounterRecoveryRelease } from "../../../game/encounter/recovery.ts";

export interface HttpEncounterOptions {
  /** Host supplies the trusted HTTPS origin and unit; never take it from a ticket. */
  endpoint: string;
  unit: string;
  owner: AsyncAuditSigner;
  cryptoBackend: AuditCryptoBackend;
  fetch?: typeof fetch;
  now?: () => number;
}
export class EncounterHttpError extends Error {
  readonly status: number;
  constructor(status: number) { super(`encounter HTTP ${status}`); this.status = status; }
}
export class HttpEncounterTransport implements EncounterStartTransport {
  private readonly options: HttpEncounterOptions;
  constructor(options: HttpEncounterOptions) {
    const url = new URL(options.endpoint);
    const local = url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
    if ((!local && url.protocol !== "https:") || url.pathname !== `/v1/pve/${options.unit}/encounter` || url.search || url.hash || url.username || url.password) throw new Error("invalid encounter endpoint");
    this.options = { ...options };
  }
  private async call<T>(command: EncounterCommand): Promise<T> {
    const o = this.options;
    const envelope = await signEncounterRequest(o.unit, command, o.owner, o.cryptoBackend, (o.now ?? Date.now)());
    const response = await (o.fetch ?? fetch)(o.endpoint, { method: "POST", redirect: "error",
      headers: { "content-type": "application/json" }, body: JSON.stringify(envelope) });
    if (!response.ok) { await response.body?.cancel(); throw new EncounterHttpError(response.status); }
    const reader = response.body?.getReader(); if (!reader) throw new Error("empty encounter response");
    const parts: Uint8Array[] = []; let size = 0;
    try {
      for (;;) {
        const next = await reader.read(); if (next.done) break;
        size += next.value.byteLength;
        if (size > 16_384) { await reader.cancel(); throw new Error("encounter response too large"); }
        parts.push(next.value);
      }
    } finally { reader.releaseLock(); }
    const bytes = new Uint8Array(size); let offset = 0;
    for (const part of parts) { bytes.set(part, offset); offset += part.byteLength; }
    // Recorder verifies signed tickets, reveals, receipts and grants before use.
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as T;
  }
  start(startHead: string, generation = 0) {
    if (!isTime(generation)) throw new Error("invalid start generation");
    return this.call<EncounterTicket>({ op: "start", startHead, ...(generation > 0 ? { generation } : {}) });
  }
  admissions() { return this.call<EncounterAuthorization[]>({ op: "admissions" }); }
  releaseRecovery(ticket: EncounterTicket, termination: EncounterTermination) {
    return this.call<EncounterRecoveryRelease>({ op: "release-recovery", ticket, termination });
  }
  compactInventory(expectedCheckpointId: string | null, ticketIds: string[]) {
    return this.call<InventoryCheckpoint>({ op: "inventory-compact", expectedCheckpointId, ticketIds });
  }
  retireEmptyInventory(expectedCheckpointId: string, ticketIds: string[]) {
    return this.call<InventoryCheckpoint>({ op: "inventory-retire-empty", expectedCheckpointId, ticketIds });
  }
  inventoryPage(checkpointId: string, after = 0) { return this.call<InventoryPage>({ op: "inventory-page", checkpointId, after }); }
  status(ticketId: string) { return this.call<EncounterStatus>({ op: "status", ticketId }); }
  commit(commitment: EncounterCommit) { return this.call<{ root: string; committedAt: number }>({ op: "commit", commitment }); }
  reveal(ticketId: string) { return this.call<EncounterReveal>({ op: "reveal", ticketId }); }
  settle(ticketId: string, chunks: readonly AuditPayloadChunk[]) {
    return this.call<EncounterReceipt>(chunks.length ? { op: "settle", ticketId, chunks: wireChunks(chunks) } : { op: "receipt", ticketId });
  }
  admitToMarket(listing: EncounterListing) { return this.call<{ accepted: true; assetId: string }>({ op: "market", listing }); }
  pruneGrant(ticketId: string, expectedRevision: number) { return this.call<PayloadPruneGrant>({ op: "prune", ticketId, expectedRevision }); }
  terminate(ticketId: string, reason: EncounterTerminationReason) { return this.call<EncounterTermination>({ op: "terminate", ticketId, reason }); }
  closureGrant(ticketId: string, expectedRevision: number, nextSequence: number) {
    return this.call<PayloadScopeClosureGrant>({ op: "closure", ticketId, expectedRevision, nextSequence });
  }
  archiveUpload(ticketId: string, chunks: readonly AuditPayloadChunk[]) {
    return this.call<ArchiveCustody>({ op: "archive-upload", ticketId, chunks: wireChunks(chunks) });
  }
  archiveHandoff(ticketId: string, expectedRevision: number, nextSequence: number) {
    return this.call<PayloadScopeClosureGrant>({ op: "archive-handoff", ticketId, expectedRevision, nextSequence });
  }
  archiveRelease(ticketId: string) { return this.call<ArchiveRelease>({ op: "archive-release", ticketId }); }
  async archiveRead(ticketId: string): Promise<ReturnType<EncounterArchive["read"]>> {
    const object = await this.call<{ custody: ArchiveCustody; bundle: unknown; release?: ArchiveRelease }>({ op: "archive-read", ticketId });
    return { ...object, bundle: object.bundle === null ? null : decodeArchiveBundle(JSON.stringify(object.bundle)) };
  }
}
