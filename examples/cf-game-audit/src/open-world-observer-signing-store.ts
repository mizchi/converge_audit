import {
  classifyOpenWorldObserverSigningSync,
  openWorldObserverSigningKeySync,
  openWorldObserverSigningStoreSnapshotSync,
  type LoadedCheckpointRuntime,
} from "./moonbit";

const OBSERVER_SIGNING_STORE_SCHEMA_VERSION = 1;
const MAX_OBSERVER_SIGNING_RESERVATIONS = 16_384;
const MAX_OBSERVER_SIGNING_CONFLICTS = 65_536;

export type ObserverSigningStoreFaultPoint =
  | "after_reservation"
  | "after_sequence";

export class InjectedObserverSigningStoreFault extends Error {
  constructor(readonly point: ObserverSigningStoreFaultPoint) {
    super(`injected observer signing store fault: ${point}`);
  }
}

export interface OpenWorldObserverSigningAnchor {
  observer_id: string;
  signer_key: string;
  root: string;
  size: number;
}

export interface OpenWorldObserverSigningTarget {
  auditCheckpointDigest: string;
  registrationIndex: number;
  encounterDigest: string;
}

export interface OpenWorldObserverSigningReservation {
  signing_key: string;
  audit_checkpoint_digest: string;
  registration_index: number;
  encounter_digest: string;
  sequence: number;
  reserved_at: number;
}

export type OpenWorldObserverSigningStoreOpenResult =
  | { decision: "configured" | "restored"; anchor: OpenWorldObserverSigningAnchor }
  | {
    decision:
      | "invalid_identity"
      | "identity_mismatch"
      | "anchor_mismatch"
      | "incompatible_schema"
      | "corrupt_store";
  };

export type OpenWorldObserverSigningReservationResult =
  | { decision: "reserved" | "reused"; reservation: OpenWorldObserverSigningReservation }
  | {
    decision: "conflict";
    previous_encounter_digest: string;
    signing_key: string;
  }
  | { decision: "invalid" | "capacity" | "unavailable"; reason: string };

export type OpenWorldObserverSigningResult<T> =
  | { decision: "signed" | "reused"; reservation: OpenWorldObserverSigningReservation; value: T }
  | Exclude<OpenWorldObserverSigningReservationResult, { decision: "reserved" | "reused" }>;

interface MetadataRow extends Record<string, SqlStorageValue> {
  schema_version: number;
  observer_id: string;
  signer_key: string;
  next_sequence: number;
}

interface ReservationRow extends Record<string, SqlStorageValue>, OpenWorldObserverSigningReservation {}

interface SnapshotRow extends Record<string, SqlStorageValue> {
  root: string;
  size: number;
  max_sequence: number;
  updated_at: number;
}

interface ConflictRow extends Record<string, SqlStorageValue> {
  id: number;
  signing_key: string;
}

function digestValid(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
}

function sameAnchor(
  left: OpenWorldObserverSigningAnchor,
  right: OpenWorldObserverSigningAnchor,
): boolean {
  return left.observer_id === right.observer_id &&
    left.signer_key === right.signer_key && left.root === right.root &&
    left.size === right.size;
}

export class OpenWorldObserverSigningStore {
  private runtime: LoadedCheckpointRuntime | undefined;

  constructor(private readonly storage: DurableObjectStorage) {
    this.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS open_world_observer_signing_metadata (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        schema_version INTEGER NOT NULL CHECK (schema_version > 0),
        observer_id TEXT NOT NULL CHECK (
          length(observer_id) > 0 AND length(observer_id) <= 4096
        ),
        signer_key TEXT NOT NULL CHECK (length(signer_key) = 64),
        next_sequence INTEGER NOT NULL CHECK (
          next_sequence >= 0 AND next_sequence <= 16384
        ),
        created_at INTEGER NOT NULL CHECK (created_at >= 0),
        updated_at INTEGER NOT NULL CHECK (updated_at >= 0)
      );
      CREATE TABLE IF NOT EXISTS open_world_observer_signing_reservations (
        signing_key TEXT PRIMARY KEY CHECK (
          length(signing_key) > 0 AND length(signing_key) <= 4096
        ),
        audit_checkpoint_digest TEXT NOT NULL CHECK (
          length(audit_checkpoint_digest) = 64
        ),
        registration_index INTEGER NOT NULL CHECK (registration_index >= 0),
        encounter_digest TEXT NOT NULL CHECK (length(encounter_digest) = 64),
        sequence INTEGER NOT NULL UNIQUE CHECK (
          sequence >= 0 AND sequence < 16384
        ),
        reserved_at INTEGER NOT NULL CHECK (reserved_at >= 0),
        UNIQUE(audit_checkpoint_digest, registration_index)
      );
      CREATE TABLE IF NOT EXISTS open_world_observer_signing_snapshots (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        root TEXT NOT NULL CHECK (length(root) = 64),
        size INTEGER NOT NULL CHECK (size >= 0 AND size <= 16384),
        max_sequence INTEGER NOT NULL CHECK (
          max_sequence >= -1 AND max_sequence < 16384
        ),
        updated_at INTEGER NOT NULL CHECK (updated_at >= 0)
      );
      CREATE TABLE IF NOT EXISTS open_world_observer_signing_conflicts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        signing_key TEXT NOT NULL,
        reserved_encounter_digest TEXT NOT NULL CHECK (
          length(reserved_encounter_digest) = 64
        ),
        conflicting_encounter_digest TEXT NOT NULL CHECK (
          length(conflicting_encounter_digest) = 64
        ),
        observed_at INTEGER NOT NULL CHECK (observed_at >= 0),
        UNIQUE(signing_key, conflicting_encounter_digest)
      );
      CREATE INDEX IF NOT EXISTS open_world_observer_signing_conflicts_time
        ON open_world_observer_signing_conflicts(observed_at, id);
    `);
  }

  open(
    runtime: LoadedCheckpointRuntime,
    input: {
      observerId: string;
      signerKey: string;
      trustedAnchor?: OpenWorldObserverSigningAnchor;
    },
    now = Date.now(),
  ): OpenWorldObserverSigningStoreOpenResult {
    this.runtime = runtime;
    if (
      input.observerId.length === 0 || input.observerId.length > 4_096 ||
      !digestValid(input.signerKey)
    ) return { decision: "invalid_identity" };
    const metadata = this.metadata();
    if (metadata && metadata.schema_version !== OBSERVER_SIGNING_STORE_SCHEMA_VERSION) {
      return { decision: "incompatible_schema" };
    }
    if (
      metadata &&
      (metadata.observer_id !== input.observerId || metadata.signer_key !== input.signerKey)
    ) return { decision: "identity_mismatch" };
    let anchor: OpenWorldObserverSigningAnchor;
    try {
      if (!metadata) {
        const empty = this.computeSnapshot(runtime, 0);
        anchor = {
          observer_id: input.observerId,
          signer_key: input.signerKey,
          root: empty.root,
          size: empty.size,
        };
        if (input.trustedAnchor && !sameAnchor(anchor, input.trustedAnchor)) {
          return { decision: "anchor_mismatch" };
        }
        this.storage.transactionSync(() => {
          this.storage.sql.exec(
            `INSERT INTO open_world_observer_signing_metadata
             (singleton, schema_version, observer_id, signer_key,
              next_sequence, created_at, updated_at)
             VALUES (1, ?, ?, ?, 0, ?, ?)`,
            OBSERVER_SIGNING_STORE_SCHEMA_VERSION,
            input.observerId,
            input.signerKey,
            now,
            now,
          );
          this.storage.sql.exec(
            `INSERT INTO open_world_observer_signing_snapshots
             (singleton, root, size, max_sequence, updated_at)
             VALUES (1, ?, 0, -1, ?)`,
            empty.root,
            now,
          );
        });
        return { decision: "configured", anchor };
      }
      anchor = this.snapshot(runtime, now);
    } catch {
      return { decision: "corrupt_store" };
    }
    if (input.trustedAnchor && !sameAnchor(anchor, input.trustedAnchor)) {
      return { decision: "anchor_mismatch" };
    }
    return { decision: "restored", anchor };
  }

  reserve(
    runtime: LoadedCheckpointRuntime,
    target: OpenWorldObserverSigningTarget,
    now = Date.now(),
    fault?: InjectedObserverSigningStoreFault,
  ): OpenWorldObserverSigningReservationResult {
    this.runtime = runtime;
    const metadata = this.metadata();
    if (!metadata || metadata.schema_version !== OBSERVER_SIGNING_STORE_SCHEMA_VERSION) {
      return { decision: "unavailable", reason: "store_not_open" };
    }
    const targetValid = digestValid(target.auditCheckpointDigest) &&
      Number.isSafeInteger(target.registrationIndex) &&
      target.registrationIndex >= 0 && target.registrationIndex < 2_147_483_647 &&
      digestValid(target.encounterDigest);
    const signingKey = targetValid
      ? openWorldObserverSigningKeySync(
        runtime,
        target.auditCheckpointDigest,
        target.registrationIndex,
      )
      : "";
    const existing = signingKey ? this.reservationByKey(signingKey) : undefined;
    const decision = classifyOpenWorldObserverSigningSync(runtime, {
      targetValid: targetValid && signingKey.length > 0,
      previousObservationPresent: existing !== undefined,
      previousDigestMatches: existing?.encounter_digest === target.encounterDigest,
    });
    if (decision === "reject_invalid") {
      return { decision: "invalid", reason: "invalid_observer_signing_target" };
    }
    if (decision === "reuse_existing") {
      return { decision: "reused", reservation: existing! };
    }
    if (decision === "reject_conflict") {
      this.storage.transactionSync(() => {
        if (
          this.count("open_world_observer_signing_conflicts") >=
            MAX_OBSERVER_SIGNING_CONFLICTS
        ) return;
        this.storage.sql.exec(
          `INSERT OR IGNORE INTO open_world_observer_signing_conflicts
           (signing_key, reserved_encounter_digest,
            conflicting_encounter_digest, observed_at)
           VALUES (?, ?, ?, ?)`,
          signingKey,
          existing!.encounter_digest,
          target.encounterDigest,
          now,
        );
      });
      return {
        decision: "conflict",
        previous_encounter_digest: existing!.encounter_digest,
        signing_key: signingKey,
      };
    }
    if (metadata.next_sequence >= MAX_OBSERVER_SIGNING_RESERVATIONS) {
      return { decision: "capacity", reason: "reservation_capacity_exceeded" };
    }
    const reservation: OpenWorldObserverSigningReservation = {
      signing_key: signingKey,
      audit_checkpoint_digest: target.auditCheckpointDigest,
      registration_index: target.registrationIndex,
      encounter_digest: target.encounterDigest,
      sequence: metadata.next_sequence,
      reserved_at: now,
    };
    try {
      this.storage.transactionSync(() => {
        const latest = this.metadata();
        if (!latest || latest.next_sequence !== metadata.next_sequence) {
          throw new Error("observer signing sequence raced");
        }
        this.storage.sql.exec(
          `INSERT INTO open_world_observer_signing_reservations
           (signing_key, audit_checkpoint_digest, registration_index,
            encounter_digest, sequence, reserved_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
          reservation.signing_key,
          reservation.audit_checkpoint_digest,
          reservation.registration_index,
          reservation.encounter_digest,
          reservation.sequence,
          reservation.reserved_at,
        );
        if (fault?.point === "after_reservation") throw fault;
        this.storage.sql.exec(
          `UPDATE open_world_observer_signing_metadata
           SET next_sequence = next_sequence + 1, updated_at = ?
           WHERE singleton = 1 AND next_sequence = ?`,
          now,
          metadata.next_sequence,
        );
        const changed = this.storage.sql.exec<{ changed: number }>(
          "SELECT changes() AS changed",
        ).toArray()[0]?.changed ?? 0;
        if (changed !== 1) throw new Error("observer signing sequence CAS failed");
        if (fault?.point === "after_sequence") throw fault;
      });
      return { decision: "reserved", reservation };
    } catch (error) {
      if (error instanceof InjectedObserverSigningStoreFault) {
        return { decision: "unavailable", reason: error.message };
      }
      throw error;
    }
  }

  reservation(
    auditCheckpointDigest: string,
    registrationIndex: number,
  ): OpenWorldObserverSigningReservation | undefined {
    if (!this.runtime) throw new Error("observer signing store is not open");
    const signingKey = openWorldObserverSigningKeySync(
      this.runtime,
      auditCheckpointDigest,
      registrationIndex,
    );
    return signingKey ? this.reservationByKey(signingKey) : undefined;
  }

  snapshot(
    runtime: LoadedCheckpointRuntime,
    now = Date.now(),
  ): OpenWorldObserverSigningAnchor {
    this.runtime = runtime;
    const metadata = this.metadata();
    if (!metadata) throw new Error("observer signing store is not configured");
    const computed = this.computeSnapshot(runtime, metadata.next_sequence);
    this.storage.transactionSync(() => {
      const latest = this.metadata();
      if (!latest || latest.next_sequence !== metadata.next_sequence) {
        throw new Error("observer signing snapshot raced");
      }
      this.storage.sql.exec(
        `UPDATE open_world_observer_signing_snapshots
         SET root = ?, size = ?, max_sequence = ?, updated_at = ?
         WHERE singleton = 1`,
        computed.root,
        computed.size,
        metadata.next_sequence - 1,
        now,
      );
      const changed = this.storage.sql.exec<{ changed: number }>(
        "SELECT changes() AS changed",
      ).toArray()[0]?.changed ?? 0;
      if (changed !== 1) throw new Error("observer signing snapshot missing");
    });
    return {
      observer_id: metadata.observer_id,
      signer_key: metadata.signer_key,
      root: computed.root,
      size: computed.size,
    };
  }

  pruneConflictAttempts(input: {
    before: number;
    protectedSigningKeys: string[];
  }): { pruned: number; retained: number } {
    // Authoritative reservations have no deletion path: removing one would
    // permit a replayed slot to reserve another digest. Only diagnostic
    // conflict attempts can expire, and the caller must pin every key still
    // inside its appeal/evidence-retention window.
    if (!Number.isSafeInteger(input.before) || input.before < 0) {
      throw new Error("invalid observer signing conflict prune boundary");
    }
    const protectedKeys = new Set(input.protectedSigningKeys);
    const candidates = this.storage.sql.exec<ConflictRow>(
      `SELECT id, signing_key
       FROM open_world_observer_signing_conflicts
       WHERE observed_at < ?
       ORDER BY id ASC`,
      input.before,
    ).toArray();
    let pruned = 0;
    this.storage.transactionSync(() => {
      for (const row of candidates) {
        if (protectedKeys.has(row.signing_key)) continue;
        this.storage.sql.exec(
          "DELETE FROM open_world_observer_signing_conflicts WHERE id = ?",
          row.id,
        );
        pruned += this.storage.sql.exec<{ changed: number }>(
          "SELECT changes() AS changed",
        ).toArray()[0]?.changed ?? 0;
      }
    });
    return { pruned, retained: this.stats().conflicts };
  }

  stats(): {
    reservations: number;
    conflicts: number;
    next_sequence: number;
    snapshot_size: number;
    snapshot_dirty: boolean;
  } {
    const metadata = this.metadata();
    const snapshot = this.storage.sql.exec<SnapshotRow>(
      `SELECT root, size, max_sequence, updated_at
       FROM open_world_observer_signing_snapshots WHERE singleton = 1`,
    ).toArray()[0];
    const reservations = this.count("open_world_observer_signing_reservations");
    return {
      reservations,
      conflicts: this.count("open_world_observer_signing_conflicts"),
      next_sequence: metadata?.next_sequence ?? 0,
      snapshot_size: snapshot?.size ?? 0,
      snapshot_dirty: (snapshot?.max_sequence ?? -1) !== reservations - 1,
    };
  }

  private metadata(): MetadataRow | undefined {
    return this.storage.sql.exec<MetadataRow>(
      `SELECT schema_version, observer_id, signer_key, next_sequence
       FROM open_world_observer_signing_metadata WHERE singleton = 1`,
    ).toArray()[0];
  }

  private reservationByKey(
    signingKey: string,
  ): OpenWorldObserverSigningReservation | undefined {
    return this.storage.sql.exec<ReservationRow>(
      `SELECT signing_key, audit_checkpoint_digest, registration_index,
              encounter_digest, sequence, reserved_at
       FROM open_world_observer_signing_reservations
       WHERE signing_key = ?`,
      signingKey,
    ).toArray()[0];
  }

  private computeSnapshot(
    runtime: LoadedCheckpointRuntime,
    expectedCount: number,
  ): { root: string; size: number } {
    const rows = this.storage.sql.exec<ReservationRow>(
      `SELECT signing_key, audit_checkpoint_digest, registration_index,
              encounter_digest, sequence, reserved_at
       FROM open_world_observer_signing_reservations
       ORDER BY signing_key ASC`,
    ).toArray();
    const sequenceRows = [...rows].sort((left, right) => left.sequence - right.sequence);
    if (
      rows.length !== expectedCount ||
      sequenceRows.some((row, index) => row.sequence !== index) ||
      rows.some((row) =>
        openWorldObserverSigningKeySync(
          runtime,
          row.audit_checkpoint_digest,
          row.registration_index,
        ) !== row.signing_key
      )
    ) throw new Error("observer signing reservation sequence is corrupt");
    return openWorldObserverSigningStoreSnapshotSync(
      runtime,
      rows.map((row) => ({
        signingKey: row.signing_key,
        encounterDigest: row.encounter_digest,
      })),
    );
  }

  private count(table: string): number {
    if (
      table !== "open_world_observer_signing_reservations" &&
      table !== "open_world_observer_signing_conflicts"
    ) throw new Error("invalid observer signing table");
    return this.storage.sql.exec<{ count: number }>(
      `SELECT COUNT(*) AS count FROM ${table}`,
    ).toArray()[0]?.count ?? 0;
  }
}

export async function signAfterObserverReservation<T>(
  store: OpenWorldObserverSigningStore,
  runtime: LoadedCheckpointRuntime,
  target: OpenWorldObserverSigningTarget,
  sign: () => Promise<T> | T,
  fault?: InjectedObserverSigningStoreFault,
): Promise<OpenWorldObserverSigningResult<T>> {
  const reservation = store.reserve(runtime, target, Date.now(), fault);
  if (reservation.decision === "conflict") return reservation;
  if (reservation.decision === "invalid") return reservation;
  if (reservation.decision === "capacity") return reservation;
  if (reservation.decision === "unavailable") return reservation;
  if (reservation.decision !== "reserved" && reservation.decision !== "reused") {
    throw new Error("unreachable observer signing reservation decision");
  }
  const value = await sign();
  return {
    decision: reservation.decision === "reserved" ? "signed" : "reused",
    reservation: reservation.reservation,
    value,
  };
}
