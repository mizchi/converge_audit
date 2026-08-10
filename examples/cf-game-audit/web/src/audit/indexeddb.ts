import type { RunSnapshot } from "../../../game/audit/snapshot";
import {
  STANDARD_WEBCRYPTO_BACKEND_ID,
  type WebCryptoSigningKeyMaterial,
} from "../../../../player-local-runtime/crypto-backend.ts";

const DATABASE_NAME = "audit-survivors-local-v1";
const DATABASE_VERSION = 3;
const RUN_STORE = "runs";
const DEVICE_KEY_STORE = "device-keys";
const DEVICE_KEY_HANDLE_STORE = "device-key-handles";

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

  constructor(databaseName = DATABASE_NAME) {
    this.database = this.open(databaseName);
  }

  private open(databaseName: string): Promise<IDBDatabase> {
    const request = indexedDB.open(databaseName, DATABASE_VERSION);
    request.addEventListener("upgradeneeded", () => {
      if (!request.result.objectStoreNames.contains(RUN_STORE)) {
        request.result.createObjectStore(RUN_STORE);
      }
      if (!request.result.objectStoreNames.contains(DEVICE_KEY_STORE)) {
        request.result.createObjectStore(DEVICE_KEY_STORE);
      }
      if (!request.result.objectStoreNames.contains(DEVICE_KEY_HANDLE_STORE)) {
        request.result.createObjectStore(DEVICE_KEY_HANDLE_STORE);
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

  async removeDeviceSeed(runKey: string): Promise<void> {
    const database = await this.database;
    const transaction = database.transaction(DEVICE_KEY_STORE, "readwrite", {
      durability: "strict",
    });
    const completed = transactionComplete(transaction);
    transaction.objectStore(DEVICE_KEY_STORE).delete(runKey);
    await completed;
  }

  async loadDeviceKeyHandle(
    runKey: string,
  ): Promise<WebCryptoSigningKeyMaterial | undefined> {
    const database = await this.database;
    const transaction = database.transaction(DEVICE_KEY_HANDLE_STORE, "readonly");
    const completed = transactionComplete(transaction);
    const value: unknown = await requestResult(
      transaction.objectStore(DEVICE_KEY_HANDLE_STORE).get(runKey),
    );
    await completed;
    if (value === undefined) return undefined;
    if (
      typeof value !== "object" || value === null ||
      (value as { version?: unknown }).version !== 1 ||
      (value as { backendId?: unknown }).backendId !==
        STANDARD_WEBCRYPTO_BACKEND_ID ||
      (value as { scheme?: unknown }).scheme !== "ed25519-v1" ||
      typeof (value as { publicKey?: unknown }).publicKey !== "string" ||
      !/^[0-9a-f]{64}$/.test(
        (value as { publicKey: string }).publicKey,
      ) ||
      typeof (value as { privateKey?: unknown }).privateKey !== "object" ||
      (value as { privateKey?: unknown }).privateKey === null
    ) {
      throw new Error("stored device-key handle is malformed");
    }
    return value as WebCryptoSigningKeyMaterial;
  }

  async saveDeviceKeyHandle(
    runKey: string,
    material: WebCryptoSigningKeyMaterial,
  ): Promise<void> {
    if (
      material.version !== 1 ||
      material.backendId !== STANDARD_WEBCRYPTO_BACKEND_ID ||
      material.scheme !== "ed25519-v1" ||
      !/^[0-9a-f]{64}$/.test(material.publicKey) ||
      material.privateKey.type !== "private" ||
      material.privateKey.extractable ||
      material.privateKey.algorithm.name !== "Ed25519" ||
      material.privateKey.usages.length !== 1 ||
      material.privateKey.usages[0] !== "sign"
    ) {
      throw new Error("device-key handle violates custody contract");
    }
    const database = await this.database;
    const transaction = database.transaction(
      DEVICE_KEY_HANDLE_STORE,
      "readwrite",
      { durability: "strict" },
    );
    const completed = transactionComplete(transaction);
    transaction.objectStore(DEVICE_KEY_HANDLE_STORE).put(material, runKey);
    await completed;
  }
}
