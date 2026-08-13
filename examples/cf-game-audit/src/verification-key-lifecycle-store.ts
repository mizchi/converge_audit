import type { VerificationKeyRecord } from
  "../../player-local-runtime/key-lifecycle.ts";
import {
  planVerificationKeyLifecycleMutation,
  type ProvisionVerificationKeyCommand,
  type RevokeVerificationKeyCommand,
  type RotateVerificationKeyCommand,
  type VerificationKeyLifecycleCommand,
  type VerificationKeyLifecycleEvent,
  type VerificationKeyLifecycleImage,
  type VerificationKeyLifecycleMutationResult,
} from "../../player-local-runtime/key-lifecycle-ledger.ts";

interface KeyRow extends Record<string, SqlStorageValue> {
  key_id: string;
  key_version: number;
  subject_id: string;
  purpose: string;
  scope_id: string;
  scheme: string;
  public_key: string;
  valid_from_ms: number;
  valid_until_ms: number;
  revoked_at_ms: number | null;
  lifecycle_revision: number;
}

interface LifecycleEventRow extends Record<string, SqlStorageValue> {
  event_digest: string;
  key_id: string;
  key_version: number;
  lifecycle_revision: number;
  event_kind: string;
  canonical_event: string;
  committed_at_ms: number;
}

export class VerificationKeyLifecycleStore {
  constructor(private readonly storage: DurableObjectStorage) {
    this.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS verification_key_versions (
        key_id TEXT NOT NULL CHECK (
          length(key_id) > 0 AND length(key_id) <= 256
        ),
        key_version INTEGER NOT NULL CHECK (key_version > 0),
        subject_id TEXT NOT NULL CHECK (
          length(subject_id) > 0 AND length(subject_id) <= 256
        ),
        purpose TEXT NOT NULL CHECK (
          length(purpose) > 0 AND length(purpose) <= 128
        ),
        scope_id TEXT NOT NULL CHECK (
          length(scope_id) > 0 AND length(scope_id) <= 256
        ),
        scheme TEXT NOT NULL CHECK (
          length(scheme) > 0 AND length(scheme) <= 128
        ),
        public_key TEXT NOT NULL CHECK (
          length(public_key) > 0 AND length(public_key) <= 16384
        ),
        valid_from_ms INTEGER NOT NULL CHECK (valid_from_ms >= 0),
        valid_until_ms INTEGER NOT NULL CHECK (
          valid_until_ms > valid_from_ms
        ),
        revoked_at_ms INTEGER CHECK (
          revoked_at_ms IS NULL OR
          (revoked_at_ms >= valid_from_ms AND revoked_at_ms <= valid_until_ms)
        ),
        lifecycle_revision INTEGER NOT NULL CHECK (lifecycle_revision > 0),
        PRIMARY KEY (key_id, key_version)
      );
      CREATE TABLE IF NOT EXISTS verification_key_lifecycle_events (
        event_digest TEXT PRIMARY KEY CHECK (length(event_digest) = 64),
        key_id TEXT NOT NULL,
        key_version INTEGER NOT NULL CHECK (key_version > 0),
        lifecycle_revision INTEGER NOT NULL CHECK (lifecycle_revision > 0),
        event_kind TEXT NOT NULL CHECK (
          event_kind IN ('provision', 'rotate', 'revoke')
        ),
        canonical_event TEXT NOT NULL CHECK (
          length(canonical_event) > 0 AND length(canonical_event) <= 65536
        ),
        committed_at_ms INTEGER NOT NULL CHECK (committed_at_ms >= 0),
        UNIQUE (key_id, lifecycle_revision)
      );
      CREATE INDEX IF NOT EXISTS verification_key_lifecycle_events_key
        ON verification_key_lifecycle_events(key_id, lifecycle_revision);
    `);
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

  image(keyId: string): VerificationKeyLifecycleImage {
    const records = this.storage.sql.exec<KeyRow>(
      `SELECT key_id, key_version, subject_id, purpose, scope_id, scheme,
              public_key, valid_from_ms, valid_until_ms, revoked_at_ms,
              lifecycle_revision
       FROM verification_key_versions
       WHERE key_id = ? ORDER BY key_version`,
      keyId,
    ).toArray().map(keyRecord);
    const events = this.storage.sql.exec<LifecycleEventRow>(
      `SELECT event_digest, key_id, key_version, lifecycle_revision,
              event_kind, canonical_event, committed_at_ms
       FROM verification_key_lifecycle_events
       WHERE key_id = ? ORDER BY lifecycle_revision`,
      keyId,
    ).toArray().map(lifecycleEvent);
    return { records, events };
  }

  private async commit(
    command: VerificationKeyLifecycleCommand,
  ): Promise<VerificationKeyLifecycleMutationResult> {
    const unsigned = planVerificationKeyLifecycleMutation(
      this.image(command.kind === "provision" ? command.record.keyId : command.keyId),
      command,
    );
    if (!unsigned.ok) return unsigned.result;
    const eventDigest = await command.digest.hashString(
      unsigned.event.canonicalEvent,
    );
    if (!/^[0-9a-f]{64}$/.test(eventDigest)) {
      return { decision: "refused", reason: "invalid_transition" };
    }
    return this.storage.transactionSync(() => {
      const keyId = command.kind === "provision" ? command.record.keyId : command.keyId;
      const plan = planVerificationKeyLifecycleMutation(this.image(keyId), command);
      if (!plan.ok) return plan.result;
      const event: VerificationKeyLifecycleEvent = {
        ...plan.event,
        eventDigest,
      };
      for (const record of plan.records) this.upsertRecord(record, event.lifecycleRevision);
      this.storage.sql.exec(
        `INSERT INTO verification_key_lifecycle_events
         (event_digest, key_id, key_version, lifecycle_revision, event_kind,
          canonical_event, committed_at_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        event.eventDigest,
        event.keyId,
        event.keyVersion,
        event.lifecycleRevision,
        event.eventKind,
        event.canonicalEvent,
        event.committedAtMs,
      );
      return { decision: "committed", revision: event.lifecycleRevision };
    });
  }

  private upsertRecord(record: VerificationKeyRecord, revision: number): void {
    this.storage.sql.exec(
      `INSERT INTO verification_key_versions
       (key_id, key_version, subject_id, purpose, scope_id, scheme, public_key,
        valid_from_ms, valid_until_ms, revoked_at_ms, lifecycle_revision)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(key_id, key_version) DO UPDATE SET
         subject_id = excluded.subject_id,
         purpose = excluded.purpose,
         scope_id = excluded.scope_id,
         scheme = excluded.scheme,
         public_key = excluded.public_key,
         valid_from_ms = excluded.valid_from_ms,
         valid_until_ms = excluded.valid_until_ms,
         revoked_at_ms = excluded.revoked_at_ms,
         lifecycle_revision = excluded.lifecycle_revision`,
      record.keyId,
      record.keyVersion,
      record.subjectId,
      record.purpose,
      record.scopeId,
      record.scheme,
      record.publicKey,
      record.validFromMs,
      record.validUntilMs,
      record.revokedAtMs,
      revision,
    );
  }
}

function keyRecord(row: KeyRow): VerificationKeyRecord {
  return {
    version: 1,
    keyId: row.key_id,
    keyVersion: row.key_version,
    subjectId: row.subject_id,
    purpose: row.purpose,
    scopeId: row.scope_id,
    scheme: row.scheme,
    publicKey: row.public_key,
    validFromMs: row.valid_from_ms,
    validUntilMs: row.valid_until_ms,
    revokedAtMs: row.revoked_at_ms,
  };
}

function lifecycleEvent(row: LifecycleEventRow): VerificationKeyLifecycleEvent {
  return {
    version: 1,
    eventDigest: row.event_digest,
    keyId: row.key_id,
    keyVersion: row.key_version,
    lifecycleRevision: row.lifecycle_revision,
    eventKind: row.event_kind as VerificationKeyLifecycleEvent["eventKind"],
    canonicalEvent: row.canonical_event,
    committedAtMs: row.committed_at_ms,
  };
}
