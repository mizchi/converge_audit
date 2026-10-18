import {
  MoonBitPayloadBudgetPolicy,
  payloadQueueLimitsValid,
  type PayloadQueueLimits,
} from "../../../../player-local-runtime/payload-budget.ts";

const META = "payload_meta";
const CHUNKS = "payload_chunks";
const KEY = "singleton";
const MAX_BATCH = 64;
const MAX_GRANT_CHARS = 16_384;
const MAX_PENDING_APPENDS = 4;

export interface AuditPayloadChunk {
  sequence: number;
  checkpointDigest: string;
  payload: Uint8Array;
}

export interface PayloadQueueSnapshot {
  usedBytes: number;
  itemCount: number;
  firstSequence: number;
  nextSequence: number;
  revision: number;
}

interface Metadata extends PayloadQueueSnapshot {
  key: typeof KEY;
  queueId: string;
  limits: PayloadQueueLimits;
}

/** An authorization to irrevocably delete the WHOLE specified prefix.
 * The verifier must authenticate queue, revision, boundary digest and evidence
 * closure. A transport ACK alone is never this authorization. */
export interface PayloadPruneGrant {
  queueId: string;
  expectedRevision: number;
  throughSequence: number;
  throughCheckpointDigest: string;
  deliveryAcknowledged: boolean;
  gameplayFinalized: boolean;
  retentionClosed: boolean;
  unresolvedReference: boolean;
  authorization: string;
}

export interface AuditPayloadQueueOptions {
  factory: IDBFactory;
  name: string;
  queueId: string;
  limits: PayloadQueueLimits;
  /** Must validate trusted, final retention evidence, never client flags alone. */
  verifyPruneGrant: (grant: Readonly<PayloadPruneGrant>) => Promise<boolean>;
  injectWriteFault?: () => void;
}

function request<T>(value: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    value.addEventListener("success", () => resolve(value.result), { once: true });
    value.addEventListener("error", () => reject(value.error), { once: true });
  });
}

function completion(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.addEventListener("complete", () => resolve(), { once: true });
    tx.addEventListener("abort", () => reject(tx.error ?? new Error("payload transaction aborted")), { once: true });
    tx.addEventListener("error", () => reject(tx.error ?? new Error("payload transaction failed")), { once: true });
  });
}

function integer(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

function digest(value: string): boolean {
  return typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
}

function samePayload(left: AuditPayloadChunk, right: AuditPayloadChunk): boolean {
  return left.checkpointDigest === right.checkpointDigest &&
    left.payload.byteLength === right.payload.byteLength &&
    left.payload.every((value, index) => value === right.payload[index]);
}

/** Bounded raw replay chunks in a dedicated DB, separate from audit metadata.
 * IndexedDB protects honest-client crash consistency, not against its owner.
 * Nothing is evicted automatically to make room for another payload. */
export class IndexedDbAuditPayloadQueue {
  static async open(options: AuditPayloadQueueOptions): Promise<IndexedDbAuditPayloadQueue> {
    if (!options.queueId || options.queueId.length > 128 || !options.name ||
      !payloadQueueLimitsValid(options.limits) || typeof options.verifyPruneGrant !== "function") {
      throw new TypeError("invalid payload queue configuration");
    }
    const captured = { ...options, limits: { ...options.limits } };
    const policy = await MoonBitPayloadBudgetPolicy.load();
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const open = options.factory.open(options.name, 1);
      open.addEventListener("upgradeneeded", () => {
        open.result.createObjectStore(META, { keyPath: "key" });
        open.result.createObjectStore(CHUNKS, { keyPath: "sequence" });
      });
      open.addEventListener("success", () => resolve(open.result), { once: true });
      open.addEventListener("error", () => reject(open.error), { once: true });
    });
    database.addEventListener("versionchange", () => database.close());
    const queue = new IndexedDbAuditPayloadQueue(database, captured, policy);
    try {
      await queue.configureAndValidate();
      return queue;
    } catch (error) {
      database.close();
      throw error;
    }
  }

  private readonly database: IDBDatabase;
  private readonly options: AuditPayloadQueueOptions;
  private readonly policy: MoonBitPayloadBudgetPolicy;
  private pendingAppends = 0;

  private constructor(database: IDBDatabase, options: AuditPayloadQueueOptions, policy: MoonBitPayloadBudgetPolicy) {
    this.database = database;
    this.options = options;
    this.policy = policy;
  }

  close(): void { this.database.close(); }

  private async transaction<T>(mode: IDBTransactionMode, body: (tx: IDBTransaction) => Promise<T>): Promise<T> {
    const tx = this.database.transaction([META, CHUNKS], mode, { durability: "strict" });
    const done = completion(tx);
    try {
      const result = await body(tx);
      await done;
      return result;
    } catch (error) {
      try { tx.abort(); } catch { /* Already aborted/completed. */ }
      await done.catch(() => undefined);
      throw error;
    }
  }

  private async metadata(tx: IDBTransaction): Promise<Metadata> {
    const value = await request(tx.objectStore(META).get(KEY)) as Metadata | undefined;
    if (!value) throw new Error("missing payload queue metadata");
    return value;
  }

  async snapshot(): Promise<PayloadQueueSnapshot> {
    return this.transaction("readonly", async (tx) => {
      const { usedBytes, itemCount, firstSequence, nextSequence, revision } = await this.metadata(tx);
      return { usedBytes, itemCount, firstSequence, nextSequence, revision };
    });
  }

  async append(input: AuditPayloadChunk): Promise<
    "stored" | "duplicate" | "conflict" | "gap" | "pruned" | "backpressure" | "invalid"
  > {
    if (!integer(input.sequence) || !digest(input.checkpointDigest) ||
      !(input.payload instanceof Uint8Array) || input.payload.byteLength === 0) return "invalid";
    if (input.payload.byteLength > this.options.limits.maxItemBytes ||
      input.payload.byteLength > this.options.limits.maxBytes - this.options.limits.reservedBytes) return "backpressure";
    if (this.pendingAppends >= MAX_PENDING_APPENDS) return "backpressure";
    this.pendingAppends += 1;
    try {
      // Bound queued copies as well as persisted data; capture before DB awaits.
      const chunk = { ...input, payload: new Uint8Array(input.payload) };
      return await this.transaction("readwrite", async (tx) => {
        const meta = await this.metadata(tx);
        if (chunk.sequence < meta.firstSequence) return "pruned";
        if (chunk.sequence < meta.nextSequence) {
          const previous = await request(tx.objectStore(CHUNKS).get(chunk.sequence)) as AuditPayloadChunk | undefined;
          if (!previous) throw new Error("payload queue contains a gap");
          return samePayload(previous, chunk) ? "duplicate" : "conflict";
        }
        if (chunk.sequence !== meta.nextSequence) return "gap";
        if (meta.nextSequence === Number.MAX_SAFE_INTEGER || meta.revision === Number.MAX_SAFE_INTEGER ||
          !this.policy.admits(meta.limits, meta.usedBytes, meta.itemCount, chunk.payload.byteLength)) return "backpressure";
        tx.objectStore(CHUNKS).add(chunk);
        this.options.injectWriteFault?.();
        tx.objectStore(META).put({ ...meta, usedBytes: meta.usedBytes + chunk.payload.byteLength,
          itemCount: meta.itemCount + 1, nextSequence: meta.nextSequence + 1, revision: meta.revision + 1 });
        return "stored";
      });
    } finally { this.pendingAppends -= 1; }
  }

  /** Bound transient reads as well as persisted bytes. */
  async readBatch(limit: number): Promise<AuditPayloadChunk[]> {
    if (!integer(limit) || limit < 1 || limit > MAX_BATCH) throw new TypeError("invalid payload batch limit");
    return this.transaction("readonly", async (tx) =>
      await request(tx.objectStore(CHUNKS).getAll(undefined, limit)) as AuditPayloadChunk[]);
  }

  async prune(input: PayloadPruneGrant): Promise<"pruned" | "refused" | "concurrent_write"> {
    if (typeof input.authorization !== "string" || input.authorization.length > MAX_GRANT_CHARS) return "refused";
    const grant = Object.freeze({ ...input });
    if (grant.queueId !== this.options.queueId || !integer(grant.expectedRevision) ||
      !integer(grant.throughSequence) || !digest(grant.throughCheckpointDigest) ||
      !this.policy.prunable(grant) || !await this.options.verifyPruneGrant(grant)) return "refused";
    // No crypto/network awaits inside the IDB transaction.
    return this.transaction("readwrite", async (tx) => {
      const meta = await this.metadata(tx);
      if (meta.revision !== grant.expectedRevision) return "concurrent_write";
      const count = grant.throughSequence - meta.firstSequence + 1;
      if (count < 1 || count > MAX_BATCH || grant.throughSequence >= meta.nextSequence ||
        meta.revision === Number.MAX_SAFE_INTEGER) return "refused";
      const chunks = await request(tx.objectStore(CHUNKS).getAll(undefined, count)) as AuditPayloadChunk[];
      if (chunks.length !== count || chunks.some((chunk, index) => chunk.sequence !== meta.firstSequence + index) ||
        chunks[count - 1].checkpointDigest !== grant.throughCheckpointDigest) return "refused";
      const removedBytes = chunks.reduce((sum, chunk) => sum + chunk.payload.byteLength, 0);
      for (const chunk of chunks) tx.objectStore(CHUNKS).delete(chunk.sequence);
      this.options.injectWriteFault?.();
      tx.objectStore(META).put({ ...meta, usedBytes: meta.usedBytes - removedBytes,
        itemCount: meta.itemCount - count, firstSequence: grant.throughSequence + 1, revision: meta.revision + 1 });
      return "pruned";
    });
  }

  private async configureAndValidate(): Promise<void> {
    await this.transaction("readwrite", async (tx) => {
      let meta = await request(tx.objectStore(META).get(KEY)) as Metadata | undefined;
      if (!meta) {
        if (await request(tx.objectStore(CHUNKS).count()) !== 0) throw new Error("orphaned payload chunks");
        meta = { key: KEY, queueId: this.options.queueId, limits: this.options.limits,
          usedBytes: 0, itemCount: 0, firstSequence: 0, nextSequence: 0, revision: 0 };
        tx.objectStore(META).add(meta);
      }
      if (meta.queueId !== this.options.queueId || !payloadQueueLimitsValid(meta.limits) ||
        Object.keys(this.options.limits).some((key) => meta!.limits[key as keyof PayloadQueueLimits] !==
          this.options.limits[key as keyof PayloadQueueLimits]) ||
        ![meta.usedBytes, meta.itemCount, meta.firstSequence, meta.nextSequence, meta.revision].every(integer) ||
        meta.itemCount !== meta.nextSequence - meta.firstSequence ||
        meta.itemCount > meta.limits.maxItems || meta.usedBytes > meta.limits.maxBytes - meta.limits.reservedBytes) {
        throw new Error("payload queue configuration/accounting mismatch");
      }
      // Stream once on restart; normal append uses constant-many point operations.
      const expected = meta;
      await new Promise<void>((resolve, reject) => {
        let next = expected.firstSequence;
        let bytes = 0;
        const cursor = tx.objectStore(CHUNKS).openCursor();
        cursor.addEventListener("error", () => reject(cursor.error));
        cursor.addEventListener("success", () => {
          const current = cursor.result;
          if (!current) {
            if (next !== expected.nextSequence || bytes !== expected.usedBytes) reject(new Error("payload queue usage mismatch"));
            else resolve();
            return;
          }
          const chunk = current.value as AuditPayloadChunk;
          if (chunk.sequence !== next || !digest(chunk.checkpointDigest) ||
            !(chunk.payload instanceof Uint8Array) || chunk.payload.byteLength < 1 ||
            chunk.payload.byteLength > expected.limits.maxItemBytes || next >= expected.nextSequence) {
            reject(new Error("invalid retained payload chunk"));
            return;
          }
          bytes += chunk.payload.byteLength;
          next += 1;
          if (bytes > expected.usedBytes) reject(new Error("payload byte accounting mismatch"));
          else current.continue();
        });
      });
    });
  }
}
