import type { AuditCryptoBackend } from "../../../player-local-runtime/crypto-backend.ts";
import { exactKeys, identifier } from "./validation.ts";
import { frame, isDigest, isTime } from "./wire.ts";
export interface EncounterGenerationSeal {
  statement: { version: 1; authorityKey: string; unit: string; generation: number; nextGeneration: number;
    previousSealId: string | null; originsDigest: string; ticketCount: number; receiptCount: number; closedAt: number };
  sealId: string;
  signature: string;
}
export function generationSealFrame(s: EncounterGenerationSeal["statement"]): string {
  return frame("encounter-generation-seal-v1", s.version, s.authorityKey, s.unit, s.generation, s.nextGeneration,
    s.previousSealId, s.originsDigest, s.ticketCount, s.receiptCount, s.closedAt);
}
export async function verifyGenerationSeal(value: unknown, trustedKey: string, backend: AuditCryptoBackend): Promise<boolean> {
  try {
    if (!exactKeys(value, ["statement", "sealId", "signature"]) || !isDigest(value.sealId) || typeof value.signature !== "string" ||
        !/^[0-9a-f]{128}$/.test(value.signature) || new TextEncoder().encode(JSON.stringify(value)).byteLength > 2_048) return false;
    const s = value.statement;
    if (!exactKeys(s, ["version", "authorityKey", "unit", "generation", "nextGeneration", "previousSealId", "originsDigest", "ticketCount", "receiptCount", "closedAt"]) ||
        s.version !== 1 || s.authorityKey !== trustedKey || !isDigest(trustedKey) || !identifier(s.unit) ||
        !isTime(s.generation) || !isTime(s.nextGeneration) || s.nextGeneration !== s.generation + 1 ||
        (s.previousSealId !== null && !isDigest(s.previousSealId)) || (s.generation === 0) !== (s.previousSealId === null) || !isDigest(s.originsDigest) ||
        !isTime(s.ticketCount) || s.ticketCount > 1_024 || !isTime(s.receiptCount) || s.receiptCount > s.ticketCount || !isTime(s.closedAt)) return false;
    return value.sealId === await backend.hashString(generationSealFrame(s as unknown as EncounterGenerationSeal["statement"])) && await backend.verify(trustedKey, value.sealId, value.signature);
  } catch { return false; }
}
