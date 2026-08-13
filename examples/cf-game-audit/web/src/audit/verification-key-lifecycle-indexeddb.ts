import type { VerificationKeyRecord } from
  "../../../../player-local-runtime/key-lifecycle.ts";
import {
  planVerificationKeyLifecycleMutation,
  type ProvisionVerificationKeyCommand,
  type RevokeVerificationKeyCommand,
  type RotateVerificationKeyCommand,
  type VerificationKeyLifecycleCommand,
  type VerificationKeyLifecycleEvent,
  type VerificationKeyLifecycleImage,
  type VerificationKeyLifecycleMutationResult,
} from "../../../../player-local-runtime/key-lifecycle-ledger.ts";

const DATABASE_VERSION = 1;
const KEY_STORE = "verification_key_versions";
const EVENT_STORE = "verification_key_lifecycle_events";

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.addEventListener("success", () => resolve(request.result), { once: true });
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
      () => reject(transaction.error ?? new Error("IndexedDB transaction aborted")),
      { once: true },
    );
    transaction.addEventListener(
      "error",
      () => reject(transaction.error ?? new Error("IndexedDB transaction failed")),
      { once: true },
    );
  });
}

export class IndexedDbVerificationKeyLifecycleStore {
  static open(
    factory: IDBFactory,
    databaseName = "converge-audit-key-lifecycle-v1",
  ): Promise<IndexedDbVerificationKeyLifecycleStore> {
    return new Promise((resolve, reject) => {
      const request = factory.open(databaseName, DATABASE_VERSION);
      request.addEventListener("upgradeneeded", () => {
        const database = request.result;
        if (!database.objectStoreNames.contains(KEY_STORE)) {
          database.createObjectStore(KEY_STORE, {
            keyPath: ["keyId", "keyVersion"],
          });
        }
        if (!database.objectStoreNames.contains(EVENT_STORE)) {
          database.createObjectStore(EVENT_STORE, {
            keyPath: ["keyId", "lifecycleRevision"],
          });
        }
      });
      request.addEventListener("success", () => {
        const database = request.result;
        database.addEventListener("versionchange", () => database.close());
        resolve(new IndexedDbVerificationKeyLifecycleStore(database));
      }, { once: true });
      request.addEventListener(
        "error",
        () => reject(request.error ?? new Error("IndexedDB open failed")),
        { once: true },
      );
      request.addEventListener(
        "blocked",
        () => reject(new Error("IndexedDB lifecycle upgrade blocked")),
        { once: true },
      );
    });
  }

  private readonly database: IDBDatabase;

  private constructor(database: IDBDatabase) {
    this.database = database;
  }

  close(): void {
    this.database.close();
  }

  provision(
    command: ProvisionVerificationKeyCommand,
  ): Promise<VerificationKeyLifecycleMutationResult> {
    return this.commit({ ...command, kind: "provision" });
  }

  rotate(
    command: RotateVerificationKeyCommand,
  ): Promise<VerificationKeyLifecycleMutationResult> {
    return this.commit({ ...command, kind: "rotate" });
  }

  revoke(
    command: RevokeVerificationKeyCommand,
  ): Promise<VerificationKeyLifecycleMutationResult> {
    return this.commit({ ...command, kind: "revoke" });
  }

  async image(keyId: string): Promise<VerificationKeyLifecycleImage> {
    const transaction = this.database.transaction(
      [KEY_STORE, EVENT_STORE],
      "readonly",
    );
    const completed = transactionComplete(transaction);
    const [allRecords, allEvents] = await Promise.all([
      requestResult(transaction.objectStore(KEY_STORE).getAll()) as Promise<
        VerificationKeyRecord[]
      >,
      requestResult(transaction.objectStore(EVENT_STORE).getAll()) as Promise<
        VerificationKeyLifecycleEvent[]
      >,
    ]);
    await completed;
    return filteredImage(keyId, allRecords, allEvents);
  }

  private async commit(
    command: VerificationKeyLifecycleCommand,
  ): Promise<VerificationKeyLifecycleMutationResult> {
    const keyId = command.kind === "provision" ? command.record.keyId : command.keyId;
    const unsigned = planVerificationKeyLifecycleMutation(
      await this.image(keyId),
      command,
    );
    if (!unsigned.ok) return unsigned.result;
    const eventDigest = await command.digest.hashString(
      unsigned.event.canonicalEvent,
    );
    if (!/^[0-9a-f]{64}$/.test(eventDigest)) {
      return { decision: "refused", reason: "invalid_transition" };
    }

    const transaction = this.database.transaction(
      [KEY_STORE, EVENT_STORE],
      "readwrite",
      { durability: "strict" },
    );
    const completed = transactionComplete(transaction);
    try {
      const keyStore = transaction.objectStore(KEY_STORE);
      const eventStore = transaction.objectStore(EVENT_STORE);
      const [allRecords, allEvents] = await Promise.all([
        requestResult(keyStore.getAll()) as Promise<VerificationKeyRecord[]>,
        requestResult(eventStore.getAll()) as Promise<
          VerificationKeyLifecycleEvent[]
        >,
      ]);
      const plan = planVerificationKeyLifecycleMutation(
        filteredImage(keyId, allRecords, allEvents),
        command,
      );
      if (!plan.ok) {
        await completed;
        return plan.result;
      }
      for (const record of plan.records) keyStore.put(record);
      eventStore.add({ ...plan.event, eventDigest });
      await completed;
      return { decision: "committed", revision: plan.event.lifecycleRevision };
    } catch (error) {
      try {
        transaction.abort();
      } catch {
        // The transaction may already have aborted after a request failure.
      }
      throw error;
    }
  }
}

function filteredImage(
  keyId: string,
  records: VerificationKeyRecord[],
  events: VerificationKeyLifecycleEvent[],
): VerificationKeyLifecycleImage {
  return {
    records: records.filter((record) => record.keyId === keyId).sort(
      (left, right) => left.keyVersion - right.keyVersion,
    ),
    events: events.filter((event) => event.keyId === keyId).sort(
      (left, right) => left.lifecycleRevision - right.lifecycleRevision,
    ),
  };
}
