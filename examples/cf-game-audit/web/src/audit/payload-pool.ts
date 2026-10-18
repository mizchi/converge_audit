import { MoonBitPayloadBudgetPolicy, payloadQueueLimitsValid, type PayloadQueueLimits } from "../../../../player-local-runtime/payload-budget.ts";
import type { AuditPayloadChunk, PayloadPruneGrant, PayloadQueueSnapshot } from "./bounded-payload-queue.ts";

const META = "pool_meta";
const SCOPES = "pool_scopes";
const CHUNKS = "pool_chunks";
const KEY = "singleton";
const MAX_BATCH = 64;
const MAX_SCOPES = 1_024;
const MAX_PENDING = 4;
const integer = (value: number) => Number.isSafeInteger(value) && value >= 0;
const digest = (value: string) => typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
const sameLimits = (a: PayloadQueueLimits, b: PayloadQueueLimits) =>
  a.maxBytes === b.maxBytes && a.reservedBytes === b.reservedBytes && a.maxItems === b.maxItems && a.maxItemBytes === b.maxItemBytes;

export interface PayloadPoolSnapshot {
  usedBytes: number;
  itemCount: number;
  queueCount: number;
  revision: number;
  reservedPayloadBytes: number;
  reservedItemCount: number;
}
export interface PayloadPoolOptions {
  factory: IDBFactory;
  /** ONE stable database name for all queues sharing this budget. */
  name: string;
  limits: PayloadQueueLimits;
  maxQueues: number;
  injectWriteFault?: () => void;
}
export interface PayloadScopeOptions {
  queueId: string;
  limits: PayloadQueueLimits;
  verifyPruneGrant(grant: Readonly<PayloadPruneGrant>): Promise<boolean>;
  /** Certifies irreversible terminality, closed retention and no unresolved
   * references for the ENTIRE scope. An ACK alone never authorizes this. */
  verifyClosureGrant?(grant: Readonly<PayloadScopeClosureGrant>): Promise<boolean>;
}
export interface PayloadScopeClosureGrant {
  queueId: string;
  expectedRevision: number;
  nextSequence: number;
  closureId: string;
  authorization: string;
}
export interface PooledAuditPayloadQueue {
  snapshot(): Promise<PayloadQueueSnapshot>;
  append(chunk: AuditPayloadChunk): Promise<"stored" | "duplicate" | "conflict" | "gap" | "pruned" | "backpressure" | "invalid">;
  readBatch(limit: number): Promise<AuditPayloadChunk[]>;
  prune(grant: PayloadPruneGrant): Promise<"pruned" | "refused" | "concurrent_write">;
  /** Remove metadata only after authenticated final deletion of every chunk. */
  release(grant: PayloadPruneGrant): Promise<"released" | "refused" | "concurrent_write">;
  /** Safe only if no chunk has EVER been written to this incarnation. */
  releaseEmpty(): Promise<"released" | "refused">;
  /** At most 64 retained chunks. Releases payload and remaining credit together. */
  releaseClosed(grant: PayloadScopeClosureGrant): Promise<"released" | "refused" | "concurrent_write">;
  close(): void;
}
interface PoolMetadata extends PayloadPoolSnapshot { key: typeof KEY; limits: PayloadQueueLimits; maxQueues: number }
interface ScopeMetadata extends PayloadQueueSnapshot {
  queueId: string;
  limits: PayloadQueueLimits;
  incarnation: number;
  lastPrunedDigest?: string;
  capacity?: { totalBytes: number; totalItems: number; remainingBytes: number; remainingItems: number };
}
interface StoredChunk extends AuditPayloadChunk { queueId: string }

function request<T>(value: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    value.addEventListener("success", () => resolve(value.result), { once: true });
    value.addEventListener("error", () => reject(value.error), { once: true });
  });
}
function completed(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.addEventListener("complete", () => resolve(), { once: true });
    tx.addEventListener("abort", () => reject(tx.error ?? new Error("payload pool transaction aborted")), { once: true });
    tx.addEventListener("error", () => reject(tx.error ?? new Error("payload pool transaction failed")), { once: true });
  });
}
function publicSnapshot(meta: ScopeMetadata): PayloadQueueSnapshot {
  return { usedBytes: meta.usedBytes, itemCount: meta.itemCount, firstSequence: meta.firstSequence,
    nextSequence: meta.nextSequence, revision: meta.revision };
}

/** All byte/count accounting, including scope registrations, uses ONE database
 * and ONE atomic transaction. Never evicts protected evidence to make room.
 * A pool-wide monotone revision prevents ABA when empty metadata is recycled. */
export class IndexedDbAuditPayloadPool {
  private readonly database: IDBDatabase;
  private readonly options: PayloadPoolOptions;
  private readonly policy: MoonBitPayloadBudgetPolicy;
  private pending = 0;
  private closed = false;
  private constructor(database: IDBDatabase, options: PayloadPoolOptions, policy: MoonBitPayloadBudgetPolicy) {
    this.database = database; this.options = options; this.policy = policy;
  }
  static async open(input: PayloadPoolOptions): Promise<IndexedDbAuditPayloadPool> {
    if (typeof input.name !== "string" || !input.name || input.name.length > 256 || !payloadQueueLimitsValid(input.limits) || !integer(input.maxQueues) || input.maxQueues < 1 || input.maxQueues > MAX_SCOPES) {
      throw new TypeError("invalid payload pool configuration");
    }
    const options = { ...input, limits: { ...input.limits } };
    const policy = await MoonBitPayloadBudgetPolicy.load();
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const open = options.factory.open(options.name, 1);
      open.addEventListener("upgradeneeded", () => {
        open.result.createObjectStore(META, { keyPath: "key" });
        open.result.createObjectStore(SCOPES, { keyPath: "queueId" });
        open.result.createObjectStore(CHUNKS, { keyPath: ["queueId", "sequence"] }).createIndex("by_queue", "queueId");
      });
      open.addEventListener("success", () => resolve(open.result), { once: true });
      open.addEventListener("error", () => reject(open.error), { once: true });
    });
    database.addEventListener("versionchange", () => database.close());
    const pool = new IndexedDbAuditPayloadPool(database, options, policy);
    try {
      if (![META, SCOPES, CHUNKS].every((store) => database.objectStoreNames.contains(store))) {
        throw new Error("legacy or incompatible payload database: use a separate pool name; retained data was not changed");
      }
      await pool.validate();
      return pool;
    } catch (error) { pool.close(); throw error; }
  }
  close(): void { this.closed = true; this.database.close(); }
  private async transaction<T>(mode: IDBTransactionMode, body: (tx: IDBTransaction) => Promise<T>): Promise<T> {
    if (this.closed) throw new Error("payload pool is closed");
    const tx = this.database.transaction([META, SCOPES, CHUNKS], mode, { durability: "strict" });
    const done = completed(tx);
    try { const value = await body(tx); await done; return value; }
    catch (error) { try { tx.abort(); } catch { /* Already completed/aborted. */ } await done.catch(() => undefined); throw error; }
  }
  private async metadata(tx: IDBTransaction): Promise<PoolMetadata> {
    const meta = await request(tx.objectStore(META).get(KEY)) as PoolMetadata | undefined;
    if (!meta) throw new Error("missing payload pool metadata");
    return meta;
  }
  private async scoped(tx: IDBTransaction, queueId: string, incarnation: number): Promise<ScopeMetadata> {
    const scope = await request(tx.objectStore(SCOPES).get(queueId)) as ScopeMetadata | undefined;
    if (!scope || scope.incarnation !== incarnation) throw new Error("queue released or generation changed");
    return scope;
  }
  async snapshot(): Promise<PayloadPoolSnapshot> {
    return this.transaction("readonly", async (tx) => {
      const { usedBytes, itemCount, queueCount, revision, reservedPayloadBytes, reservedItemCount } = await this.metadata(tx);
      return { usedBytes, itemCount, queueCount, revision, reservedPayloadBytes, reservedItemCount };
    });
  }
  /** Recovery lookup without registering or reserving a new scope. */
  async scopeSnapshot(queueId: string): Promise<PayloadQueueSnapshot | undefined> {
    if (typeof queueId !== "string" || !queueId || queueId.length > 128) throw new TypeError("invalid scope ID");
    return this.transaction("readonly", async (tx) => {
      const meta = await request(tx.objectStore(SCOPES).get(queueId)) as ScopeMetadata | undefined;
      return meta ? publicSnapshot(meta) : undefined;
    });
  }
  async queue(input: PayloadScopeOptions): Promise<PooledAuditPayloadQueue> {
    return this.openScope(input);
  }
  /** Reserve the entire bounded log before requesting a gameplay ticket.
   * Retries reopen the original credit; pruning never replenishes it. */
  async reserve(input: PayloadScopeOptions & { bytes: number; items: number }): Promise<PooledAuditPayloadQueue> {
    if (!integer(input.bytes) || !integer(input.items) || input.bytes < 1 || input.items < 1 ||
        input.bytes > input.limits.maxBytes - input.limits.reservedBytes || input.items > input.limits.maxItems) {
      throw new TypeError("invalid payload reservation configuration");
    }
    return this.openScope(input, { bytes: input.bytes, items: input.items });
  }
  private async openScope(input: PayloadScopeOptions, reservation?: { bytes: number; items: number }): Promise<PooledAuditPayloadQueue> {
    if (typeof input.queueId !== "string" || !input.queueId || input.queueId.length > 128 || !payloadQueueLimitsValid(input.limits) || typeof input.verifyPruneGrant !== "function") {
      throw new TypeError("invalid payload scope configuration");
    }
    const options = { ...input, limits: { ...input.limits } };
    const incarnation = await this.transaction("readwrite", async (tx) => {
      const existing = await request(tx.objectStore(SCOPES).get(options.queueId)) as ScopeMetadata | undefined;
      if (existing) {
        if (!sameLimits(existing.limits, options.limits)) throw new Error("payload scope configuration mismatch");
        if (!reservation) return existing.incarnation;
        if (existing.capacity) {
          if (existing.capacity.totalBytes !== reservation.bytes || existing.capacity.totalItems !== reservation.items) throw new Error("payload reservation configuration mismatch");
          return existing.incarnation;
        }
        if (existing.nextSequence !== 0) throw new Error("cannot reserve an already written payload scope");
      }
      const pool = await this.metadata(tx);
      if ((!existing && !this.policy.registersScope(pool.queueCount, pool.maxQueues)) || pool.revision === Number.MAX_SAFE_INTEGER) throw new Error("payload pool queue capacity exhausted");
      if (reservation && !this.policy.reserves(pool.limits, pool.usedBytes, pool.itemCount,
        pool.reservedPayloadBytes, pool.reservedItemCount, reservation.bytes, reservation.items)) throw new Error("payload reservation capacity exhausted");
      const revision = pool.revision + 1;
      const scope: ScopeMetadata = { queueId: options.queueId, limits: options.limits, incarnation: existing?.incarnation ?? revision,
        usedBytes: 0, itemCount: 0, firstSequence: 0, nextSequence: 0, revision,
        ...(reservation ? { capacity: { totalBytes: reservation.bytes, totalItems: reservation.items,
          remainingBytes: reservation.bytes, remainingItems: reservation.items } } : {}) };
      tx.objectStore(SCOPES).put(scope);
      this.options.injectWriteFault?.();
      tx.objectStore(META).put({ ...pool, queueCount: pool.queueCount + (existing ? 0 : 1), revision,
        reservedPayloadBytes: pool.reservedPayloadBytes + (reservation?.bytes ?? 0),
        reservedItemCount: pool.reservedItemCount + (reservation?.items ?? 0) });
      return scope.incarnation;
    });
    let closed = false;
    const scope = async (tx: IDBTransaction) => {
      if (closed) throw new Error("payload scope is closed");
      return this.scoped(tx, options.queueId, incarnation);
    };
    return {
      close: () => { closed = true; },
      snapshot: () => this.transaction("readonly", async (tx) => publicSnapshot(await scope(tx))),
      append: (input) => this.append(options, scope, input),
      readBatch: (limit) => {
        if (!integer(limit) || limit < 1 || limit > MAX_BATCH) return Promise.reject(new TypeError("invalid payload batch limit"));
        return this.transaction("readonly", async (tx) => {
          await scope(tx);
          const chunks = await request(tx.objectStore(CHUNKS).index("by_queue").getAll(options.queueId, limit)) as StoredChunk[];
          return chunks.map(({ queueId: _id, ...chunk }) => chunk);
        });
      },
      prune: (grant) => this.remove(options, scope, grant, false),
      release: (grant) => this.remove(options, scope, grant, true),
      releaseClosed: (grant) => this.removeClosed(options, scope, grant),
      releaseEmpty: () => this.transaction("readwrite", async (tx) => {
        const meta = await scope(tx); const pool = await this.metadata(tx);
        if (meta.nextSequence !== 0 || meta.itemCount !== 0 || meta.usedBytes !== 0 || pool.revision === Number.MAX_SAFE_INTEGER) return "refused";
        tx.objectStore(SCOPES).delete(options.queueId);
        this.options.injectWriteFault?.();
        tx.objectStore(META).put({ ...pool, queueCount: pool.queueCount - 1, revision: pool.revision + 1,
          reservedPayloadBytes: pool.reservedPayloadBytes - (meta.capacity?.remainingBytes ?? 0),
          reservedItemCount: pool.reservedItemCount - (meta.capacity?.remainingItems ?? 0) });
        return "released";
      }),
    };
  }
  private async removeClosed(options: PayloadScopeOptions, scoped: (tx: IDBTransaction) => Promise<ScopeMetadata>, input: PayloadScopeClosureGrant): Promise<"released" | "refused" | "concurrent_write"> {
    const grant = Object.freeze({ ...input });
    if (!options.verifyClosureGrant || grant.queueId !== options.queueId || !integer(grant.expectedRevision) ||
        !integer(grant.nextSequence) || !digest(grant.closureId) || typeof grant.authorization !== "string" ||
        grant.authorization.length > 16_384 || !await options.verifyClosureGrant(grant)) return "refused";
    return this.transaction("readwrite", async (tx) => {
      const meta = await scoped(tx); const pool = await this.metadata(tx);
      if (meta.revision !== grant.expectedRevision) return "concurrent_write";
      if (meta.nextSequence !== grant.nextSequence || meta.itemCount > MAX_BATCH || pool.revision === Number.MAX_SAFE_INTEGER) return "refused";
      const chunks = await request(tx.objectStore(CHUNKS).index("by_queue").getAll(options.queueId, MAX_BATCH + 1)) as StoredChunk[];
      if (chunks.length !== meta.itemCount || chunks.some((c, i) => c.sequence !== meta.firstSequence + i)) throw new Error("invalid terminal payload scope");
      const bytes = chunks.reduce((sum, c) => sum + c.payload.byteLength, 0);
      const creditBytes = meta.capacity?.remainingBytes ?? 0;
      const creditItems = meta.capacity?.remainingItems ?? 0;
      if (bytes !== meta.usedBytes || bytes > pool.usedBytes || meta.itemCount > pool.itemCount ||
          creditBytes > pool.reservedPayloadBytes || creditItems > pool.reservedItemCount || pool.queueCount < 1) throw new Error("invalid terminal payload accounting");
      for (const chunk of chunks) tx.objectStore(CHUNKS).delete([options.queueId, chunk.sequence]);
      tx.objectStore(SCOPES).delete(options.queueId);
      this.options.injectWriteFault?.();
      tx.objectStore(META).put({ ...pool, usedBytes: pool.usedBytes - bytes, itemCount: pool.itemCount - meta.itemCount,
        reservedPayloadBytes: pool.reservedPayloadBytes - creditBytes, reservedItemCount: pool.reservedItemCount - creditItems,
        queueCount: pool.queueCount - 1, revision: pool.revision + 1 });
      return "released";
    });
  }
  private async append(options: PayloadScopeOptions, scoped: (tx: IDBTransaction) => Promise<ScopeMetadata>, input: AuditPayloadChunk): Promise<Awaited<ReturnType<PooledAuditPayloadQueue["append"]>>> {
    if (!integer(input.sequence) || !digest(input.checkpointDigest) || !(input.payload instanceof Uint8Array) || input.payload.byteLength === 0) return "invalid";
    const bytes = input.payload.byteLength;
    if (this.pending >= MAX_PENDING || [options.limits, this.options.limits].some((l) => bytes > l.maxItemBytes || bytes > l.maxBytes - l.reservedBytes)) return "backpressure";
    this.pending++;
    try {
      const chunk: StoredChunk = { ...input, queueId: options.queueId, payload: new Uint8Array(input.payload) };
      if (chunk.payload.byteLength !== bytes) return "invalid";
      return await this.transaction("readwrite", async (tx) => {
        const meta = await scoped(tx); const pool = await this.metadata(tx);
        if (chunk.sequence < meta.firstSequence) return "pruned";
        if (chunk.sequence < meta.nextSequence) {
          const old = await request(tx.objectStore(CHUNKS).get([options.queueId, chunk.sequence])) as StoredChunk | undefined;
          if (!old) throw new Error("payload pool contains a gap");
          return old.checkpointDigest === chunk.checkpointDigest && old.payload.byteLength === bytes && old.payload.every((v, i) => v === chunk.payload[i]) ? "duplicate" : "conflict";
        }
        if (chunk.sequence !== meta.nextSequence) return "gap";
        if (pool.revision === Number.MAX_SAFE_INTEGER || meta.nextSequence === Number.MAX_SAFE_INTEGER ||
            !this.policy.admits(meta.limits, meta.usedBytes, meta.itemCount, bytes)) return "backpressure";
        const credit = meta.capacity;
        if (credit ? credit.remainingItems < 1 || bytes > credit.remainingBytes :
          !this.policy.admits(pool.limits, pool.usedBytes + pool.reservedPayloadBytes, pool.itemCount + pool.reservedItemCount, bytes)) return "backpressure";
        const releasedBytes = credit ? (credit.remainingItems === 1 ? credit.remainingBytes : bytes) : 0;
        const capacity = credit ? { ...credit, remainingItems: credit.remainingItems - 1,
          remainingBytes: credit.remainingItems === 1 ? 0 : credit.remainingBytes - bytes } : undefined;
        const revision = pool.revision + 1;
        tx.objectStore(CHUNKS).add(chunk);
        this.options.injectWriteFault?.();
        tx.objectStore(SCOPES).put({ ...meta, ...(capacity ? { capacity } : {}), usedBytes: meta.usedBytes + bytes, itemCount: meta.itemCount + 1, nextSequence: meta.nextSequence + 1, revision });
        tx.objectStore(META).put({ ...pool, usedBytes: pool.usedBytes + bytes, itemCount: pool.itemCount + 1, revision,
          reservedPayloadBytes: pool.reservedPayloadBytes - releasedBytes,
          reservedItemCount: pool.reservedItemCount - (credit ? 1 : 0) });
        return "stored";
      });
    } finally { this.pending--; }
  }
  private remove(options: PayloadScopeOptions, scoped: (tx: IDBTransaction) => Promise<ScopeMetadata>, input: PayloadPruneGrant, release: false): Promise<"pruned" | "refused" | "concurrent_write">;
  private remove(options: PayloadScopeOptions, scoped: (tx: IDBTransaction) => Promise<ScopeMetadata>, input: PayloadPruneGrant, release: true): Promise<"released" | "refused" | "concurrent_write">;
  private async remove(options: PayloadScopeOptions, scoped: (tx: IDBTransaction) => Promise<ScopeMetadata>, input: PayloadPruneGrant, release: boolean): Promise<"pruned" | "released" | "refused" | "concurrent_write"> {
    if (typeof input.authorization !== "string" || input.authorization.length > 16_384) return "refused";
    const grant = Object.freeze({ ...input });
    if (grant.queueId !== options.queueId || !integer(grant.expectedRevision) || !integer(grant.throughSequence) || !digest(grant.throughCheckpointDigest) ||
        !this.policy.prunable(grant) || !await options.verifyPruneGrant(grant)) return "refused";
    return this.transaction("readwrite", async (tx) => {
      const meta = await scoped(tx); const pool = await this.metadata(tx);
      if (meta.revision !== grant.expectedRevision) return "concurrent_write";
      if (pool.revision === Number.MAX_SAFE_INTEGER) return "refused";
      const revision = pool.revision + 1;
      if (release) {
        if (meta.itemCount !== 0 || meta.usedBytes !== 0 || meta.nextSequence === 0 || meta.firstSequence !== meta.nextSequence ||
            grant.throughSequence !== meta.nextSequence - 1 || grant.throughCheckpointDigest !== meta.lastPrunedDigest) return "refused";
        tx.objectStore(SCOPES).delete(options.queueId);
        this.options.injectWriteFault?.();
        tx.objectStore(META).put({ ...pool, queueCount: pool.queueCount - 1, revision,
          reservedPayloadBytes: pool.reservedPayloadBytes - (meta.capacity?.remainingBytes ?? 0),
          reservedItemCount: pool.reservedItemCount - (meta.capacity?.remainingItems ?? 0) });
        return "released";
      }
      const count = grant.throughSequence - meta.firstSequence + 1;
      if (count < 1 || count > MAX_BATCH || grant.throughSequence >= meta.nextSequence) return "refused";
      const chunks = await request(tx.objectStore(CHUNKS).index("by_queue").getAll(options.queueId, count)) as StoredChunk[];
      if (chunks.length !== count || chunks.some((c, i) => c.sequence !== meta.firstSequence + i) || chunks[count - 1].checkpointDigest !== grant.throughCheckpointDigest) return "refused";
      const bytes = chunks.reduce((sum, c) => sum + c.payload.byteLength, 0);
      if (bytes > meta.usedBytes || bytes > pool.usedBytes || count > pool.itemCount) throw new Error("invalid payload pool accounting");
      for (const chunk of chunks) tx.objectStore(CHUNKS).delete([options.queueId, chunk.sequence]);
      this.options.injectWriteFault?.();
      tx.objectStore(SCOPES).put({ ...meta, usedBytes: meta.usedBytes - bytes, itemCount: meta.itemCount - count,
        firstSequence: grant.throughSequence + 1, lastPrunedDigest: grant.throughCheckpointDigest, revision });
      tx.objectStore(META).put({ ...pool, usedBytes: pool.usedBytes - bytes, itemCount: pool.itemCount - count, revision });
      return "pruned";
    });
  }
  private async validate(): Promise<void> {
    await this.transaction("readwrite", async (tx) => {
      let pool = await request(tx.objectStore(META).get(KEY)) as PoolMetadata | undefined;
      if (!pool) {
        if (await request(tx.objectStore(SCOPES).count()) !== 0 || await request(tx.objectStore(CHUNKS).count()) !== 0) throw new Error("orphaned payload pool data");
        pool = { key: KEY, limits: this.options.limits, maxQueues: this.options.maxQueues, usedBytes: 0, itemCount: 0, queueCount: 0, revision: 0, reservedPayloadBytes: 0, reservedItemCount: 0 };
        tx.objectStore(META).add(pool);
      }
      // Previous format has no reservations. Upgrade both counters atomically.
      if (pool.reservedPayloadBytes === undefined && pool.reservedItemCount === undefined) {
        pool = { ...pool, reservedPayloadBytes: 0, reservedItemCount: 0 };
        tx.objectStore(META).put(pool);
      }
      if (!payloadQueueLimitsValid(pool.limits) || !sameLimits(pool.limits, this.options.limits) || pool.maxQueues !== this.options.maxQueues ||
          ![pool.usedBytes, pool.itemCount, pool.queueCount, pool.revision, pool.reservedPayloadBytes, pool.reservedItemCount].every(integer) || pool.queueCount > pool.maxQueues ||
          pool.usedBytes + pool.reservedPayloadBytes > pool.limits.maxBytes - pool.limits.reservedBytes ||
          pool.itemCount + pool.reservedItemCount > pool.limits.maxItems) throw new Error("payload pool configuration/accounting mismatch");
      const scopes = await request(tx.objectStore(SCOPES).getAll(undefined, this.options.maxQueues + 1)) as ScopeMetadata[];
      if (scopes.length !== pool.queueCount) throw new Error("payload pool scope count mismatch");
      const expected = new Map<string, { meta: ScopeMetadata; bytes: number; next: number }>();
      let declaredBytes = 0; let declaredItems = 0; let reservedBytes = 0; let reservedItems = 0;
      for (const meta of scopes) {
        if (!meta.queueId || meta.queueId.length > 128 || !payloadQueueLimitsValid(meta.limits) ||
            ![meta.usedBytes, meta.itemCount, meta.firstSequence, meta.nextSequence, meta.revision, meta.incarnation].every(integer) ||
            meta.incarnation < 1 || meta.incarnation > meta.revision || meta.revision > pool.revision ||
            meta.nextSequence - meta.firstSequence !== meta.itemCount || meta.itemCount > meta.limits.maxItems ||
            meta.usedBytes > meta.limits.maxBytes - meta.limits.reservedBytes ||
            (meta.firstSequence > 0 && !digest(meta.lastPrunedDigest!))) throw new Error("invalid payload scope accounting");
        declaredBytes += meta.usedBytes; declaredItems += meta.itemCount;
        if (meta.capacity) {
          const c = meta.capacity;
          if (![c.totalBytes, c.totalItems, c.remainingBytes, c.remainingItems].every(integer) ||
              c.totalBytes < 1 || c.totalItems < 1 || c.totalBytes > meta.limits.maxBytes - meta.limits.reservedBytes ||
              c.totalItems > meta.limits.maxItems || c.remainingBytes > c.totalBytes ||
              meta.usedBytes + c.remainingBytes > c.totalBytes ||
              c.remainingItems + meta.nextSequence !== c.totalItems ||
              (c.remainingItems === 0 && c.remainingBytes !== 0)) throw new Error("invalid payload reservation accounting");
          reservedBytes += c.remainingBytes; reservedItems += c.remainingItems;
        }
        expected.set(meta.queueId, { meta, bytes: 0, next: meta.firstSequence });
      }
      if (declaredBytes !== pool.usedBytes || declaredItems !== pool.itemCount ||
          reservedBytes !== pool.reservedPayloadBytes || reservedItems !== pool.reservedItemCount) throw new Error("payload pool usage mismatch (including reservations)");
      const total = pool;
      await new Promise<void>((resolve, reject) => {
        let bytes = 0; let items = 0;
        const cursor = tx.objectStore(CHUNKS).openCursor();
        cursor.addEventListener("error", () => reject(cursor.error));
        cursor.addEventListener("success", () => {
          const current = cursor.result;
          if (!current) {
            if (bytes !== total.usedBytes || items !== total.itemCount || [...expected.values()].some((s) => s.next !== s.meta.nextSequence || s.bytes !== s.meta.usedBytes)) reject(new Error("payload pool retained usage mismatch"));
            else resolve();
            return;
          }
          const chunk = current.value as StoredChunk; const state = expected.get(chunk.queueId);
          if (!state || chunk.sequence !== state.next || state.next >= state.meta.nextSequence || !digest(chunk.checkpointDigest) ||
              !(chunk.payload instanceof Uint8Array) || chunk.payload.byteLength < 1 ||
              chunk.payload.byteLength > state.meta.limits.maxItemBytes || chunk.payload.byteLength > total.limits.maxItemBytes || items >= total.itemCount) {
            reject(new Error("invalid retained pool chunk")); return;
          }
          state.bytes += chunk.payload.byteLength; state.next++; bytes += chunk.payload.byteLength; items++;
          if (bytes > total.usedBytes || state.bytes > state.meta.usedBytes) reject(new Error("payload pool byte mismatch"));
          else current.continue();
        });
      });
    });
  }
}
