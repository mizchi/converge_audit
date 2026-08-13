import { describe, expect, it } from "vitest";
import { audit_benchmark_make_inventory_checkpoint_proof_bundle } from "../../../_build/js/release/build/x/game_audit/worker/worker.js";
import { createStandardWebCryptoBackend } from "../../player-local-runtime/crypto-backend";
import type { DependentDigestVerificationCheck } from "../../player-local-runtime/dependent-digest-verification-plan";
import {
  type InventoryMembershipProofTranscript,
  verifyInventoryMembershipSemantics,
} from "../src/inventory-membership-semantics";
import { verifyInventoryOriginSemantics } from "../src/inventory-origin-semantics";
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

function appendReferenceField(value: string): string {
  return `${value.length}:${value}`;
}

function referenceTaggedPreimage(tag: string, fields: string[]): string {
  return [tag, ...fields].map(appendReferenceField).join("");
}

function referenceCanonicalRecord(
  record: InventoryMembershipProofTranscript["record"],
): string {
  return referenceTaggedPreimage("asset-record-v2", [
    record.asset_id,
    record.owner_id,
    record.item_type,
    record.quantity.toString(),
    record.origin_source_event,
    record.origin_output_index.toString(),
    record.origin_receipt_digest,
    record.version.toString(),
    record.last_event,
    record.lineage_root,
  ]);
}

function materializeReferenceCheck(
  check: DependentDigestVerificationCheck,
  computedDigests: string[],
): string {
  let statement = check.statement_segments[0];
  check.dependency_check_indices.forEach((dependency, index) => {
    statement += computedDigests[dependency] + check.statement_segments[index + 1];
  });
  return statement;
}

async function expectReferenceMembershipPlan(
  membership: Awaited<ReturnType<typeof verifiedCheckpoint>>["inventory_membership"],
): Promise<void> {
  const backend = createStandardWebCryptoBackend(crypto);
  const computedDigests: string[] = [];
  let checkIndex = 0;
  for (const proof of membership.proofs) {
    expect(proof.canonical_record).toBe(referenceCanonicalRecord(proof.record));
    expect(proof.plan_check_start).toBe(checkIndex);
    expect(proof.plan_check_count).toBe(proof.path.length + 2);

    const leaf = membership.hash_checks[checkIndex++];
    const leafStatement = referenceTaggedPreimage("authmap-node-v1", [
      proof.key,
      proof.value,
      proof.left_digest,
      proof.right_digest,
    ]);
    expect(materializeReferenceCheck(leaf, computedDigests)).toBe(leafStatement);
    computedDigests.push(await backend.hashString(leafStatement));

    for (let pathIndex = proof.path.length - 1; pathIndex >= 0; pathIndex--) {
      const step = proof.path[pathIndex];
      const parent = membership.hash_checks[checkIndex++];
      const childDigest = computedDigests[parent.dependency_check_indices[0]];
      const parentStatement = referenceTaggedPreimage("authmap-node-v1", [
        step.parent_key,
        step.parent_value,
        ...(step.direction === "left"
          ? [childDigest, step.sibling_digest]
          : [step.sibling_digest, childDigest]),
      ]);
      expect(materializeReferenceCheck(parent, computedDigests)).toBe(
        parentStatement,
      );
      computedDigests.push(await backend.hashString(parentStatement));
    }

    const root = membership.hash_checks[checkIndex++];
    const nodeDigest = computedDigests[root.dependency_check_indices[0]];
    const rootStatement = referenceTaggedPreimage("authmap-root-v1", [
      proof.entry_count.toString(),
      nodeDigest,
    ]);
    expect(materializeReferenceCheck(root, computedDigests)).toBe(rootStatement);
    computedDigests.push(await backend.hashString(rootStatement));
    expect(proof.root_check_index).toBe(checkIndex - 1);
    expect(computedDigests[proof.root_check_index]).toBe(membership.expected_root);
  }
  expect(checkIndex).toBe(membership.hash_check_count);
}

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
    const origins = await verifyInventoryOriginSemantics(
      verification.inventory_origins,
      createStandardWebCryptoBackend(crypto),
      expectedOrigins,
    );
    if (!origins.ok) throw new Error(origins.reason);

    await expectReferenceMembershipPlan(verification.inventory_membership);

    await expect(verifyInventoryMembershipSemantics(
      verification.inventory_membership,
      createStandardWebCryptoBackend(crypto),
      verification.public_state_root,
      origins.origins,
    )).resolves.toEqual({ ok: true, proofCount: 2 });
  });

  it("rejects record and root mismatches", async () => {
    const verification = await verifiedCheckpoint();
    const membership = verification.inventory_membership;
    const standard = createStandardWebCryptoBackend(crypto);
    const origins = await verifyInventoryOriginSemantics(
      verification.inventory_origins,
      standard,
      expectedOrigins,
    );
    if (!origins.ok) throw new Error(origins.reason);

    await expect(verifyInventoryMembershipSemantics(
      {
        ...membership,
        proofs: membership.proofs.map((proof, index) =>
          index === 0
            ? { ...proof, value: "tampered-record" }
            : proof
        ),
      },
      standard,
      verification.public_state_root,
      origins.origins,
    )).resolves.toEqual({
      ok: false,
      reason: "record_mismatch",
      proofIndex: 0,
    });
    const firstRootCheck = membership.proofs[0].root_check_index;
    await expect(verifyInventoryMembershipSemantics(
      {
        ...membership,
        hash_checks: membership.hash_checks.map((check, index) =>
          index === firstRootCheck
            ? { ...check, dependency_check_indices: [firstRootCheck] }
            : check
        ),
      },
      standard,
      verification.public_state_root,
      origins.origins,
    )).resolves.toEqual({
      ok: false,
      reason: "invalid_transcript",
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
      origins.origins,
    )).resolves.toEqual({
      ok: false,
      reason: "root_mismatch",
      proofIndex: 0,
    });
  });
});
