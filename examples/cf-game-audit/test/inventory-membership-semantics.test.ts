import { describe, expect, it } from "vitest";
import { audit_benchmark_make_inventory_checkpoint_proof_bundle } from "../../../_build/js/release/build/x/game_audit/worker/worker.js";
import { createStandardWebCryptoBackend } from "../../player-local-runtime/crypto-backend";
import { verifyInventoryMembershipSemantics } from "../src/inventory-membership-semantics";
import { verifyInventoryCheckpointProofBundle } from "../src/moonbit";

const authoritySeed =
  "000102030405060708090a0b0c0d0e0f" +
  "101112131415161718191a1b1c1d1e1f";
const participantSeed =
  "202122232425262728292a2b2c2d2e2f" +
  "303132333435363738393a3b3c3d3e3f";
const expectedOrigins = [
  {
    asset_id: "asset-000",
    recipient_id: "alice",
    item_type: "raid-token",
    quantity: 1,
    source_event: "loot-event-0",
    output_index: 0,
  },
  {
    asset_id: "asset-001",
    recipient_id: "alice",
    item_type: "raid-token",
    quantity: 2,
    source_event: "loot-event-1",
    output_index: 1,
  },
];

async function verifiedCheckpoint() {
  const fixture = JSON.parse(audit_benchmark_make_inventory_checkpoint_proof_bundle(
    authoritySeed,
    participantSeed,
    "inventory-session",
    "creation-checkpoint",
    1,
    ["asset-000", "asset-001"],
    [1, 2],
    ["loot-event-0", "loot-event-1"],
    [0, 1],
    ["alice", "alice"],
    ["bob", "bob"],
    "raid-token",
  )) as {
    ok: true;
    bundle_hex: string;
    authority_key: string;
    checkpoint_digest: string;
    game_manifest_digest: string;
  };
  const verification = await verifyInventoryCheckpointProofBundle(
    fixture.bundle_hex,
    "inventory-session",
    fixture.authority_key,
    fixture.checkpoint_digest,
    fixture.game_manifest_digest,
    [
      {
        asset_id: "asset-000",
        initial_owner_id: "alice",
        item_type: "raid-token",
        quantity: 1,
        source_event: "loot-event-0",
        output_index: 0,
        current_owner_id: "alice",
        current_version: 0,
        current_checkpoint_digest: "creation-checkpoint",
        current_epoch: 0,
        creation_eligible: true,
        lineage_clean: true,
      },
      {
        asset_id: "asset-001",
        initial_owner_id: "alice",
        item_type: "raid-token",
        quantity: 2,
        source_event: "loot-event-1",
        output_index: 1,
        current_owner_id: "alice",
        current_version: 0,
        current_checkpoint_digest: "creation-checkpoint",
        current_epoch: 0,
        creation_eligible: true,
        lineage_clean: true,
      },
    ],
  );
  if (!verification.ok) throw new Error(verification.error);
  return verification;
}

describe("inventory authenticated-map membership semantics", () => {
  it("recomputes every proof to the signed public state root", async () => {
    const verification = await verifiedCheckpoint();

    await expect(verifyInventoryMembershipSemantics(
      verification.inventory_membership,
      createStandardWebCryptoBackend(crypto),
      verification.public_state_root,
      expectedOrigins,
    )).resolves.toEqual({ ok: true, proofCount: 2 });
  });

  it("rejects record and root mismatches", async () => {
    const verification = await verifiedCheckpoint();
    const membership = verification.inventory_membership;
    const standard = createStandardWebCryptoBackend(crypto);

    await expect(verifyInventoryMembershipSemantics(
      {
        ...membership,
        proofs: membership.proofs.map((proof, index) =>
          index === 0
            ? { ...proof, record: { ...proof.record, owner_id: "mallory" } }
            : proof
        ),
      },
      standard,
      verification.public_state_root,
      expectedOrigins,
    )).resolves.toEqual({
      ok: false,
      reason: "record_mismatch",
      proofIndex: 0,
    });
    await expect(verifyInventoryMembershipSemantics(
      membership,
      {
        hashString: async (value) =>
          value.includes("authmap-")
            ? "0".repeat(64)
            : standard.hashString(value),
      },
      verification.public_state_root,
      expectedOrigins,
    )).resolves.toEqual({
      ok: false,
      reason: "root_mismatch",
      proofIndex: 0,
    });
    await expect(verifyInventoryMembershipSemantics(
      membership,
      standard,
      verification.public_state_root,
      expectedOrigins.map((origin, index) =>
        index === 0 ? { ...origin, quantity: 999 } : origin
      ),
    )).resolves.toEqual({
      ok: false,
      reason: "origin_mismatch",
      proofIndex: 0,
    });
  });
});
