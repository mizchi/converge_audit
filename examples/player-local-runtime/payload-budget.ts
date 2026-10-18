type AuditModule = typeof import("../../_build/js/release/build/audit/runtime/bridge/bridge.js");

export interface PayloadQueueLimits {
  /** Logical payload bytes; browser database overhead is excluded. */
  maxBytes: number;
  maxItems: number;
  maxItemBytes: number;
  /** Payloads cannot consume this headroom. Control storage needs its own budget. */
  reservedBytes: number;
}

const MAX_INT = 2_147_483_647;

export function payloadQueueLimitsValid(limits: PayloadQueueLimits): boolean {
  return [limits.maxBytes, limits.maxItems, limits.maxItemBytes, limits.reservedBytes]
    .every((value) => Number.isInteger(value) && value >= 0 && value <= MAX_INT) &&
    limits.reservedBytes <= limits.maxBytes;
}

/** Cryptographic authentication and game policy stay outside this pure gate. */
export class MoonBitPayloadBudgetPolicy {
  private readonly module: AuditModule;

  private constructor(module: AuditModule) { this.module = module; }

  static async load(): Promise<MoonBitPayloadBudgetPolicy> {
    return new MoonBitPayloadBudgetPolicy(await import(
      "../../_build/js/release/build/audit/runtime/bridge/bridge.js"
    ));
  }

  admits(limits: PayloadQueueLimits, usedBytes: number, itemCount: number, incomingBytes: number): boolean {
    if (!payloadQueueLimitsValid(limits) ||
      ![usedBytes, itemCount, incomingBytes].every((value) =>
        Number.isInteger(value) && value >= 0 && value <= MAX_INT
      )) return false;
    return this.module.audit_player_local_payload_admission_allowed(
      usedBytes, itemCount, incomingBytes,
      limits.maxBytes, limits.maxItems, limits.maxItemBytes, limits.reservedBytes,
    );
  }

  registersScope(current: number, maximum: number): boolean {
    if (![current, maximum].every((value) => Number.isInteger(value) && value >= 0 && value <= MAX_INT)) return false;
    return this.module.audit_player_local_payload_scope_registration_allowed(current, maximum);
  }

  reserves(limits: PayloadQueueLimits, usedBytes: number, itemCount: number,
    reservedBytes: number, reservedItems: number, bytes: number, items: number): boolean {
    if (!payloadQueueLimitsValid(limits) || ![usedBytes, itemCount, reservedBytes, reservedItems, bytes, items]
      .every((value) => Number.isInteger(value) && value >= 0 && value <= MAX_INT)) return false;
    return this.module.audit_player_local_payload_reservation_allowed(
      usedBytes, itemCount, reservedBytes, reservedItems, bytes, items,
      limits.maxBytes, limits.maxItems, limits.reservedBytes,
    );
  }

  prunable(evidence: {
    deliveryAcknowledged: boolean;
    gameplayFinalized: boolean;
    retentionClosed: boolean;
    unresolvedReference: boolean;
  }): boolean {
    if (![evidence.deliveryAcknowledged, evidence.gameplayFinalized,
      evidence.retentionClosed, evidence.unresolvedReference]
      .every((value) => typeof value === "boolean")) return false;
    return this.module.audit_player_local_payload_prunable(
      evidence.deliveryAcknowledged, evidence.gameplayFinalized,
      evidence.retentionClosed, evidence.unresolvedReference,
    );
  }
}
