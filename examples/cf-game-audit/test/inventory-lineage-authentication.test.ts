import { describe, expect, it } from "vitest";
import { audit_benchmark_make_inventory_lineage_proof_bundle } from "../../../_build/js/release/build/x/game_audit/worker/worker.js";
import { createStandardWebCryptoBackend } from "../../player-local-runtime/crypto-backend";
import {
  verifyInventoryLineageProofBundle,
} from "../src/moonbit";
import {
  verifyInventoryLineageAuthenticationTranscript,
} from "../src/inventory-lineage-proof";

const authoritySeed =
  "000102030405060708090a0b0c0d0e0f" +
  "101112131415161718191a1b1c1d1e1f";
const participantSeed =
  "202122232425262728292a2b2c2d2e2f" +
  "303132333435363738393a3b3c3d3e3f";

function lineageFixture(version = 2) {
  return JSON.parse(audit_benchmark_make_inventory_lineage_proof_bundle(
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
    version,
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
}

describe("inventory lineage authentication transcript", () => {
  it("independently verifies every binding and transfer signature", async () => {
    const fixture = lineageFixture();
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
    expect(verification.ok).toBe(true);
    if (!verification.ok) throw new Error(verification.error);

    await expect(verifyInventoryLineageAuthenticationTranscript(
      verification,
      createStandardWebCryptoBackend(crypto),
    )).resolves.toEqual({ ok: true, checkCount: 8 });
    await expect(verifyInventoryLineageAuthenticationTranscript(
      verification,
      {
        hashString: async () => "0".repeat(64),
        verify: async () => true,
      },
    )).resolves.toEqual({
      ok: false,
      reason: "digest_mismatch",
      checkIndex: 0,
    });
    await expect(verifyInventoryLineageAuthenticationTranscript(
      {
        ...verification,
        authentication_checks: verification.authentication_checks.slice(1),
      },
      createStandardWebCryptoBackend(crypto),
    )).resolves.toEqual({
      ok: false,
      reason: "invalid_transcript",
      checkIndex: 0,
    });
  });
});
