import {
  type AsyncDigestVerificationBackend,
  type DigestVerificationPlan,
  verifyDigestVerificationPlan,
} from "../../player-local-runtime/digest-verification-plan";

export interface ReplayWitnessSemanticIdentity {
  id: string;
  key: string;
}

export interface InventoryCheckpointSemanticTranscript
  extends DigestVerificationPlan {
  manifest_digest: string;
  event_root: string;
  asset_delta_root: string;
  game_manifest_digest: string;
  referee_key: string;
  witness_count: number;
  witnesses: ReplayWitnessSemanticIdentity[];
  max_faults: number;
  delegated_roots: DelegatedInventoryCheckpointRoot[];
}

export type AsyncInventoryCheckpointSemanticDigest =
  AsyncDigestVerificationBackend;

export type DelegatedInventoryCheckpointRoot =
  | "event_root"
  | "asset_delta_root";

export type VerifyInventoryCheckpointSemanticsResult =
  | {
      ok: true;
      witnessCount: number;
      delegatedRoots: DelegatedInventoryCheckpointRoot[];
    }
  | {
      ok: false;
      reason: "invalid_transcript" | "manifest_mismatch";
    };

/**
 * Execute the MoonBit-owned session-manifest plan at the Worker boundary. The
 * compact bundle intentionally delegates its event/effect roots to n-f replay
 * witnesses rather than duplicating the full log in this adapter.
 */
export async function verifyInventoryCheckpointSemantics(
  transcript: InventoryCheckpointSemanticTranscript,
  digest: AsyncInventoryCheckpointSemanticDigest,
): Promise<VerifyInventoryCheckpointSemanticsResult> {
  const manifestCheck = transcript?.hash_checks?.[0];
  if (
    typeof transcript !== "object" || transcript === null ||
    !Number.isSafeInteger(transcript.witness_count) ||
    transcript.witness_count <= 0 || transcript.witness_count > 64 ||
    transcript.hash_check_count !== 1 ||
    manifestCheck?.kind !== "replay_witness_session_manifest" ||
    manifestCheck?.check_index !== 0 ||
    manifestCheck.expected_digest !== transcript.manifest_digest ||
    !Array.isArray(transcript.delegated_roots) ||
    transcript.delegated_roots.length !== 2 ||
    transcript.delegated_roots[0] !== "event_root" ||
    transcript.delegated_roots[1] !== "asset_delta_root"
  ) {
    return { ok: false, reason: "invalid_transcript" };
  }
  const verified = await verifyDigestVerificationPlan(transcript, digest);
  if (!verified.ok) {
    if (verified.reason === "invalid_plan") {
      return { ok: false, reason: "invalid_transcript" };
    }
    return { ok: false, reason: "manifest_mismatch" };
  }
  return {
    ok: true,
    witnessCount: transcript.witness_count,
    delegatedRoots: transcript.delegated_roots,
  };
}
