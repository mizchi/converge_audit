import { describe, expect, it } from "vitest";
import { audit_benchmark_make_inventory_checkpoint_proof_bundle } from "../../../_build/js/release/build/x/game_audit/worker/worker.js";
import { createStandardWebCryptoBackend } from "../../player-local-runtime/crypto-backend";
import {
  type InventoryOriginReceipt,
  verifyInventoryOriginSemantics,
} from "../src/inventory-origin-semantics";
import { verifyInventoryCheckpointProofBundle } from "../src/moonbit";

const authoritySeed =
  "000102030405060708090a0b0c0d0e0f" +
  "101112131415161718191a1b1c1d1e1f";
const participantSeed =
  "202122232425262728292a2b2c2d2e2f" +
  "303132333435363738393a3b3c3d3e3f";
const expectedOrigins: InventoryOriginReceipt[] = [
  {
    asset_id: "asset-000",
    recipient_id: "alice-猫",
    item_type: "raid-token",
    quantity: 1,
    source_event: "loot-event-雪😀",
    output_index: 0,
  },
  {
    asset_id: "asset-001",
    recipient_id: "alice-猫",
    item_type: "raid-token",
    quantity: 2,
    source_event: "loot-event-1",
    output_index: 1,
  },
];

function appendField(value: string): string {
  return `${value.length}:${value}`;
}

/** Test-only implementation diversity; runtime framing stays in MoonBit. */
function referenceItemReceipt(receipt: InventoryOriginReceipt): string {
  return [
    "item-receipt-v1",
    receipt.asset_id,
    receipt.recipient_id,
    receipt.item_type,
    receipt.quantity.toString(),
    receipt.source_event,
    receipt.output_index.toString(),
  ].map(appendField).join("");
}

function referenceOriginReceipt(receipt: InventoryOriginReceipt): string {
  return ["inventory-origin-receipt-v1", referenceItemReceipt(receipt)]
    .map(appendField).join("");
}

function referenceOriginLineage(receiptDigest: string): string {
  return ["inventory-origin-lineage-v1", receiptDigest]
    .map(appendField).join("");
}

async function verifiedCheckpoint() {
  const fixture = JSON.parse(audit_benchmark_make_inventory_checkpoint_proof_bundle(
    authoritySeed,
    participantSeed,
    "inventory-session",
    "creation-checkpoint",
    1,
    expectedOrigins.map((origin) => origin.asset_id),
    expectedOrigins.map((origin) => origin.quantity),
    expectedOrigins.map((origin) => origin.source_event),
    expectedOrigins.map((origin) => origin.output_index),
    expectedOrigins.map((origin) => origin.recipient_id),
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
    expectedOrigins.map((origin) => ({
      asset_id: origin.asset_id,
      initial_owner_id: origin.recipient_id,
      item_type: origin.item_type,
      quantity: origin.quantity,
      source_event: origin.source_event,
      output_index: origin.output_index,
      current_owner_id: origin.recipient_id,
      current_version: 0,
      current_checkpoint_digest: "creation-checkpoint",
      current_epoch: 0,
      creation_eligible: true,
      lineage_clean: true,
    })),
  );
  if (!verification.ok) throw new Error(verification.error);
  return verification;
}

describe("inventory origin semantic plan", () => {
  it("matches the test-only reference and standard SHA-256", async () => {
    const verification = await verifiedCheckpoint();
    const transcript = verification.inventory_origins;

    for (let index = 0; index < expectedOrigins.length; index++) {
      const receiptCheck = transcript.hash_checks[index * 2];
      const lineageCheck = transcript.hash_checks[index * 2 + 1];
      expect(receiptCheck.canonical_statement).toBe(
        referenceOriginReceipt(expectedOrigins[index]),
      );
      expect(lineageCheck.canonical_statement).toBe(
        referenceOriginLineage(receiptCheck.expected_digest),
      );
    }
    const verified = await verifyInventoryOriginSemantics(
      transcript,
      createStandardWebCryptoBackend(crypto),
      expectedOrigins,
    );
    expect(verified.ok).toBe(true);
    if (verified.ok) expect(verified.origins).toHaveLength(2);
  });

  it("rejects plan, digest, and expected-origin mismatches", async () => {
    const verification = await verifiedCheckpoint();
    const transcript = verification.inventory_origins;
    const standard = createStandardWebCryptoBackend(crypto);

    await expect(verifyInventoryOriginSemantics(
      {
        ...transcript,
        hash_checks: transcript.hash_checks.map((check, index) =>
          index === 0
            ? { ...check, canonical_statement: `${check.canonical_statement}x` }
            : check
        ),
      },
      standard,
      expectedOrigins,
    )).resolves.toEqual({
      ok: false,
      reason: "commitment_mismatch",
      originIndex: 0,
    });
    await expect(verifyInventoryOriginSemantics(
      {
        ...transcript,
        hash_checks: transcript.hash_checks.map((check, index) =>
          index === 1 ? { ...check, kind: "wrong_kind" } : check
        ),
      },
      standard,
      expectedOrigins,
    )).resolves.toEqual({
      ok: false,
      reason: "invalid_transcript",
      originIndex: 0,
    });
    await expect(verifyInventoryOriginSemantics(
      transcript,
      standard,
      expectedOrigins.map((origin, index) =>
        index === 0 ? { ...origin, quantity: 999 } : origin
      ),
    )).resolves.toEqual({
      ok: false,
      reason: "origin_mismatch",
      originIndex: 0,
    });
  });
});
