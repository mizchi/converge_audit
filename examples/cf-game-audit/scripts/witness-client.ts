import {
  approveCheckpointWitnessCollectionWithLegacySeed,
  selectCheckpointWitnessSigningKey,
  type AuditMode,
} from "../src/witness-client";
import {
  compileVerificationKeyHistory,
  decodeVerificationKeyHistory,
} from "../../player-local-runtime/key-lifecycle";

const [modeValue, unit, collectionId, witnessId] = process.argv.slice(2);
const witnessSeedHex = process.env.AUDIT_WITNESS_SEED_HEX;
const baseUrl = process.env.AUDIT_BASE_URL ?? "http://127.0.0.1:8787";
const encodedKeyHistory = process.env.AUDIT_WITNESS_KEY_HISTORY;

if (!isAuditMode(modeValue) || !unit || !collectionId || !witnessId) {
  throw new Error(
    "usage: pnpm witness -- <pve|pvp|open> <unit> <collection-id> <witness-id>",
  );
}
if (!witnessSeedHex) {
  throw new Error("AUDIT_WITNESS_SEED_HEX is required");
}
const keyRecords = decodeVerificationKeyHistory(encodedKeyHistory);
if (!keyRecords) throw new Error("AUDIT_WITNESS_KEY_HISTORY is required");
const compiled = compileVerificationKeyHistory(keyRecords);
if (!compiled.ok) throw new Error(compiled.reason);
const signingTimeMs = Date.now();
const verificationKey = selectCheckpointWitnessSigningKey(
  keyRecords,
  witnessId,
  `cf:${modeValue}:${unit}`,
  signingTimeMs,
);
if (!verificationKey) {
  throw new Error("active witness key is absent from key history");
}

const started = performance.now();
const result = await approveCheckpointWitnessCollectionWithLegacySeed({
  baseUrl,
  mode: modeValue,
  unit,
  collectionId,
  witnessId,
  witnessSeedHex,
  verificationKey,
  keyHistory: compiled.history,
  legacyAcceptUntilMs: 0,
  maxClockSkewMs: 5_000,
  now: () => signingTimeMs,
});

console.log(JSON.stringify({
  ok: result.httpStatus < 400,
  collection_id: collectionId,
  witness_id: result.witnessId,
  witness_key: result.witnessKey,
  approval_bytes: result.approvalBytes,
  http_status: result.httpStatus,
  retry_after_seconds: result.retryAfterSeconds,
  elapsed_ms: Math.round((performance.now() - started) * 1_000) / 1_000,
  response: result.response,
}, null, 2));

if (result.httpStatus >= 400) process.exitCode = 1;

function isAuditMode(value: string | undefined): value is AuditMode {
  return value === "pve" || value === "pvp" || value === "open";
}
