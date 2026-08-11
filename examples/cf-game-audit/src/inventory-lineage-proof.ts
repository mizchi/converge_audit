import {
  type AsyncDigestSignatureAuthenticationBackend,
  type DigestSignatureAuthenticationCheck,
  digestSignatureAuthenticationCheckValid,
  verifyDigestSignatureAuthenticationChecks,
} from "./authentication-transcript";

export interface InventoryLineageProofIdentity {
  unit: string;
  assetId: string;
  lineageBundleHex: string;
}

export interface InventoryLineageProofDigestAdapter {
  hashString(value: string): string;
}

export interface AsyncInventoryLineageProofDigestAdapter {
  hashString(value: string): Promise<string>;
}

export function canonicalInventoryLineageProof(
  identity: InventoryLineageProofIdentity,
): string {
  return JSON.stringify([
    "converge-audit-inventory-lineage-proof-v1",
    identity.unit,
    identity.assetId,
    identity.lineageBundleHex,
  ]);
}

export function inventoryLineageProofDigest(
  identity: InventoryLineageProofIdentity,
  digest: InventoryLineageProofDigestAdapter,
): string {
  return digest.hashString(canonicalInventoryLineageProof(identity));
}

export function inventoryLineageProofDigestAsync(
  identity: InventoryLineageProofIdentity,
  digest: AsyncInventoryLineageProofDigestAdapter,
): Promise<string> {
  return digest.hashString(canonicalInventoryLineageProof(identity));
}

export interface InventoryLineageAuthenticationTranscript {
  transfer_count: number;
  authentication_checks: Array<DigestSignatureAuthenticationCheck & {
    kind:
      | "sender_binding"
      | "recipient_binding"
      | "sender_transfer"
      | "recipient_transfer";
    transfer_index: number;
    public_key: string;
    canonical_statement: string;
    digest: string;
    signature: string;
  }>;
}

export type AsyncInventoryLineageAuthenticationBackend =
  AsyncDigestSignatureAuthenticationBackend;

export type VerifyInventoryLineageAuthenticationTranscriptResult =
  | { ok: true; checkCount: number }
  | {
      ok: false;
      reason:
        | "invalid_transcript"
        | "digest_mismatch"
        | "signature_refused";
      checkIndex: number;
    };

const authenticationCheckKinds = [
  "sender_binding",
  "recipient_binding",
  "sender_transfer",
  "recipient_transfer",
] as const;

export async function verifyInventoryLineageAuthenticationTranscript(
  transcript: InventoryLineageAuthenticationTranscript,
  backend: AsyncInventoryLineageAuthenticationBackend,
): Promise<VerifyInventoryLineageAuthenticationTranscriptResult> {
  if (
    !Number.isSafeInteger(transcript.transfer_count) ||
    transcript.transfer_count <= 0 || transcript.transfer_count > 64 ||
    !Array.isArray(transcript.authentication_checks) ||
    transcript.authentication_checks.length !== transcript.transfer_count * 4
  ) {
    return { ok: false, reason: "invalid_transcript", checkIndex: 0 };
  }
  const checks = transcript.authentication_checks;
  for (let index = 0; index < checks.length; index++) {
    const check = checks[index];
    if (
      !digestSignatureAuthenticationCheckValid(check) ||
      check.kind !== authenticationCheckKinds[index % 4] ||
      check.transfer_index !== Math.floor(index / 4)
    ) {
      return { ok: false, reason: "invalid_transcript", checkIndex: index };
    }
  }

  return verifyDigestSignatureAuthenticationChecks(checks, backend);
}
