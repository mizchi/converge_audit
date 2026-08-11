import { describe, expect, it } from "vitest";
import { audit_benchmark_make_inventory_lineage_proof_bundle } from "../../../_build/js/release/build/x/game_audit/worker/worker.js";
import { createStandardWebCryptoBackend } from "../../player-local-runtime/crypto-backend";
import {
  type InventoryCheckpointSemanticTranscript,
  verifyInventoryCheckpointSemantics,
} from "../src/inventory-checkpoint-semantics";
import { verifyInventoryLineageProofBundle } from "../src/moonbit";

const authoritySeed =
  "000102030405060708090a0b0c0d0e0f" +
  "101112131415161718191a1b1c1d1e1f";
const participantSeed =
  "202122232425262728292a2b2c2d2e2f" +
  "303132333435363738393a3b3c3d3e3f";

function appendField(value: string): string {
  return `${value.length}:${value}`;
}

/** Test-only implementation diversity; runtime semantics stay in MoonBit. */
function referenceReplayWitnessManifest(
  transcript: InventoryCheckpointSemanticTranscript,
): string {
  const sorted = [...transcript.witnesses].sort((left, right) =>
    right.id < left.id ? -1 : right.id > left.id ? 1 :
      right.key < left.key ? -1 : right.key > left.key ? 1 : 0
  );
  return [
    "replay-witness-session-v1",
    transcript.game_manifest_digest,
    transcript.referee_key,
    transcript.max_faults.toString(),
    sorted.length.toString(),
    ...sorted.flatMap((witness) => [witness.id, witness.key]),
  ].map(appendField).join("");
}

async function verifiedLineage() {
  const fixture = JSON.parse(audit_benchmark_make_inventory_lineage_proof_bundle(
    authoritySeed,
    participantSeed,
    "inventory-session",
    "creation-checkpoint",
    1,
    "asset-1",
    "alice",
    "bob",
    "raid-token",
    1,
    "loot-event",
    0,
    1,
  )) as {
    ok: true;
    bundle_hex: string;
    authority_key: string;
    checkpoint_digest: string;
    game_manifest_digest: string;
    anchor_owner_id: string;
    anchor_version: number;
    anchor_last_event: string;
    anchor_lineage_root: string;
  };
  const verification = await verifyInventoryLineageProofBundle(
    fixture.bundle_hex,
    "inventory-session",
    fixture.authority_key,
    fixture.checkpoint_digest,
    fixture.game_manifest_digest,
    "asset-1",
    "alice",
    "raid-token",
    1,
    "loot-event",
    0,
    "bob",
    fixture.anchor_owner_id,
    fixture.anchor_version,
    fixture.anchor_last_event,
    fixture.anchor_lineage_root,
  );
  if (!verification.ok) throw new Error(verification.error);
  return verification;
}

describe("inventory checkpoint semantics", () => {
  it("recomputes the replay-witness manifest with standard SHA-256", async () => {
    const verification = await verifiedLineage();
    const transcript = verification.checkpoint_semantics;

    expect(transcript.hash_checks[0].canonical_statement).toBe(
      referenceReplayWitnessManifest(transcript),
    );

    await expect(verifyInventoryCheckpointSemantics(
      transcript,
      createStandardWebCryptoBackend(crypto),
    )).resolves.toEqual({
      ok: true,
      witnessCount: 4,
      delegatedRoots: ["event_root", "asset_delta_root"],
    });
    await expect(verifyInventoryCheckpointSemantics(
      {
        ...transcript,
        witnesses: [...transcript.witnesses].reverse(),
      },
      createStandardWebCryptoBackend(crypto),
    )).resolves.toEqual({
      ok: true,
      witnessCount: 4,
      delegatedRoots: ["event_root", "asset_delta_root"],
    });
  });

  it("rejects malformed MoonBit plans and hash-backend mismatches", async () => {
    const verification = await verifiedLineage();
    const transcript = verification.checkpoint_semantics;
    const standard = createStandardWebCryptoBackend(crypto);

    await expect(verifyInventoryCheckpointSemantics(
      {
        ...transcript,
        hash_checks: transcript.hash_checks.map((check) => ({
          ...check,
          canonical_statement: check.canonical_statement + "tampered",
        })),
      },
      standard,
    )).resolves.toEqual({ ok: false, reason: "manifest_mismatch" });
    await expect(verifyInventoryCheckpointSemantics(
      {
        ...transcript,
        hash_check_count: 2,
      },
      standard,
    )).resolves.toEqual({ ok: false, reason: "invalid_transcript" });
    await expect(verifyInventoryCheckpointSemantics(
      {
        ...transcript,
        hash_checks: transcript.hash_checks.map((check) => ({
          ...check,
          kind: "wrong_kind",
        })),
      },
      standard,
    )).resolves.toEqual({ ok: false, reason: "invalid_transcript" });
    await expect(verifyInventoryCheckpointSemantics(
      transcript,
      { hashString: async () => "0".repeat(64) },
    )).resolves.toEqual({ ok: false, reason: "manifest_mismatch" });
  });
});
