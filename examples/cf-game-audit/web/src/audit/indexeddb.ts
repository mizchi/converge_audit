import type { RunSnapshot } from "../../../game/audit/snapshot";

const DATABASE_NAME = "audit-survivors-local-v1";
const DATABASE_VERSION = 2;
const RUN_STORE = "runs";
const DEVICE_KEY_STORE = "device-keys";

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

export class IndexedDbRunSnapshotStore {
  private readonly database: Promise<IDBDatabase>;

  constructor() {
    this.database = this.open();
  }

  private open(): Promise<IDBDatabase> {
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
    request.addEventListener("upgradeneeded", () => {
      if (!request.result.objectStoreNames.contains(RUN_STORE)) {
        request.result.createObjectStore(RUN_STORE);
      }
      if (!request.result.objectStoreNames.contains(DEVICE_KEY_STORE)) {
        request.result.createObjectStore(DEVICE_KEY_STORE);
      }
    });
    return requestResult(request);
  }

  async load(runKey: string): Promise<unknown | undefined> {
    const database = await this.database;
    const transaction = database.transaction(RUN_STORE, "readonly");
    const completed = transactionComplete(transaction);
    const value = await requestResult(
      transaction.objectStore(RUN_STORE).get(runKey),
    );
    await completed;
    return value;
  }

  async save(runKey: string, snapshot: RunSnapshot): Promise<void> {
    const database = await this.database;
    const transaction = database.transaction(RUN_STORE, "readwrite", {
      durability: "strict",
    });
    const completed = transactionComplete(transaction);
    transaction.objectStore(RUN_STORE).put(snapshot, runKey);
    await completed;
  }

  async remove(runKey: string): Promise<void> {
    const database = await this.database;
    const transaction = database.transaction(RUN_STORE, "readwrite", {
      durability: "strict",
    });
    const completed = transactionComplete(transaction);
    transaction.objectStore(RUN_STORE).delete(runKey);
    await completed;
  }

  async loadDeviceSeed(runKey: string): Promise<string | undefined> {
    const database = await this.database;
    const transaction = database.transaction(DEVICE_KEY_STORE, "readonly");
    const completed = transactionComplete(transaction);
    const value: unknown = await requestResult(
      transaction.objectStore(DEVICE_KEY_STORE).get(runKey),
    );
    await completed;
    if (value === undefined) return undefined;
    if (typeof value !== "string" || !/^[0-9a-f]{64}$/.test(value)) {
      throw new Error("stored device seed is malformed");
    }
    return value;
  }

  async saveDeviceSeed(runKey: string, seedHex: string): Promise<void> {
    if (!/^[0-9a-f]{64}$/.test(seedHex)) {
      throw new Error("device seed must be 32-byte lower hex");
    }
    const database = await this.database;
    const transaction = database.transaction(DEVICE_KEY_STORE, "readwrite", {
      durability: "strict",
    });
    const completed = transactionComplete(transaction);
    transaction.objectStore(DEVICE_KEY_STORE).put(seedHex, runKey);
    await completed;
  }
}
