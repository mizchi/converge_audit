import {
  isNonNegativeInteger,
  playerLocalAuditImageError,
  playerLocalBoundaryValid,
  playerLocalEvidenceInboxWriteSetValid,
  playerLocalEvidenceHoldValid,
  playerLocalEvidencePollJobDraftValid,
  playerLocalEventValid,
  playerLocalPruneWriteSetValid,
  playerLocalSealSnapshot,
  playerLocalSealWriteSetValid,
  samePlayerLocalBoundary,
  samePlayerLocalEvidencePollJobDraft,
  samePlayerLocalSnapshot,
  type AuditBoundary,
  type CheckpointAckEvidence,
  type CheckpointSealDraft,
  type CheckpointSealHead,
  type CheckpointSealStorageSnapshot,
  type EpochClosureEvidence,
  type PlayerLocalAuditEvent,
  type PlayerLocalAuditImage,
  type PlayerLocalAuditStorage,
  type PlayerLocalCheckpointOutboxRecord,
  type PlayerLocalEventAdmission,
  type PlayerLocalEvidenceHold,
  type PlayerLocalEvidenceHoldAdmission,
  type PlayerLocalEvidenceHoldResolution,
  type PlayerLocalEvidenceHoldResolutionResult,
  type PlayerLocalEvidenceInboxApplyResult,
  type PlayerLocalEvidenceInboxCursor,
  type PlayerLocalEvidenceInboxFaultPoint,
  type PlayerLocalEvidenceInboxWriteSet,
  type PlayerLocalEvidencePollJob,
  type PlayerLocalEvidencePollJobAdmission,
  type PlayerLocalEvidencePollJobClaimResult,
  type PlayerLocalEvidencePollJobCompletion,
  type PlayerLocalEvidencePollJobCompletionResult,
  type PlayerLocalEvidencePollJobDraft,
  type PlayerLocalEvidencePollJobEscalationResult,
  type PlayerLocalOutboxAckResult,
  type PlayerLocalPruneFaultPoint,
  type PlayerLocalPruneResult,
  type PlayerLocalPruneWriteSet,
  type PlayerLocalRetentionAnchor,
  type PlayerLocalSealCommitResult,
  type PlayerLocalSealFaultPoint,
  type PlayerLocalSealWriteSet,
  type PlayerLocalStoreConfiguration,
} from "../../../../player-local-runtime/contracts.ts";

const DATABASE_VERSION = 6;
const CONFIG_STORE = "player_local_config";
const EVENT_STORE = "player_local_events";
const EQUIVOCATION_STORE = "player_local_equivocations";
const CHECKPOINT_STORE = "player_local_checkpoints";
const HEAD_STORE = "player_local_head";
const RETENTION_STORE = "player_local_retention_anchor";
const EVIDENCE_HOLD_STORE = "player_local_evidence_holds";
const EVIDENCE_INBOX_CURSOR_STORE = "player_local_evidence_inbox_cursors";
const EVIDENCE_POLL_JOB_STORE = "player_local_evidence_poll_jobs";
const CLOSURE_STORE = "player_local_consumed_closures";
const OUTBOX_STORE = "player_local_outbox";
const ACK_STORE = "player_local_ack_history";
const OUTBOX_DELIVERY_INDEX = "delivery";
const SINGLETON_KEY = "singleton";

const ALL_STORES = [
  CONFIG_STORE,
  EVENT_STORE,
  EQUIVOCATION_STORE,
  CHECKPOINT_STORE,
  HEAD_STORE,
  RETENTION_STORE,
  EVIDENCE_HOLD_STORE,
  EVIDENCE_INBOX_CURSOR_STORE,
  EVIDENCE_POLL_JOB_STORE,
  CLOSURE_STORE,
  OUTBOX_STORE,
  ACK_STORE,
] as const;

interface StoredConfiguration {
  key: typeof SINGLETON_KEY;
  configuration: PlayerLocalStoreConfiguration;
  next_created_order: number;
  storage_revision: number;
}

interface StoredHead {
  key: typeof SINGLETON_KEY;
  head: CheckpointSealHead;
}

interface StoredRetentionAnchor {
  key: typeof SINGLETON_KEY;
  anchor: PlayerLocalRetentionAnchor;
}

interface StoredEquivocation {
  author_id: string;
  counter: number;
  event_digest: string;
  conflicting: PlayerLocalAuditEvent;
}

export class InjectedIndexedDbPlayerLocalSealFault extends Error {
  readonly faultPoint: PlayerLocalSealFaultPoint;

  constructor(faultPoint: PlayerLocalSealFaultPoint) {
    super(`injected IndexedDB player-local seal fault: ${faultPoint}`);
    this.faultPoint = faultPoint;
  }
}

export class InjectedIndexedDbPlayerLocalPruneFault extends Error {
  readonly faultPoint: PlayerLocalPruneFaultPoint;

  constructor(faultPoint: PlayerLocalPruneFaultPoint) {
    super(`injected IndexedDB player-local prune fault: ${faultPoint}`);
    this.faultPoint = faultPoint;
  }
}

export class InjectedIndexedDbPlayerLocalEvidenceInboxFault extends Error {
  readonly faultPoint: PlayerLocalEvidenceInboxFaultPoint;

  constructor(faultPoint: PlayerLocalEvidenceInboxFaultPoint) {
    super(`injected IndexedDB player-local evidence inbox fault: ${faultPoint}`);
    this.faultPoint = faultPoint;
  }
}

export class PlayerLocalIndexedDbCorruptError extends Error {
  constructor(message = "player-local IndexedDB image violates its contract") {
    super(message);
  }
}

export interface IndexedDbPlayerLocalStoreOptions {
  /** Test/platform hook for simulating quota or device write failures. */
  injectWriteFault?: (
    point:
      | PlayerLocalSealFaultPoint
      | PlayerLocalPruneFaultPoint
      | PlayerLocalEvidenceInboxFaultPoint,
  ) => void;
}

function requestResult<Value>(request: IDBRequest<Value>): Promise<Value> {
  return new Promise((resolve, reject) => {
    request.addEventListener("success", () => resolve(request.result), {
      once: true,
    });
    request.addEventListener(
      "error",
      () => reject(request.error ?? new Error("IndexedDB request failed")),
      { once: true },
    );
  });
}

function transactionComplete(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.addEventListener("complete", () => resolve(), { once: true });
    transaction.addEventListener(
      "abort",
      () => reject(
        transaction.error ?? new Error("IndexedDB transaction aborted"),
      ),
      { once: true },
    );
    transaction.addEventListener(
      "error",
      () => reject(
        transaction.error ?? new Error("IndexedDB transaction failed"),
      ),
      { once: true },
    );
  });
}

function abortTransaction(transaction: IDBTransaction): void {
  try {
    transaction.abort();
  } catch {
    // It may already have been aborted by a request error.
  }
}

function createSchema(database: IDBDatabase, transaction: IDBTransaction): void {
  const ensureStore = (
    name: string,
    options?: IDBObjectStoreParameters,
  ): IDBObjectStore =>
    database.objectStoreNames.contains(name)
      ? transaction.objectStore(name)
      : database.createObjectStore(name, options);

  ensureStore(CONFIG_STORE, { keyPath: "key" });
  ensureStore(EVENT_STORE, { keyPath: ["author_id", "counter"] });
  ensureStore(EQUIVOCATION_STORE, {
    keyPath: ["author_id", "counter", "event_digest"],
  });
  ensureStore(CHECKPOINT_STORE, { keyPath: "epoch" });
  ensureStore(HEAD_STORE, { keyPath: "key" });
  ensureStore(RETENTION_STORE, { keyPath: "key" });
  ensureStore(EVIDENCE_HOLD_STORE, { keyPath: "hold_id" });
  ensureStore(EVIDENCE_INBOX_CURSOR_STORE, { keyPath: "source_id" });
  ensureStore(EVIDENCE_POLL_JOB_STORE, { keyPath: "source_id" });
  ensureStore(CLOSURE_STORE, { keyPath: "epoch" });
  const outbox = ensureStore(OUTBOX_STORE, { keyPath: "created_order" });
  if (!outbox.indexNames.contains(OUTBOX_DELIVERY_INDEX)) {
    outbox.createIndex(
      OUTBOX_DELIVERY_INDEX,
      ["destination_id", "epoch", "checkpoint_digest"],
      { unique: true },
    );
  }
  ensureStore(ACK_STORE, {
    keyPath: ["authority_id", "epoch", "checkpoint_digest"],
  });
}

function openDatabase(
  factory: IDBFactory,
  name: string,
): Promise<IDBDatabase> {
  if (name.length === 0) return Promise.reject(new TypeError("empty database name"));
  return new Promise((resolve, reject) => {
    let settled = false;
    const rejectOnce = (error: unknown) => {
      if (settled) return;
      settled = true;
      reject(error);
    };
    const request = factory.open(name, DATABASE_VERSION);
    request.addEventListener("upgradeneeded", () => {
      const transaction = request.transaction;
      if (!transaction) {
        rejectOnce(new PlayerLocalIndexedDbCorruptError(
          "missing IndexedDB upgrade transaction",
        ));
        return;
      }
      createSchema(request.result, transaction);
    });
    request.addEventListener("success", () => {
      if (settled) {
        request.result.close();
        return;
      }
      settled = true;
      resolve(request.result);
    }, {
      once: true,
    });
    request.addEventListener(
      "error",
      () => rejectOnce(request.error ?? new Error("IndexedDB open failed")),
      { once: true },
    );
    request.addEventListener("blocked", () => {
      rejectOnce(new PlayerLocalIndexedDbCorruptError(
        "IndexedDB schema upgrade is blocked by another connection",
      ));
    }, { once: true });
  });
}

function sameConfiguration(
  left: PlayerLocalStoreConfiguration,
  right: PlayerLocalStoreConfiguration,
): boolean {
  return samePlayerLocalBoundary(left.boundary, right.boundary) &&
    left.genesis_digest === right.genesis_digest &&
    left.outbox_capacity === right.outbox_capacity;
}

function configurationValid(configuration: PlayerLocalStoreConfiguration): boolean {
  return playerLocalBoundaryValid(configuration.boundary) &&
    configuration.genesis_digest.length > 0 &&
    isNonNegativeInteger(configuration.outbox_capacity);
}

function ackValid(
  boundary: AuditBoundary,
  evidence: CheckpointAckEvidence,
): boolean {
  return samePlayerLocalBoundary(boundary, evidence.boundary) &&
    evidence.authority_id.length > 0 &&
    isNonNegativeInteger(evidence.epoch) &&
    evidence.checkpoint_digest.length > 0 &&
    (evidence.decision === "accepted" || evidence.decision === "duplicate");
}

function outboxDeliveryKey(
  destinationId: string,
  epoch: number,
  checkpointDigest: string,
): [string, number, string] {
  return [destinationId, epoch, checkpointDigest];
}

export class IndexedDbPlayerLocalStore implements PlayerLocalAuditStorage {
  static async open(
    factory: IDBFactory,
    name: string,
    configuration: PlayerLocalStoreConfiguration,
    options: IndexedDbPlayerLocalStoreOptions = {},
  ): Promise<IndexedDbPlayerLocalStore> {
    if (!configurationValid(configuration)) {
      throw new TypeError("invalid player-local store configuration");
    }
    const database = await openDatabase(factory, name);
    const store = new IndexedDbPlayerLocalStore(
      database,
      configuration,
      options.injectWriteFault,
    );
    database.addEventListener("versionchange", () => database.close());
    try {
      await store.configure();
      await store.assertValidImage();
      return store;
    } catch (error) {
      database.close();
      throw error;
    }
  }

  private readonly database: IDBDatabase;
  private readonly expectedConfiguration: PlayerLocalStoreConfiguration;
  private readonly injectWriteFault:
    | ((point:
      | PlayerLocalSealFaultPoint
      | PlayerLocalPruneFaultPoint
      | PlayerLocalEvidenceInboxFaultPoint,
    ) => void)
    | undefined;

  private constructor(
    database: IDBDatabase,
    expectedConfiguration: PlayerLocalStoreConfiguration,
    injectWriteFault:
      | ((point:
        | PlayerLocalSealFaultPoint
        | PlayerLocalPruneFaultPoint
        | PlayerLocalEvidenceInboxFaultPoint,
      ) => void)
      | undefined,
  ) {
    this.database = database;
    this.expectedConfiguration = expectedConfiguration;
    this.injectWriteFault = injectWriteFault;
  }

  close(): void {
    this.database.close();
  }

  async admitEvent(
    event: PlayerLocalAuditEvent,
  ): Promise<PlayerLocalEventAdmission> {
    if (!playerLocalEventValid(this.expectedConfiguration.boundary, event)) {
      return { decision: "refused", reason: "invalid_event" };
    }
    const transaction = this.database.transaction(
      [CONFIG_STORE, RETENTION_STORE, EVENT_STORE, EQUIVOCATION_STORE],
      "readwrite",
      { durability: "strict" },
    );
    const completed = transactionComplete(transaction);
    try {
      const configRequest = transaction.objectStore(CONFIG_STORE).get(SINGLETON_KEY);
      const acceptedRequest = transaction.objectStore(EVENT_STORE).get([
        event.author_id,
        event.counter,
      ]);
      const retentionRequest = transaction.objectStore(RETENTION_STORE)
        .get(SINGLETON_KEY);
      const [config, retention, accepted] = await Promise.all([
        requestResult(configRequest) as Promise<StoredConfiguration | undefined>,
        requestResult(retentionRequest) as Promise<
          StoredRetentionAnchor | undefined
        >,
        requestResult(acceptedRequest) as Promise<PlayerLocalAuditEvent | undefined>,
      ]);
      if (!config || !retention) {
        throw new PlayerLocalIndexedDbCorruptError("missing configuration/anchor");
      }
      if (event.epoch <= retention.anchor.epoch) {
        await completed;
        return { decision: "refused", reason: "pruned_epoch" };
      }
      if (!accepted) {
        transaction.objectStore(EVENT_STORE).add(event);
        transaction.objectStore(CONFIG_STORE).put({
          ...config,
          storage_revision: config.storage_revision + 1,
        });
        await completed;
        return { decision: "stored" };
      }
      if (accepted.event_digest === event.event_digest) {
        await completed;
        return accepted.epoch === event.epoch &&
            accepted.canonical_event === event.canonical_event
          ? { decision: "duplicate" }
          : { decision: "refused", reason: "digest_collision" };
      }
      const conflictRequest = transaction.objectStore(EQUIVOCATION_STORE).get([
        event.author_id,
        event.counter,
        event.event_digest,
      ]);
      const knownConflict = await requestResult(conflictRequest) as
        | StoredEquivocation
        | undefined;
      if (knownConflict) {
        await completed;
        return knownConflict.conflicting.epoch === event.epoch &&
            knownConflict.conflicting.canonical_event === event.canonical_event
          ? { decision: "equivocation" }
          : { decision: "refused", reason: "digest_collision" };
      }
      transaction.objectStore(EQUIVOCATION_STORE).add({
        author_id: event.author_id,
        counter: event.counter,
        event_digest: event.event_digest,
        conflicting: event,
      } satisfies StoredEquivocation);
      transaction.objectStore(CONFIG_STORE).put({
        ...config,
        storage_revision: config.storage_revision + 1,
      });
      await completed;
      return { decision: "equivocation" };
    } catch (error) {
      abortTransaction(transaction);
      await completed.catch(() => undefined);
      throw error;
    }
  }

  async commitSeal(
    writeSet: PlayerLocalSealWriteSet,
    faultPoint?: PlayerLocalSealFaultPoint,
  ): Promise<PlayerLocalSealCommitResult> {
    const transaction = this.database.transaction(
      [
        CONFIG_STORE,
        CHECKPOINT_STORE,
        HEAD_STORE,
        RETENTION_STORE,
        CLOSURE_STORE,
        OUTBOX_STORE,
      ],
      "readwrite",
      { durability: "strict" },
    );
    const completed = transactionComplete(transaction);
    try {
      const configPromise = requestResult(
        transaction.objectStore(CONFIG_STORE).get(SINGLETON_KEY),
      ) as Promise<StoredConfiguration | undefined>;
      const headPromise = requestResult(
        transaction.objectStore(HEAD_STORE).get(SINGLETON_KEY),
      ) as Promise<StoredHead | undefined>;
      const retentionPromise = requestResult(
        transaction.objectStore(RETENTION_STORE).get(SINGLETON_KEY),
      ) as Promise<StoredRetentionAnchor | undefined>;
      const checkpointsPromise = requestResult(
        transaction.objectStore(CHECKPOINT_STORE).getAll(),
      ) as Promise<CheckpointSealDraft[]>;
      const closuresPromise = requestResult(
        transaction.objectStore(CLOSURE_STORE).getAll(),
      ) as Promise<EpochClosureEvidence[]>;
      const outboxPromise = requestResult(
        transaction.objectStore(OUTBOX_STORE).getAll(),
      ) as Promise<PlayerLocalCheckpointOutboxRecord[]>;
      const [config, storedHead, storedRetention, checkpoints, closures, outbox] =
        await Promise.all([
          configPromise,
          headPromise,
          retentionPromise,
          checkpointsPromise,
          closuresPromise,
          outboxPromise,
        ]);
      if (!config || !storedHead || !storedRetention) {
        throw new PlayerLocalIndexedDbCorruptError("missing config/head/anchor");
      }
      if (config.storage_revision !== writeSet.expected_revision) {
        await completed;
        return { decision: "concurrent_write" };
      }
      const actualSnapshot = playerLocalSealSnapshot(
        {
          boundary: config.configuration.boundary,
          genesis_digest: config.configuration.genesis_digest,
          outbox_capacity: config.configuration.outbox_capacity,
          events: [],
          equivocations: [],
          checkpoints,
          head: storedHead.head,
          retention_anchor: storedRetention.anchor,
          evidence_holds: [],
          evidence_inbox_cursors: [],
          evidence_poll_jobs: [],
          consumed_closures: closures,
          outbox,
          ack_history: [],
          next_created_order: config.next_created_order,
          storage_revision: config.storage_revision,
        },
        writeSet.checkpoint,
        writeSet.outbox_entries.map((entry) => entry.destination_id),
      );
      if (!samePlayerLocalSnapshot(actualSnapshot, writeSet.expected_snapshot)) {
        await completed;
        return { decision: "concurrent_write" };
      }
      if (!playerLocalSealWriteSetValid(config.configuration, writeSet)) {
        await completed;
        return { decision: "refused", reason: "invalid_write_set" };
      }

      transaction.objectStore(CHECKPOINT_STORE).add(writeSet.checkpoint);
      this.inject(faultPoint, "after_history");
      transaction.objectStore(HEAD_STORE).put({
        key: SINGLETON_KEY,
        head: writeSet.next_head,
      } satisfies StoredHead);
      this.inject(faultPoint, "after_head");
      for (const entry of writeSet.outbox_entries) {
        transaction.objectStore(OUTBOX_STORE).add(entry);
      }
      this.inject(faultPoint, "after_outbox");
      transaction.objectStore(CLOSURE_STORE).add(writeSet.consumed_closure);
      this.inject(faultPoint, "after_closure");
      transaction.objectStore(CONFIG_STORE).put({
        ...config,
        next_created_order: writeSet.next_created_order,
        storage_revision: config.storage_revision + 1,
      });
      await completed;
      return { decision: "committed" };
    } catch (error) {
      abortTransaction(transaction);
      await completed.catch(() => undefined);
      throw error;
    }
  }

  async claimOutbox(
    createdOrder: number,
    nowMs: number,
    leaseDurationMs: number,
  ): Promise<PlayerLocalCheckpointOutboxRecord | undefined> {
    if (
      !isNonNegativeInteger(createdOrder) ||
      !isNonNegativeInteger(nowMs) ||
      !Number.isSafeInteger(leaseDurationMs) ||
      leaseDurationMs <= 0
    ) return undefined;
    const leaseExpiresAt = nowMs + leaseDurationMs;
    if (!Number.isSafeInteger(leaseExpiresAt) || leaseExpiresAt < nowMs) {
      return undefined;
    }
    const transaction = this.database.transaction(
      [CONFIG_STORE, OUTBOX_STORE],
      "readwrite",
      { durability: "strict" },
    );
    const completed = transactionComplete(transaction);
    try {
      const configRequest = transaction.objectStore(CONFIG_STORE).get(SINGLETON_KEY);
      const rowRequest = transaction.objectStore(OUTBOX_STORE).get(createdOrder);
      const [config, row] = await Promise.all([
        requestResult(configRequest) as Promise<StoredConfiguration | undefined>,
        requestResult(rowRequest) as Promise<
          PlayerLocalCheckpointOutboxRecord | undefined
        >,
      ]);
      if (!config) throw new PlayerLocalIndexedDbCorruptError("missing configuration");
      if (
        !row ||
        row.state.kind === "acknowledged" ||
        (row.state.kind === "in_flight" &&
          row.state.lease_expires_at_ms > nowMs)
      ) {
        await completed;
        return undefined;
      }
      const claimed: PlayerLocalCheckpointOutboxRecord = {
        ...row,
        state: { kind: "in_flight", lease_expires_at_ms: leaseExpiresAt },
      };
      transaction.objectStore(OUTBOX_STORE).put(claimed);
      transaction.objectStore(CONFIG_STORE).put({
        ...config,
        storage_revision: config.storage_revision + 1,
      });
      await completed;
      return claimed;
    } catch (error) {
      abortTransaction(transaction);
      await completed.catch(() => undefined);
      throw error;
    }
  }

  async releaseOutbox(createdOrder: number): Promise<boolean> {
    if (!isNonNegativeInteger(createdOrder)) return false;
    const transaction = this.database.transaction(
      [CONFIG_STORE, OUTBOX_STORE],
      "readwrite",
      { durability: "strict" },
    );
    const completed = transactionComplete(transaction);
    try {
      const configRequest = transaction.objectStore(CONFIG_STORE).get(SINGLETON_KEY);
      const rowRequest = transaction.objectStore(OUTBOX_STORE).get(createdOrder);
      const [config, row] = await Promise.all([
        requestResult(configRequest) as Promise<StoredConfiguration | undefined>,
        requestResult(rowRequest) as Promise<
          PlayerLocalCheckpointOutboxRecord | undefined
        >,
      ]);
      if (!config) throw new PlayerLocalIndexedDbCorruptError("missing configuration");
      if (!row || row.state.kind !== "in_flight") {
        await completed;
        return false;
      }
      transaction.objectStore(OUTBOX_STORE).put({
        ...row,
        state: { kind: "pending" },
      } satisfies PlayerLocalCheckpointOutboxRecord);
      transaction.objectStore(CONFIG_STORE).put({
        ...config,
        storage_revision: config.storage_revision + 1,
      });
      await completed;
      return true;
    } catch (error) {
      abortTransaction(transaction);
      await completed.catch(() => undefined);
      throw error;
    }
  }

  async acknowledgeOutbox(
    evidence: CheckpointAckEvidence,
  ): Promise<PlayerLocalOutboxAckResult> {
    if (!ackValid(this.expectedConfiguration.boundary, evidence)) {
      return { decision: "refused", reason: "invalid_ack" };
    }
    const transaction = this.database.transaction(
      [CONFIG_STORE, OUTBOX_STORE, ACK_STORE],
      "readwrite",
      { durability: "strict" },
    );
    const completed = transactionComplete(transaction);
    try {
      const configRequest = transaction.objectStore(CONFIG_STORE).get(SINGLETON_KEY);
      const rowRequest = transaction.objectStore(OUTBOX_STORE)
        .index(OUTBOX_DELIVERY_INDEX)
        .get(outboxDeliveryKey(
          evidence.authority_id,
          evidence.epoch,
          evidence.checkpoint_digest,
        ));
      const [config, row] = await Promise.all([
        requestResult(configRequest) as Promise<StoredConfiguration | undefined>,
        requestResult(rowRequest) as Promise<
          PlayerLocalCheckpointOutboxRecord | undefined
        >,
      ]);
      if (!config) throw new PlayerLocalIndexedDbCorruptError("missing configuration");
      if (!row) {
        await completed;
        return { decision: "refused", reason: "ack_mismatch" };
      }
      if (row.state.kind === "acknowledged") {
        await completed;
        return { decision: "no_change" };
      }
      transaction.objectStore(ACK_STORE).add(evidence);
      transaction.objectStore(OUTBOX_STORE).put({
        ...row,
        state: { kind: "acknowledged" },
      } satisfies PlayerLocalCheckpointOutboxRecord);
      transaction.objectStore(CONFIG_STORE).put({
        ...config,
        storage_revision: config.storage_revision + 1,
      });
      await completed;
      return { decision: "updated" };
    } catch (error) {
      abortTransaction(transaction);
      await completed.catch(() => undefined);
      throw error;
    }
  }

  async placeEvidenceHold(
    hold: PlayerLocalEvidenceHold,
  ): Promise<PlayerLocalEvidenceHoldAdmission> {
    if (
      !playerLocalEvidenceHoldValid(this.expectedConfiguration.boundary, hold) ||
      hold.state.kind !== "active"
    ) return { decision: "refused", reason: "invalid_hold" };
    const transaction = this.database.transaction(
      [CONFIG_STORE, RETENTION_STORE, CHECKPOINT_STORE, EVIDENCE_HOLD_STORE],
      "readwrite",
      { durability: "strict" },
    );
    const completed = transactionComplete(transaction);
    try {
      const [config, retention, checkpoint, existing] = await Promise.all([
        requestResult(transaction.objectStore(CONFIG_STORE).get(SINGLETON_KEY)) as
          Promise<StoredConfiguration | undefined>,
        requestResult(transaction.objectStore(RETENTION_STORE).get(SINGLETON_KEY)) as
          Promise<StoredRetentionAnchor | undefined>,
        requestResult(transaction.objectStore(CHECKPOINT_STORE).get(hold.epoch)) as
          Promise<CheckpointSealDraft | undefined>,
        requestResult(transaction.objectStore(EVIDENCE_HOLD_STORE).get(hold.hold_id)) as
          Promise<PlayerLocalEvidenceHold | undefined>,
      ]);
      if (!config || !retention) {
        throw new PlayerLocalIndexedDbCorruptError("missing configuration/anchor");
      }
      if (existing) {
        await completed;
        return existing.epoch === hold.epoch &&
            existing.checkpoint_digest === hold.checkpoint_digest &&
            existing.kind === hold.kind &&
            existing.reference_digest === hold.reference_digest
          ? { decision: "duplicate" }
          : { decision: "refused", reason: "hold_conflict" };
      }
      if (hold.epoch <= retention.anchor.epoch) {
        await completed;
        return { decision: "refused", reason: "pruned_epoch" };
      }
      if (!checkpoint || checkpoint.checkpoint_digest !== hold.checkpoint_digest) {
        await completed;
        return { decision: "refused", reason: "checkpoint_mismatch" };
      }
      transaction.objectStore(EVIDENCE_HOLD_STORE).add(hold);
      transaction.objectStore(CONFIG_STORE).put({
        ...config,
        storage_revision: config.storage_revision + 1,
      });
      await completed;
      return { decision: "stored" };
    } catch (error) {
      abortTransaction(transaction);
      await completed.catch(() => undefined);
      throw error;
    }
  }

  async resolveEvidenceHold(
    resolution: PlayerLocalEvidenceHoldResolution,
  ): Promise<PlayerLocalEvidenceHoldResolutionResult> {
    if (
      !samePlayerLocalBoundary(
        this.expectedConfiguration.boundary,
        resolution.boundary,
      ) ||
      resolution.hold_id.length === 0 ||
      !isNonNegativeInteger(resolution.epoch) ||
      resolution.checkpoint_digest.length === 0 ||
      resolution.reference_digest.length === 0 ||
      (resolution.decision !== "upheld" &&
        resolution.decision !== "dismissed") ||
      resolution.resolution_digest.length === 0
    ) return { decision: "refused", reason: "invalid_resolution" };
    const transaction = this.database.transaction(
      [CONFIG_STORE, EVIDENCE_HOLD_STORE],
      "readwrite",
      { durability: "strict" },
    );
    const completed = transactionComplete(transaction);
    try {
      const [config, existing] = await Promise.all([
        requestResult(transaction.objectStore(CONFIG_STORE).get(SINGLETON_KEY)) as
          Promise<StoredConfiguration | undefined>,
        requestResult(transaction.objectStore(EVIDENCE_HOLD_STORE)
          .get(resolution.hold_id)) as Promise<PlayerLocalEvidenceHold | undefined>,
      ]);
      if (!config) {
        throw new PlayerLocalIndexedDbCorruptError("missing configuration");
      }
      if (!existing) {
        await completed;
        return { decision: "refused", reason: "hold_missing" };
      }
      if (
        existing.epoch !== resolution.epoch ||
        existing.checkpoint_digest !== resolution.checkpoint_digest ||
        existing.reference_digest !== resolution.reference_digest
      ) {
        await completed;
        return { decision: "refused", reason: "hold_mismatch" };
      }
      if (existing.state.kind === "resolved") {
        await completed;
        return existing.state.decision === resolution.decision &&
            existing.state.resolution_digest === resolution.resolution_digest
          ? { decision: "no_change" }
          : { decision: "refused", reason: "resolution_conflict" };
      }
      transaction.objectStore(EVIDENCE_HOLD_STORE).put({
        ...existing,
        state: {
          kind: "resolved",
          decision: resolution.decision,
          resolution_digest: resolution.resolution_digest,
        },
      } satisfies PlayerLocalEvidenceHold);
      transaction.objectStore(CONFIG_STORE).put({
        ...config,
        storage_revision: config.storage_revision + 1,
      });
      await completed;
      return { decision: "resolved" };
    } catch (error) {
      abortTransaction(transaction);
      await completed.catch(() => undefined);
      throw error;
    }
  }

  async applyEvidenceInbox(
    writeSet: PlayerLocalEvidenceInboxWriteSet,
    faultPoint?: PlayerLocalEvidenceInboxFaultPoint,
  ): Promise<PlayerLocalEvidenceInboxApplyResult> {
    const transaction = this.database.transaction(
      [...ALL_STORES],
      "readwrite",
      { durability: "strict" },
    );
    const completed = transactionComplete(transaction);
    try {
      const current = await this.readImage(transaction);
      if (current.storage_revision !== writeSet.expected_revision) {
        await completed;
        return { decision: "concurrent_write" };
      }
      if (!playerLocalEvidenceInboxWriteSetValid(current, writeSet)) {
        await completed;
        return { decision: "refused", reason: "invalid_write_set" };
      }
      const holdStore = transaction.objectStore(EVIDENCE_HOLD_STORE);
      const operation = writeSet.operation;
      if (operation.kind === "place") {
        if (!current.evidence_holds.some((hold) =>
          hold.hold_id === operation.hold.hold_id
        )) holdStore.add(operation.hold);
      } else {
        const existing = current.evidence_holds.find((hold) =>
          hold.hold_id === operation.resolution.hold_id
        )!;
        if (existing.state.kind === "active") {
          holdStore.put({
            ...existing,
            state: {
              kind: "resolved",
              decision: operation.resolution.decision,
              resolution_digest: operation.resolution.resolution_digest,
            },
          } satisfies PlayerLocalEvidenceHold);
        }
      }
      this.injectEvidenceInbox(faultPoint, "after_hold");
      const cursorStore = transaction.objectStore(EVIDENCE_INBOX_CURSOR_STORE);
      if (writeSet.expected_cursor.sequence === -1) {
        cursorStore.add(writeSet.next_cursor);
      } else {
        cursorStore.put(writeSet.next_cursor);
      }
      this.injectEvidenceInbox(faultPoint, "after_cursor");
      const config = await requestResult(
        transaction.objectStore(CONFIG_STORE).get(SINGLETON_KEY),
      ) as StoredConfiguration | undefined;
      if (!config || config.storage_revision !== writeSet.expected_revision) {
        throw new PlayerLocalIndexedDbCorruptError(
          "configuration changed during evidence inbox apply",
        );
      }
      transaction.objectStore(CONFIG_STORE).put({
        ...config,
        storage_revision: config.storage_revision + 1,
      });
      await completed;
      return { decision: "applied" };
    } catch (error) {
      abortTransaction(transaction);
      await completed.catch(() => undefined);
      throw error;
    }
  }

  async scheduleEvidencePollJob(
    draft: PlayerLocalEvidencePollJobDraft,
  ): Promise<PlayerLocalEvidencePollJobAdmission> {
    if (!playerLocalEvidencePollJobDraftValid(
      this.expectedConfiguration.boundary,
      draft,
    )) return { decision: "refused", reason: "invalid_job" };
    const transaction = this.database.transaction(
      [CONFIG_STORE, EVIDENCE_POLL_JOB_STORE],
      "readwrite",
      { durability: "strict" },
    );
    const completed = transactionComplete(transaction);
    try {
      const [config, existing] = await Promise.all([
        requestResult(transaction.objectStore(CONFIG_STORE).get(SINGLETON_KEY)) as
          Promise<StoredConfiguration | undefined>,
        requestResult(
          transaction.objectStore(EVIDENCE_POLL_JOB_STORE).get(draft.source_id),
        ) as Promise<PlayerLocalEvidencePollJob | undefined>,
      ]);
      if (!config) throw new PlayerLocalIndexedDbCorruptError("missing configuration");
      if (existing) {
        await completed;
        return samePlayerLocalEvidencePollJobDraft(existing, draft)
          ? { decision: "duplicate" }
          : { decision: "refused", reason: "source_conflict" };
      }
      transaction.objectStore(EVIDENCE_POLL_JOB_STORE).add({
        ...draft,
        failures: 0,
        attempt_count: 0,
        state: { kind: "scheduled" },
      } satisfies PlayerLocalEvidencePollJob);
      transaction.objectStore(CONFIG_STORE).put({
        ...config,
        storage_revision: config.storage_revision + 1,
      });
      await completed;
      return { decision: "stored" };
    } catch (error) {
      abortTransaction(transaction);
      await completed.catch(() => undefined);
      throw error;
    }
  }

  async claimEvidencePollJob(
    sourceId: string,
    nowMs: number,
    leaseDurationMs: number,
  ): Promise<PlayerLocalEvidencePollJobClaimResult> {
    if (
      sourceId.length === 0 ||
      sourceId.length > 256 ||
      !isNonNegativeInteger(nowMs) ||
      !Number.isSafeInteger(leaseDurationMs) ||
      leaseDurationMs <= 0
    ) return { decision: "refused", reason: "invalid_claim" };
    const requestedLeaseExpiry = nowMs + leaseDurationMs;
    if (
      !Number.isSafeInteger(requestedLeaseExpiry) ||
      requestedLeaseExpiry <= nowMs
    ) return { decision: "refused", reason: "invalid_claim" };
    const transaction = this.database.transaction(
      [CONFIG_STORE, EVIDENCE_POLL_JOB_STORE],
      "readwrite",
      { durability: "strict" },
    );
    const completed = transactionComplete(transaction);
    try {
      const [config, job] = await Promise.all([
        requestResult(transaction.objectStore(CONFIG_STORE).get(SINGLETON_KEY)) as
          Promise<StoredConfiguration | undefined>,
        requestResult(
          transaction.objectStore(EVIDENCE_POLL_JOB_STORE).get(sourceId),
        ) as Promise<PlayerLocalEvidencePollJob | undefined>,
      ]);
      if (!config) throw new PlayerLocalIndexedDbCorruptError("missing configuration");
      if (!job) {
        await completed;
        return { decision: "not_found" };
      }
      if (job.state.kind === "expired" || job.state.kind === "escalated") {
        await completed;
        return { decision: "terminal", state: job.state.kind };
      }
      if (nowMs >= job.deadline_at_ms) {
        transaction.objectStore(EVIDENCE_POLL_JOB_STORE).put({
          ...job,
          state: { kind: "expired", expired_at_ms: nowMs },
        } satisfies PlayerLocalEvidencePollJob);
        transaction.objectStore(CONFIG_STORE).put({
          ...config,
          storage_revision: config.storage_revision + 1,
        });
        await completed;
        return { decision: "terminal", state: "expired" };
      }
      if (
        (job.state.kind === "scheduled" && job.next_poll_at_ms > nowMs) ||
        (job.state.kind === "in_flight" &&
          job.state.lease_expires_at_ms > nowMs)
      ) {
        await completed;
        return { decision: "not_due" };
      }
      const attemptCount = job.attempt_count + 1;
      if (!Number.isSafeInteger(attemptCount)) {
        await completed;
        return { decision: "refused", reason: "attempt_overflow" };
      }
      const claimed: PlayerLocalEvidencePollJob = {
        ...job,
        attempt_count: attemptCount,
        state: {
          kind: "in_flight",
          lease_expires_at_ms: Math.min(
            requestedLeaseExpiry,
            job.deadline_at_ms,
          ),
        },
      };
      transaction.objectStore(EVIDENCE_POLL_JOB_STORE).put(claimed);
      transaction.objectStore(CONFIG_STORE).put({
        ...config,
        storage_revision: config.storage_revision + 1,
      });
      await completed;
      return { decision: "claimed", job: claimed };
    } catch (error) {
      abortTransaction(transaction);
      await completed.catch(() => undefined);
      throw error;
    }
  }

  async completeEvidencePollJob(
    completion: PlayerLocalEvidencePollJobCompletion,
  ): Promise<PlayerLocalEvidencePollJobCompletionResult> {
    if (
      completion.source_id.length === 0 ||
      completion.source_id.length > 256 ||
      !isNonNegativeInteger(completion.expected_attempt_count) ||
      completion.expected_attempt_count === 0 ||
      !isNonNegativeInteger(completion.expected_lease_expires_at_ms) ||
      !isNonNegativeInteger(completion.completed_at_ms) ||
      !isNonNegativeInteger(completion.next_poll_at_ms) ||
      !isNonNegativeInteger(completion.failures)
    ) return { decision: "refused", reason: "invalid_completion" };
    const transaction = this.database.transaction(
      [CONFIG_STORE, EVIDENCE_POLL_JOB_STORE],
      "readwrite",
      { durability: "strict" },
    );
    const completed = transactionComplete(transaction);
    try {
      const [config, job] = await Promise.all([
        requestResult(transaction.objectStore(CONFIG_STORE).get(SINGLETON_KEY)) as
          Promise<StoredConfiguration | undefined>,
        requestResult(
          transaction.objectStore(EVIDENCE_POLL_JOB_STORE).get(completion.source_id),
        ) as Promise<PlayerLocalEvidencePollJob | undefined>,
      ]);
      if (!config) throw new PlayerLocalIndexedDbCorruptError("missing configuration");
      if (!job) {
        await completed;
        return { decision: "refused", reason: "job_not_found" };
      }
      if (
        job.state.kind !== "in_flight" ||
        job.attempt_count !== completion.expected_attempt_count ||
        job.state.lease_expires_at_ms !==
          completion.expected_lease_expires_at_ms
      ) {
        await completed;
        return { decision: "concurrent_write" };
      }
      const nextFailureCount = job.failures + 1;
      const failuresAdvance = completion.failures === 0 ||
        completion.failures === nextFailureCount;
      if (
        !Number.isSafeInteger(nextFailureCount) ||
        completion.completed_at_ms > completion.expected_lease_expires_at_ms ||
        completion.completed_at_ms >= job.deadline_at_ms ||
        completion.next_poll_at_ms < completion.completed_at_ms ||
        completion.next_poll_at_ms > job.deadline_at_ms ||
        !failuresAdvance
      ) {
        await completed;
        return { decision: "refused", reason: "invalid_completion" };
      }
      transaction.objectStore(EVIDENCE_POLL_JOB_STORE).put({
        ...job,
        next_poll_at_ms: completion.next_poll_at_ms,
        failures: completion.failures,
        state: { kind: "scheduled" },
      } satisfies PlayerLocalEvidencePollJob);
      transaction.objectStore(CONFIG_STORE).put({
        ...config,
        storage_revision: config.storage_revision + 1,
      });
      await completed;
      return { decision: "updated" };
    } catch (error) {
      abortTransaction(transaction);
      await completed.catch(() => undefined);
      throw error;
    }
  }

  async escalateEvidencePollJob(
    sourceId: string,
    nowMs: number,
    reasonDigest: string,
  ): Promise<PlayerLocalEvidencePollJobEscalationResult> {
    if (
      sourceId.length === 0 ||
      sourceId.length > 256 ||
      !isNonNegativeInteger(nowMs) ||
      reasonDigest.length === 0 ||
      reasonDigest.length > 4_096
    ) return { decision: "refused", reason: "invalid_escalation" };
    const transaction = this.database.transaction(
      [CONFIG_STORE, EVIDENCE_POLL_JOB_STORE],
      "readwrite",
      { durability: "strict" },
    );
    const completed = transactionComplete(transaction);
    try {
      const [config, job] = await Promise.all([
        requestResult(transaction.objectStore(CONFIG_STORE).get(SINGLETON_KEY)) as
          Promise<StoredConfiguration | undefined>,
        requestResult(
          transaction.objectStore(EVIDENCE_POLL_JOB_STORE).get(sourceId),
        ) as Promise<PlayerLocalEvidencePollJob | undefined>,
      ]);
      if (!config) throw new PlayerLocalIndexedDbCorruptError("missing configuration");
      if (!job) {
        await completed;
        return { decision: "not_found" };
      }
      if (job.state.kind === "escalated") {
        await completed;
        return job.state.reason_digest === reasonDigest
          ? { decision: "no_change" }
          : { decision: "refused", reason: "escalation_conflict" };
      }
      transaction.objectStore(EVIDENCE_POLL_JOB_STORE).put({
        ...job,
        state: {
          kind: "escalated",
          escalated_at_ms: nowMs,
          reason_digest: reasonDigest,
        },
      } satisfies PlayerLocalEvidencePollJob);
      transaction.objectStore(CONFIG_STORE).put({
        ...config,
        storage_revision: config.storage_revision + 1,
      });
      await completed;
      return { decision: "updated" };
    } catch (error) {
      abortTransaction(transaction);
      await completed.catch(() => undefined);
      throw error;
    }
  }

  async pruneEvidence(
    writeSet: PlayerLocalPruneWriteSet,
    faultPoint?: PlayerLocalPruneFaultPoint,
  ): Promise<PlayerLocalPruneResult> {
    const transaction = this.database.transaction(
      [...ALL_STORES],
      "readwrite",
      { durability: "strict" },
    );
    const completed = transactionComplete(transaction);
    try {
      const current = await this.readImage(transaction);
      if (current.storage_revision !== writeSet.expected_revision) {
        await completed;
        return { decision: "concurrent_write" };
      }
      if (!playerLocalPruneWriteSetValid(current, writeSet)) {
        await completed;
        return { decision: "refused", reason: "invalid_write_set" };
      }
      const through = writeSet.next_anchor.epoch;
      const eventStore = transaction.objectStore(EVENT_STORE);
      const equivocationStore = transaction.objectStore(EQUIVOCATION_STORE);
      for (const event of current.events) {
        if (event.epoch <= through) {
          eventStore.delete([event.author_id, event.counter]);
        }
      }
      for (const evidence of current.equivocations) {
        if (
          evidence.accepted.epoch <= through ||
          evidence.conflicting.epoch <= through
        ) {
          equivocationStore.delete([
            evidence.accepted.author_id,
            evidence.accepted.counter,
            evidence.conflicting.event_digest,
          ]);
        }
      }
      this.injectPrune(faultPoint, "after_events");

      const outboxStore = transaction.objectStore(OUTBOX_STORE);
      const ackStore = transaction.objectStore(ACK_STORE);
      for (const entry of current.outbox) {
        if (entry.epoch <= through) outboxStore.delete(entry.created_order);
      }
      for (const evidence of current.ack_history) {
        if (evidence.epoch <= through) {
          ackStore.delete([
            evidence.authority_id,
            evidence.epoch,
            evidence.checkpoint_digest,
          ]);
        }
      }
      this.injectPrune(faultPoint, "after_outbox");

      const checkpointStore = transaction.objectStore(CHECKPOINT_STORE);
      const closureStore = transaction.objectStore(CLOSURE_STORE);
      const holdStore = transaction.objectStore(EVIDENCE_HOLD_STORE);
      for (const hold of current.evidence_holds) {
        if (hold.epoch <= through && hold.state.kind === "resolved") {
          holdStore.delete(hold.hold_id);
        }
      }
      for (const checkpoint of current.checkpoints) {
        if (checkpoint.epoch <= through) checkpointStore.delete(checkpoint.epoch);
      }
      for (const closure of current.consumed_closures) {
        if (closure.epoch <= through) closureStore.delete(closure.epoch);
      }
      this.injectPrune(faultPoint, "after_checkpoints");

      transaction.objectStore(RETENTION_STORE).put({
        key: SINGLETON_KEY,
        anchor: writeSet.next_anchor,
      } satisfies StoredRetentionAnchor);
      this.injectPrune(faultPoint, "after_anchor");
      const config = await requestResult(
        transaction.objectStore(CONFIG_STORE).get(SINGLETON_KEY),
      ) as StoredConfiguration | undefined;
      if (!config || config.storage_revision !== writeSet.expected_revision) {
        throw new PlayerLocalIndexedDbCorruptError(
          "configuration changed during prune",
        );
      }
      transaction.objectStore(CONFIG_STORE).put({
        ...config,
        storage_revision: config.storage_revision + 1,
      });
      await completed;
      return { decision: "pruned", pruned_through_epoch: through };
    } catch (error) {
      abortTransaction(transaction);
      await completed.catch(() => undefined);
      throw error;
    }
  }

  async image(): Promise<PlayerLocalAuditImage> {
    const transaction = this.database.transaction([...ALL_STORES], "readonly");
    const completed = transactionComplete(transaction);
    try {
      const image = await this.readImage(transaction);
      await completed;
      return image;
    } catch (error) {
      abortTransaction(transaction);
      await completed.catch(() => undefined);
      if (error instanceof PlayerLocalIndexedDbCorruptError) throw error;
      throw new PlayerLocalIndexedDbCorruptError(String(error));
    }
  }

  private async configure(): Promise<void> {
    const transaction = this.database.transaction(
      [CONFIG_STORE, HEAD_STORE, RETENTION_STORE],
      "readwrite",
      { durability: "strict" },
    );
    const completed = transactionComplete(transaction);
    try {
      const existing = await requestResult(
        transaction.objectStore(CONFIG_STORE).get(SINGLETON_KEY),
      ) as StoredConfiguration | undefined;
      if (existing) {
        if (!sameConfiguration(
          existing.configuration,
          this.expectedConfiguration,
        )) {
          throw new PlayerLocalIndexedDbCorruptError(
            "player-local database boundary/configuration conflict",
          );
        }
        const retention = await requestResult(
          transaction.objectStore(RETENTION_STORE).get(SINGLETON_KEY),
        ) as StoredRetentionAnchor | undefined;
        if (!retention) {
          transaction.objectStore(RETENTION_STORE).add({
            key: SINGLETON_KEY,
            anchor: {
              boundary: this.expectedConfiguration.boundary,
              epoch: -1,
              checkpoint_digest: this.expectedConfiguration.genesis_digest,
            },
          } satisfies StoredRetentionAnchor);
        }
        await completed;
        return;
      }
      transaction.objectStore(CONFIG_STORE).add({
        key: SINGLETON_KEY,
        configuration: this.expectedConfiguration,
        next_created_order: 0,
        storage_revision: 0,
      } satisfies StoredConfiguration);
      transaction.objectStore(HEAD_STORE).add({
        key: SINGLETON_KEY,
        head: {
          boundary: this.expectedConfiguration.boundary,
          epoch: -1,
          checkpoint_digest: this.expectedConfiguration.genesis_digest,
        },
      } satisfies StoredHead);
      transaction.objectStore(RETENTION_STORE).add({
        key: SINGLETON_KEY,
        anchor: {
          boundary: this.expectedConfiguration.boundary,
          epoch: -1,
          checkpoint_digest: this.expectedConfiguration.genesis_digest,
        },
      } satisfies StoredRetentionAnchor);
      await completed;
    } catch (error) {
      abortTransaction(transaction);
      await completed.catch(() => undefined);
      throw error;
    }
  }

  private async readImage(
    transaction: IDBTransaction,
  ): Promise<PlayerLocalAuditImage> {
    const configPromise = requestResult(
      transaction.objectStore(CONFIG_STORE).get(SINGLETON_KEY),
    ) as Promise<StoredConfiguration | undefined>;
    const headPromise = requestResult(
      transaction.objectStore(HEAD_STORE).get(SINGLETON_KEY),
    ) as Promise<StoredHead | undefined>;
    const retentionPromise = requestResult(
      transaction.objectStore(RETENTION_STORE).get(SINGLETON_KEY),
    ) as Promise<StoredRetentionAnchor | undefined>;
    const eventsPromise = requestResult(
      transaction.objectStore(EVENT_STORE).getAll(),
    ) as Promise<PlayerLocalAuditEvent[]>;
    const conflictsPromise = requestResult(
      transaction.objectStore(EQUIVOCATION_STORE).getAll(),
    ) as Promise<StoredEquivocation[]>;
    const checkpointsPromise = requestResult(
      transaction.objectStore(CHECKPOINT_STORE).getAll(),
    ) as Promise<CheckpointSealDraft[]>;
    const closuresPromise = requestResult(
      transaction.objectStore(CLOSURE_STORE).getAll(),
    ) as Promise<EpochClosureEvidence[]>;
    const holdsPromise = requestResult(
      transaction.objectStore(EVIDENCE_HOLD_STORE).getAll(),
    ) as Promise<PlayerLocalEvidenceHold[]>;
    const inboxCursorsPromise = requestResult(
      transaction.objectStore(EVIDENCE_INBOX_CURSOR_STORE).getAll(),
    ) as Promise<PlayerLocalEvidenceInboxCursor[]>;
    const pollJobsPromise = requestResult(
      transaction.objectStore(EVIDENCE_POLL_JOB_STORE).getAll(),
    ) as Promise<PlayerLocalEvidencePollJob[]>;
    const outboxPromise = requestResult(
      transaction.objectStore(OUTBOX_STORE).getAll(),
    ) as Promise<PlayerLocalCheckpointOutboxRecord[]>;
    const ackPromise = requestResult(
      transaction.objectStore(ACK_STORE).getAll(),
    ) as Promise<CheckpointAckEvidence[]>;
    const [
      config,
      storedHead,
      storedRetention,
      events,
      conflicts,
      checkpoints,
      consumed_closures,
      evidence_holds,
      evidence_inbox_cursors,
      evidence_poll_jobs,
      outbox,
      ack_history,
    ] = await Promise.all([
      configPromise,
      headPromise,
      retentionPromise,
      eventsPromise,
      conflictsPromise,
      checkpointsPromise,
      closuresPromise,
      holdsPromise,
      inboxCursorsPromise,
      pollJobsPromise,
      outboxPromise,
      ackPromise,
    ]);
    if (!config || !storedHead || !storedRetention) {
      throw new PlayerLocalIndexedDbCorruptError("missing config/head/anchor");
    }
    events.sort((left, right) =>
      left.author_id.localeCompare(right.author_id) || left.counter - right.counter
    );
    const accepted = new Map(
      events.map((event) => [`${event.author_id}\u0000${event.counter}`, event]),
    );
    const equivocations = conflicts
      .sort((left, right) =>
        left.author_id.localeCompare(right.author_id) ||
        left.counter - right.counter ||
        left.event_digest.localeCompare(right.event_digest)
      )
      .map((row) => {
        const acceptedEvent = accepted.get(`${row.author_id}\u0000${row.counter}`);
        if (!acceptedEvent) {
          throw new PlayerLocalIndexedDbCorruptError("orphan equivocation row");
        }
        return { accepted: acceptedEvent, conflicting: row.conflicting };
      });
    checkpoints.sort((left, right) => left.epoch - right.epoch);
    consumed_closures.sort((left, right) => left.epoch - right.epoch);
    evidence_holds.sort((left, right) =>
      left.epoch - right.epoch || left.hold_id.localeCompare(right.hold_id)
    );
    evidence_inbox_cursors.sort((left, right) =>
      left.source_id.localeCompare(right.source_id)
    );
    evidence_poll_jobs.sort((left, right) =>
      left.source_id.localeCompare(right.source_id)
    );
    outbox.sort((left, right) => left.created_order - right.created_order);
    ack_history.sort((left, right) =>
      left.authority_id.localeCompare(right.authority_id) ||
      left.epoch - right.epoch ||
      left.checkpoint_digest.localeCompare(right.checkpoint_digest)
    );
    return {
      boundary: config.configuration.boundary,
      genesis_digest: config.configuration.genesis_digest,
      outbox_capacity: config.configuration.outbox_capacity,
      events,
      equivocations,
      checkpoints,
      head: storedHead.head,
      retention_anchor: storedRetention.anchor,
      evidence_holds,
      evidence_inbox_cursors,
      evidence_poll_jobs,
      consumed_closures,
      outbox,
      ack_history,
      next_created_order: config.next_created_order,
      storage_revision: config.storage_revision,
    };
  }

  private async assertValidImage(): Promise<void> {
    const image = await this.image();
    const reason = playerLocalAuditImageError(image);
    if (reason) throw new PlayerLocalIndexedDbCorruptError(reason);
  }

  private inject(
    requested: PlayerLocalSealFaultPoint | undefined,
    current: PlayerLocalSealFaultPoint,
  ): void {
    this.injectWriteFault?.(current);
    if (requested === current) {
      throw new InjectedIndexedDbPlayerLocalSealFault(current);
    }
  }

  private injectPrune(
    requested: PlayerLocalPruneFaultPoint | undefined,
    current: PlayerLocalPruneFaultPoint,
  ): void {
    this.injectWriteFault?.(current);
    if (requested === current) {
      throw new InjectedIndexedDbPlayerLocalPruneFault(current);
    }
  }

  private injectEvidenceInbox(
    requested: PlayerLocalEvidenceInboxFaultPoint | undefined,
    current: PlayerLocalEvidenceInboxFaultPoint,
  ): void {
    this.injectWriteFault?.(current);
    if (requested === current) {
      throw new InjectedIndexedDbPlayerLocalEvidenceInboxFault(current);
    }
  }
}
