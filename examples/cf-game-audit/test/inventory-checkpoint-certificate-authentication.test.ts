import { describe, expect, it } from "vitest";
import { audit_benchmark_make_inventory_lineage_proof_bundle } from "../../../_build/js/release/build/x/game_audit/worker_fixture/worker_fixture.js";
import { createStandardWebCryptoBackend } from "../../player-local-runtime/crypto-backend";
import {
  verifyInventoryCheckpointCertificateAuthentication,
} from "../src/inventory-checkpoint-certificate";
import { verifyInventoryLineageProofBundle } from "../src/moonbit";

const authoritySeed =
  "000102030405060708090a0b0c0d0e0f" +
  "101112131415161718191a1b1c1d1e1f";
const participantSeed =
  "202122232425262728292a2b2c2d2e2f" +
  "303132333435363738393a3b3c3d3e3f";

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
    2,
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

describe("inventory checkpoint certificate authentication", () => {
  it("independently verifies the authority checkpoint and witness signatures", async () => {
    const verification = await verifiedLineage();

    await expect(verifyInventoryCheckpointCertificateAuthentication(
      verification.checkpoint_authentication,
      createStandardWebCryptoBackend(crypto),
    )).resolves.toEqual({ ok: true, checkCount: 4 });
  });

  it("rejects incomplete, reordered, and digest-mismatched transcripts", async () => {
    const verification = await verifiedLineage();
    const transcript = verification.checkpoint_authentication;
    const standard = createStandardWebCryptoBackend(crypto);

    await expect(verifyInventoryCheckpointCertificateAuthentication(
      { ...transcript, checks: transcript.checks.slice(0, 1) },
      standard,
    )).resolves.toEqual({
      ok: false,
      reason: "invalid_transcript",
      checkIndex: 0,
    });
    await expect(verifyInventoryCheckpointCertificateAuthentication(
      { ...transcript, checks: [...transcript.checks].reverse() },
      standard,
    )).resolves.toEqual({
      ok: false,
      reason: "invalid_transcript",
      checkIndex: 0,
    });
    await expect(verifyInventoryCheckpointCertificateAuthentication(
      {
        ...transcript,
        checks: [
          undefined,
          ...transcript.checks.slice(1),
        ] as unknown as typeof transcript.checks,
      },
      standard,
    )).resolves.toEqual({
      ok: false,
      reason: "invalid_transcript",
      checkIndex: 0,
    });
    await expect(verifyInventoryCheckpointCertificateAuthentication(
      transcript,
      {
        hashString: async () => "0".repeat(64),
        verify: async () => true,
      },
    )).resolves.toEqual({
      ok: false,
      reason: "digest_mismatch",
      checkIndex: 0,
    });
  });
});
