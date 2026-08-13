import { describe, expect, it } from "vitest";
import { audit_benchmark_make_inventory_lineage_proof_bundle } from "../../../_build/js/release/build/x/game_audit/worker_fixture/worker_fixture.js";
import { createStandardWebCryptoBackend } from "../../player-local-runtime/crypto-backend";
import {
  verifyInventoryLineageSemantics,
} from "../src/inventory-lineage-semantics";
import { verifyInventoryOriginSemantics } from "../src/inventory-origin-semantics";
import { verifyInventoryLineageProofBundle } from "../src/moonbit";

const authoritySeed =
  "000102030405060708090a0b0c0d0e0f" +
  "101112131415161718191a1b1c1d1e1f";
const participantSeed =
  "202122232425262728292a2b2c2d2e2f" +
  "303132333435363738393a3b3c3d3e3f";
const unicodeOrigin = {
  asset_id: "asset-雪😀",
  recipient_id: "alice-猫",
  item_type: "raid-token",
  quantity: 1,
  source_event: "loot-event",
  output_index: 0,
};

function appendReferenceField(value: string): string {
  return `${value.length}:${value}`;
}

function referenceCanonicalTransition(transition: {
  asset_id: string;
  origin_receipt_digest: string;
  from_owner: string;
  to_owner: string;
  expected_version: number;
  previous_event: string;
  source_event: string;
  previous_lineage_root: string;
}): string {
  return [
    "inventory-asset-lineage-transition-v1",
    transition.asset_id,
    transition.origin_receipt_digest,
    transition.from_owner,
    transition.to_owner,
    transition.expected_version.toString(),
    transition.previous_event,
    transition.source_event,
    transition.previous_lineage_root,
  ].map(appendReferenceField).join("");
}

async function verifiedUnicodeLineage() {
  const fixture = JSON.parse(audit_benchmark_make_inventory_lineage_proof_bundle(
    authoritySeed,
    participantSeed,
    "inventory-session-雪",
    "creation-checkpoint",
    1,
    "asset-雪😀",
    "alice-猫",
    "bob-犬",
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
    "inventory-session-雪",
    fixture.authority_key,
    fixture.checkpoint_digest,
    fixture.game_manifest_digest,
    "asset-雪😀",
    "alice-猫",
    "raid-token",
    1,
    "loot-event",
    0,
    "bob-犬",
    fixture.anchor_owner_id,
    fixture.anchor_version,
    fixture.anchor_last_event,
    fixture.anchor_lineage_root,
  );
  if (!verification.ok) throw new Error(verification.error);
  return verification;
}

describe("inventory lineage transition plan", () => {
  it("recomputes a Unicode lineage chain with standard SHA-256", async () => {
    const verification = await verifiedUnicodeLineage();
    const backend = createStandardWebCryptoBackend(crypto);
    const origins = await verifyInventoryOriginSemantics(
      verification.inventory_origins,
      backend,
      [unicodeOrigin],
    );
    if (!origins.ok) throw new Error(origins.reason);

    expect(verification.hash_check_count).toBe(2);
    expect(verification.hash_checks).toHaveLength(2);
    verification.transitions.forEach((transition, index) => {
      expect(verification.hash_checks[index]).toEqual({
        kind: "inventory_lineage_transition",
        check_index: index,
        canonical_statement: referenceCanonicalTransition(transition),
        expected_digest: transition.next_lineage_root,
      });
    });

    await expect(verifyInventoryLineageSemantics(
      verification,
      backend,
      origins.origins[0],
    )).resolves.toEqual({ ok: true, transitionCount: 2 });
  });

  it("rejects a broken chain and a mismatched hash backend", async () => {
    const verification = await verifiedUnicodeLineage();
    const standard = createStandardWebCryptoBackend(crypto);
    const origins = await verifyInventoryOriginSemantics(
      verification.inventory_origins,
      standard,
      [unicodeOrigin],
    );
    if (!origins.ok) throw new Error(origins.reason);
    const brokenChain = {
      ...verification,
      transitions: verification.transitions.map((transition, index) =>
        index === 1
          ? { ...transition, previous_event: "wrong-parent" }
          : transition
      ),
    };

    await expect(verifyInventoryLineageSemantics(
      brokenChain,
      standard,
      origins.origins[0],
    )).resolves.toEqual({
      ok: false,
      reason: "transition_mismatch",
      transitionIndex: 1,
    });
    await expect(verifyInventoryLineageSemantics(
      verification,
      {
        hashString: async (value) =>
          value.includes("inventory-asset-lineage-transition-v1")
            ? "0".repeat(64)
            : standard.hashString(value),
      },
      origins.origins[0],
    )).resolves.toEqual({
      ok: false,
      reason: "root_mismatch",
      transitionIndex: 0,
    });
    await expect(verifyInventoryLineageSemantics(
      {
        ...verification,
        hash_check_count: verification.hash_check_count + 1,
      },
      standard,
      origins.origins[0],
    )).resolves.toEqual({
      ok: false,
      reason: "invalid_transcript",
      transitionIndex: 0,
    });
    await expect(verifyInventoryLineageSemantics(
      {
        ...verification,
        hash_checks: verification.hash_checks.map((check, index) =>
          index === 0 ? { ...check, kind: "wrong_kind" } : check
        ),
      },
      standard,
      origins.origins[0],
    )).resolves.toEqual({
      ok: false,
      reason: "invalid_transcript",
      transitionIndex: 0,
    });
    await expect(verifyInventoryLineageSemantics(
      {
        ...verification,
        initial_origin_receipt_digest: "0".repeat(64),
      },
      standard,
      origins.origins[0],
    )).resolves.toEqual({
      ok: false,
      reason: "origin_mismatch",
      transitionIndex: 0,
    });
  });
});
