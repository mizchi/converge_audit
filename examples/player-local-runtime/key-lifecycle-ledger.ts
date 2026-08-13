import {
  validateVerificationKeyHistory,
  type VerificationKeyRecord,
} from "./key-lifecycle.ts";
import type { Awaitable } from "./contracts.ts";

export type VerificationKeyLifecycleEventKind =
  | "provision"
  | "rotate"
  | "revoke";

export interface VerificationKeyLifecycleEvent {
  version: 1;
  eventDigest: string;
  keyId: string;
  keyVersion: number;
  lifecycleRevision: number;
  eventKind: VerificationKeyLifecycleEventKind;
  canonicalEvent: string;
  committedAtMs: number;
}

export interface VerificationKeyLifecycleImage {
  records: VerificationKeyRecord[];
  events: VerificationKeyLifecycleEvent[];
}

export interface VerificationKeyLifecycleDigestAdapter {
  hashString(value: string): Awaitable<string>;
}

interface LifecycleCommandBase {
  expectedRevision: number;
  committedAtMs: number;
  digest: VerificationKeyLifecycleDigestAdapter;
}

export interface ProvisionVerificationKeyCommand extends LifecycleCommandBase {
  kind?: "provision";
  record: VerificationKeyRecord;
}

export interface RotateVerificationKeyCommand extends LifecycleCommandBase {
  kind?: "rotate";
  keyId: string;
  previousKeyVersion: number;
  nextRecord: VerificationKeyRecord;
  cutoverMs: number;
}

export interface RevokeVerificationKeyCommand extends LifecycleCommandBase {
  kind?: "revoke";
  keyId: string;
  keyVersion: number;
  revokedAtMs: number;
}

export type VerificationKeyLifecycleCommand =
  | (ProvisionVerificationKeyCommand & { kind: "provision" })
  | (RotateVerificationKeyCommand & { kind: "rotate" })
  | (RevokeVerificationKeyCommand & { kind: "revoke" });

export type UnsignedVerificationKeyLifecycleCommand =
  VerificationKeyLifecycleCommand extends infer Command
    ? Command extends VerificationKeyLifecycleCommand
      ? Omit<Command, "digest">
      : never
    : never;

export type VerificationKeyLifecycleMutationResult =
  | { decision: "committed"; revision: number }
  | {
    decision: "refused";
    reason:
      | "invalid_transition"
      | "stale_revision"
      | "key_already_exists"
      | "unknown_key"
      | "corrupt_store";
  };

export type VerificationKeyLifecyclePlan =
  | {
    ok: true;
    records: VerificationKeyRecord[];
    event: Omit<VerificationKeyLifecycleEvent, "eventDigest">;
  }
  | {
    ok: false;
    result: Extract<
      VerificationKeyLifecycleMutationResult,
      { decision: "refused" }
    >;
  };

export function planVerificationKeyLifecycleMutation(
  image: VerificationKeyLifecycleImage,
  command: UnsignedVerificationKeyLifecycleCommand,
): VerificationKeyLifecyclePlan {
  if (!lifecycleImageValid(image)) {
    return refused("corrupt_store");
  }
  if (
    !safeNonNegativeInteger(command.expectedRevision) ||
    !safeNonNegativeInteger(command.committedAtMs)
  ) return refused("invalid_transition");

  const records = image.records.filter((record) =>
    record.keyId === commandKeyId(command)
  );
  const events = image.events.filter((event) =>
    event.keyId === commandKeyId(command)
  );
  const currentRevision = events.at(-1)?.lifecycleRevision ?? 0;
  if (command.expectedRevision !== currentRevision) {
    return refused("stale_revision");
  }

  let nextRecords: VerificationKeyRecord[];
  let eventKeyVersion: number;
  if (command.kind === "provision") {
    if (records.length > 0 || events.length > 0) {
      return refused("key_already_exists");
    }
    if (
      command.expectedRevision !== 0 || command.record.keyVersion !== 1 ||
      command.record.revokedAtMs !== null ||
      !validateVerificationKeyHistory([command.record]).ok
    ) return refused("invalid_transition");
    nextRecords = [{ ...command.record }];
    eventKeyVersion = command.record.keyVersion;
  } else if (command.kind === "rotate") {
    if (records.length === 0) {
      return refused("unknown_key");
    }
    const ordered = [...records].sort((left, right) =>
      left.keyVersion - right.keyVersion
    );
    const previous = ordered.at(-1)!;
    if (
      previous.keyVersion !== command.previousKeyVersion ||
      command.nextRecord.keyId !== command.keyId ||
      command.nextRecord.keyVersion !== previous.keyVersion + 1 ||
      command.nextRecord.subjectId !== previous.subjectId ||
      command.nextRecord.purpose !== previous.purpose ||
      command.nextRecord.scopeId !== previous.scopeId ||
      command.nextRecord.validFromMs !== command.cutoverMs ||
      command.nextRecord.revokedAtMs !== null ||
      !safeNonNegativeInteger(command.cutoverMs) ||
      command.cutoverMs <= previous.validFromMs ||
      command.cutoverMs > previous.validUntilMs
    ) return refused("invalid_transition");
    nextRecords = ordered.map((record) =>
      record.keyVersion === previous.keyVersion
        ? { ...record, validUntilMs: command.cutoverMs }
        : { ...record }
    );
    nextRecords.push({ ...command.nextRecord });
    if (!validateVerificationKeyHistory(nextRecords).ok) {
      return refused("invalid_transition");
    }
    eventKeyVersion = command.nextRecord.keyVersion;
  } else {
    const target = records.find((record) =>
      record.keyVersion === command.keyVersion
    );
    if (!target) return refused("unknown_key");
    if (
      target.revokedAtMs !== null ||
      !safeNonNegativeInteger(command.revokedAtMs) ||
      command.revokedAtMs < target.validFromMs ||
      command.revokedAtMs > target.validUntilMs
    ) return refused("invalid_transition");
    nextRecords = records.map((record) =>
      record.keyVersion === command.keyVersion
        ? { ...record, revokedAtMs: command.revokedAtMs }
        : { ...record }
    );
    if (!validateVerificationKeyHistory(nextRecords).ok) {
      return refused("invalid_transition");
    }
    eventKeyVersion = command.keyVersion;
  }

  const lifecycleRevision = currentRevision + 1;
  const canonicalEvent = canonicalVerificationKeyLifecycleEvent(
    command,
    lifecycleRevision,
  );
  return {
    ok: true,
    records: nextRecords,
    event: {
      version: 1,
      keyId: commandKeyId(command),
      keyVersion: eventKeyVersion,
      lifecycleRevision,
      eventKind: command.kind,
      canonicalEvent,
      committedAtMs: command.committedAtMs,
    },
  };
}

export function canonicalVerificationKeyLifecycleEvent(
  command: UnsignedVerificationKeyLifecycleCommand,
  lifecycleRevision: number,
): string {
  if (command.kind === "provision") {
    return JSON.stringify([
      "converge-audit-verification-key-lifecycle-v1",
      "provision",
      lifecycleRevision,
      command.expectedRevision,
      recordTuple(command.record),
      command.committedAtMs,
    ]);
  }
  if (command.kind === "rotate") {
    return JSON.stringify([
      "converge-audit-verification-key-lifecycle-v1",
      "rotate",
      lifecycleRevision,
      command.expectedRevision,
      command.keyId,
      command.previousKeyVersion,
      command.cutoverMs,
      recordTuple(command.nextRecord),
      command.committedAtMs,
    ]);
  }
  return JSON.stringify([
    "converge-audit-verification-key-lifecycle-v1",
    "revoke",
    lifecycleRevision,
    command.expectedRevision,
    command.keyId,
    command.keyVersion,
    command.revokedAtMs,
    command.committedAtMs,
  ]);
}

function lifecycleImageValid(image: VerificationKeyLifecycleImage): boolean {
  if (!Array.isArray(image.records) || !Array.isArray(image.events)) return false;
  if (image.records.length > 0 && !validateVerificationKeyHistory(image.records).ok) {
    return false;
  }
  const eventSlots = new Map<string, VerificationKeyLifecycleEvent[]>();
  for (const event of image.events) {
    if (
      event.version !== 1 || !identifier(event.keyId, 256) ||
      !safePositiveInteger(event.keyVersion) ||
      !safePositiveInteger(event.lifecycleRevision) ||
      (event.eventKind !== "provision" && event.eventKind !== "rotate" &&
        event.eventKind !== "revoke") ||
      typeof event.eventDigest !== "string" ||
      !/^[0-9a-f]{64}$/.test(event.eventDigest) ||
      typeof event.canonicalEvent !== "string" ||
      event.canonicalEvent.length === 0 || event.canonicalEvent.length > 65_536 ||
      !safeNonNegativeInteger(event.committedAtMs)
    ) return false;
    const slot = eventSlots.get(event.keyId) ?? [];
    slot.push(event);
    eventSlots.set(event.keyId, slot);
  }
  for (const [keyId, events] of eventSlots) {
    const ordered = [...events].sort((left, right) =>
      left.lifecycleRevision - right.lifecycleRevision
    );
    if (
      ordered[0]?.eventKind !== "provision" ||
      ordered.some((event, index) =>
        event.lifecycleRevision !== index + 1 || event.keyId !== keyId
      )
    ) return false;
  }
  const recordKeyIds = new Set(image.records.map((record) => record.keyId));
  if (recordKeyIds.size !== eventSlots.size) return false;
  for (const keyId of recordKeyIds) {
    const records = image.records.filter((record) => record.keyId === keyId)
      .sort((left, right) => left.keyVersion - right.keyVersion);
    const events = [...(eventSlots.get(keyId) ?? [])].sort((left, right) =>
      left.lifecycleRevision - right.lifecycleRevision
    );
    if (
      events.length === 0 || events[0].eventKind !== "provision" ||
      events[0].keyVersion !== 1 ||
      records.some((record, index) => record.keyVersion !== index + 1) ||
      events.some((event, index) =>
        index > 0 && event.committedAtMs < events[index - 1].committedAtMs
      )
    ) return false;
    const rotations = events.filter((event) => event.eventKind === "rotate");
    if (
      rotations.length !== records.length - 1 ||
      rotations.some((event, index) => event.keyVersion !== index + 2)
    ) return false;
    const revocations = events.filter((event) => event.eventKind === "revoke");
    const revokedVersions = records.filter((record) =>
      record.revokedAtMs !== null
    ).map((record) => record.keyVersion);
    if (
      new Set(revocations.map((event) => event.keyVersion)).size !==
        revocations.length ||
      revocations.some((event) =>
        !revokedVersions.includes(event.keyVersion)
      ) ||
      revokedVersions.some((keyVersion) =>
        !revocations.some((event) => event.keyVersion === keyVersion)
      )
    ) return false;
  }
  return true;
}

function commandKeyId(
  command: UnsignedVerificationKeyLifecycleCommand,
): string {
  return command.kind === "provision" ? command.record.keyId : command.keyId;
}

function refused(
  reason: Extract<
    VerificationKeyLifecycleMutationResult,
    { decision: "refused" }
  >["reason"],
): Extract<VerificationKeyLifecyclePlan, { ok: false }> {
  return { ok: false, result: { decision: "refused", reason } };
}

function recordTuple(record: VerificationKeyRecord): unknown[] {
  return [
    record.version,
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
  ];
}

function identifier(value: unknown, maxLength: number): value is string {
  return typeof value === "string" && value.length > 0 &&
    value.length <= maxLength &&
    /^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value);
}

function safePositiveInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}

function safeNonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}
