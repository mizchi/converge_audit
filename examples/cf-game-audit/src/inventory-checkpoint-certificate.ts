import {
  type AsyncDigestSignatureAuthenticationBackend,
  type DigestSignatureAuthenticationCheck,
  digestSignatureAuthenticationCheckValid,
  verifyDigestSignatureAuthenticationChecks,
} from "./authentication-transcript";

export type InventoryCheckpointCertificateAuthenticationCheckKind =
  | "authority_checkpoint"
  | "replay_witness_attestation";

export interface InventoryCheckpointCertificateAuthenticationCheck
  extends DigestSignatureAuthenticationCheck {
  kind: InventoryCheckpointCertificateAuthenticationCheckKind;
  certificate_index: number;
}

export interface InventoryCheckpointCertificateAuthenticationTranscript {
  attestation_count: number;
  checks: InventoryCheckpointCertificateAuthenticationCheck[];
}

export type AsyncInventoryCheckpointCertificateAuthenticationBackend =
  AsyncDigestSignatureAuthenticationBackend;

export type VerifyInventoryCheckpointCertificateAuthenticationResult =
  | { ok: true; checkCount: number }
  | {
      ok: false;
      reason:
        | "invalid_transcript"
        | "digest_mismatch"
        | "signature_refused";
      checkIndex: number;
    };

export async function verifyInventoryCheckpointCertificateAuthentication(
  transcript: InventoryCheckpointCertificateAuthenticationTranscript,
  backend: AsyncInventoryCheckpointCertificateAuthenticationBackend,
): Promise<VerifyInventoryCheckpointCertificateAuthenticationResult> {
  if (
    !Number.isSafeInteger(transcript.attestation_count) ||
    transcript.attestation_count < 0 ||
    transcript.attestation_count > 64 ||
    !Array.isArray(transcript.checks) ||
    transcript.checks.length !== transcript.attestation_count + 1
  ) {
    return { ok: false, reason: "invalid_transcript", checkIndex: 0 };
  }
  for (let index = 0; index < transcript.checks.length; index++) {
    const check = transcript.checks[index];
    const expectedKind = index === 0
      ? "authority_checkpoint"
      : "replay_witness_attestation";
    if (
      !digestSignatureAuthenticationCheckValid(check) ||
      check.kind !== expectedKind ||
      check.certificate_index !== index
    ) {
      return { ok: false, reason: "invalid_transcript", checkIndex: index };
    }
  }
  return verifyDigestSignatureAuthenticationChecks(transcript.checks, backend);
}
