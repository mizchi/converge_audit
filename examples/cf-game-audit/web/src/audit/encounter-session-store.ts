import type { AsyncAuditSigner, StandardWebCryptoBackend, WebCryptoSigningKeyMaterial } from "../../../../player-local-runtime/crypto-backend.ts";
import { isDigest, isTime } from "../../../game/encounter/wire.ts";
import { exactKeys, identifier } from "../../../game/encounter/http-wire.ts";
import { MAX_CONTROL_BYTES, MAX_RECEIPT_HISTORY, type EncounterSessionImage } from "./encounter-session-contracts.ts";
import { validInventoryCheckpoint, validInventoryCompaction } from "../../../game/encounter/inventory-checkpoint.ts";

const STORE = "control";
const request = <T>(r: IDBRequest<T>) => new Promise<T>((resolve, reject) => {
  r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error);
});
const completed = (tx: IDBTransaction) => new Promise<void>((resolve, reject) => {
  tx.oncomplete = () => resolve(); tx.onabort = () => reject(tx.error ?? new Error("session transaction aborted"));
  tx.onerror = () => reject(tx.error);
});
function validate(image: EncounterSessionImage): void {
  if (!image || Object.keys(image).some((key) => !["version", "revision", "current", "history", "checkpoint", "pendingCompaction", "pendingEmptyRetirement"].includes(key)) ||
      !["version", "revision", "current", "history"].every((key) => Object.hasOwn(image, key)) ||
      image.version !== 1 || !isTime(image.revision) || !Array.isArray(image.history) || image.history.length > MAX_RECEIPT_HISTORY ||
      new TextEncoder().encode(JSON.stringify(image)).byteLength > MAX_CONTROL_BYTES) throw new Error("invalid session capacity");
  if (image.checkpoint != null && !validInventoryCheckpoint(image.checkpoint)) throw new Error("invalid inventory checkpoint");
  if (image.pendingCompaction != null && !validInventoryCompaction(image.pendingCompaction)) throw new Error("invalid compaction intent");
  if (image.pendingEmptyRetirement != null && (!validInventoryCompaction(image.pendingEmptyRetirement) || !image.checkpoint ||
      image.pendingEmptyRetirement.expectedCheckpointId !== image.checkpoint.checkpointId || image.pendingCompaction)) throw new Error("invalid empty retirement intent");
  if (image.current) {
    const c = image.current; const a = c.authorization;
    if (Object.keys(c).some((key) => !["authorization", "phase", "ticket", "receipt", "termination", "cleaned", "admittedAssets", "recoveryReleasePending"].includes(key)) ||
        !(exactKeys(a, ["unit", "startHead", "playerId", "ownerPublicKey"]) || exactKeys(a, ["unit", "startHead", "playerId", "ownerPublicKey", "generation"]) && isTime(a.generation)) || ![a.unit, a.startHead, a.playerId].every(identifier) || !isDigest(a.ownerPublicKey) ||
        !["starting", "playing", "complete", "committed", "settled", "terminated"].includes(c.phase) ||
        typeof c.cleaned !== "boolean" || !Array.isArray(c.admittedAssets) || c.admittedAssets.length > 1 ||
        new TextEncoder().encode(JSON.stringify(c)).byteLength > 8_192) throw new Error("invalid session record");
    if (c.recoveryReleasePending !== undefined && (c.recoveryReleasePending !== true || !c.cleaned || !c.ticket || !c.termination || c.receipt || c.phase !== "terminated" || c.admittedAssets.length)) throw new Error("invalid recovery release intent");
  }
  const ids = new Set<string>();
  for (const entry of image.history) {
    if (!exactKeys(entry, ["ticket", "receipt", "admittedAssets"]) || !entry.ticket || !entry.receipt || !Array.isArray(entry.admittedAssets) || entry.admittedAssets.length > 1 ||
        new TextEncoder().encode(JSON.stringify(entry)).byteLength > 4_096 || ids.has(entry.ticket.ticketId)) throw new Error("invalid receipt history");
    ids.add(entry.ticket.ticketId);
  }
}
export class IndexedDbEncounterSessionStore {
  private readonly db: IDBDatabase;
  private readonly fault?: () => void;
  private constructor(db: IDBDatabase, fault?: () => void) { this.db = db; this.fault = fault; }
  static async open(options: { factory: IDBFactory; name?: string; injectWriteFault?: () => void }): Promise<IndexedDbEncounterSessionStore> {
    const r = options.factory.open(options.name ?? "converge-audit-encounter-session-v1", 1);
    r.onupgradeneeded = () => r.result.createObjectStore(STORE);
    const db = await request(r); db.onversionchange = () => db.close();
    const store = new IndexedDbEncounterSessionStore(db, options.injectWriteFault);
    try { await store.read(); return store; } catch (error) { db.close(); throw error; }
  }
  close() { this.db.close(); }
  private async transaction<T>(mode: IDBTransactionMode, body: (tx: IDBTransaction) => Promise<T>): Promise<T> {
    const tx = this.db.transaction(STORE, mode, { durability: "strict" }); const done = completed(tx);
    try { const result = await body(tx); await done; return result; }
    catch (error) { try { tx.abort(); } catch { /* completed */ } await done.catch(() => undefined); throw error; }
  }
  async read(): Promise<EncounterSessionImage> {
    return this.transaction("readonly", async (tx) => {
      const image = await request(tx.objectStore(STORE).get("session")) as EncounterSessionImage | undefined;
      const value = image ?? { version: 1, revision: 0, current: null, history: [] };
      validate(value); return { ...value, checkpoint: value.checkpoint ?? null, pendingCompaction: value.pendingCompaction ?? null };
    });
  }
  async write(input: EncounterSessionImage, expectedRevision: number): Promise<EncounterSessionImage> {
    // Persist the bounded JSON image itself. Hidden ArrayBuffer/CryptoKey
    // properties must never bypass a JSON-byte check via structured clone.
    const text = JSON.stringify(input);
    if (typeof text !== "string" || new TextEncoder().encode(text).byteLength > MAX_CONTROL_BYTES) throw new Error("invalid session capacity");
    const image = JSON.parse(text) as EncounterSessionImage; validate(image);
    return this.transaction("readwrite", async (tx) => {
      const old = await request(tx.objectStore(STORE).get("session")) as EncounterSessionImage | undefined;
      const revision = old?.revision ?? 0;
      if (revision !== expectedRevision || revision === Number.MAX_SAFE_INTEGER) throw new Error("session revision changed");
      const next = { ...image, revision: revision + 1 };
      tx.objectStore(STORE).put(next, "session"); this.fault?.(); return next;
    });
  }
  async inspectKey(): Promise<WebCryptoSigningKeyMaterial> {
    const key = await this.transaction("readonly", (tx) => request(tx.objectStore(STORE).get("owner"))) as WebCryptoSigningKeyMaterial | undefined;
    if (!key) throw new Error("device key unavailable"); return key;
  }
  async owner(backend: StandardWebCryptoBackend): Promise<AsyncAuditSigner> {
    const stored = await this.transaction("readonly", (tx) => request(tx.objectStore(STORE).get("owner"))) as WebCryptoSigningKeyMaterial | undefined;
    if (stored) return backend.restoreSigningKey(stored);
    const image = await this.read();
    if (image.current || image.history.length || image.checkpoint || image.pendingCompaction || image.pendingEmptyRetirement) throw new Error("device key missing for retained sessions");
    const candidate = await backend.generateSigningKey();
    const material = await this.transaction("readwrite", async (tx) => {
      const current = await request(tx.objectStore(STORE).get("owner")) as WebCryptoSigningKeyMaterial | undefined;
      if (current) return current;
      // Key generation awaits WebCrypto outside this transaction. Retained
      // evidence may have appeared since the initial read; never orphan it.
      const retained = await request(tx.objectStore(STORE).get("session")) as EncounterSessionImage | undefined;
      if (retained) {
        validate(retained);
        if (retained.current || retained.history.length || retained.checkpoint || retained.pendingCompaction || retained.pendingEmptyRetirement) throw new Error("device key missing for retained sessions");
      }
      tx.objectStore(STORE).add(candidate.material, "owner"); return candidate.material;
    });
    return backend.restoreSigningKey(material);
  }
}
