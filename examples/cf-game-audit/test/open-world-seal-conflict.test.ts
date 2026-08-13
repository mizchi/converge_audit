import { describe, expect, it, vi } from "vitest";
import { audit_benchmark_make_open_world_missing_slot_conflict_bundle } from "../../../_build/js/release/build/x/game_audit/worker_fixture/worker_fixture.js";
import { createStandardWebCryptoBackend } from "../../player-local-runtime/crypto-backend";
import {
  persistOpenWorldMissingSlotConflictIfVerified,
  type OpenWorldMissingSlotConflictInput,
} from "../src/open-world-seal-conflict";

const AUTHORITY_SEED =
  "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f";
const PARTICIPANT_SEED =
  "202122232425262728292a2b2c2d2e2f303132333435363738393a3b3c3d3e3f";

interface MissingSlotFixture {
  ok: true;
  bundle_hex: string;
  world_id: string;
  authority_key: string;
  transparency_log_session_id: string;
  transparency_publisher_key: string;
  transparency_checkpoint_digest: string;
  audit_checkpoint_digest: string;
  seal_checkpoint_digest: string;
  checkpoint_digest: string;
}

function fixture(
  evidenceSource: OpenWorldMissingSlotConflictInput["evidenceSource"],
): MissingSlotFixture {
  return JSON.parse(
    audit_benchmark_make_open_world_missing_slot_conflict_bundle(
      AUTHORITY_SEED,
      PARTICIPANT_SEED,
      "world:missing-slot",
      "world:missing-slot:encounter-0",
      evidenceSource,
    ),
  ) as MissingSlotFixture;
}

function input(
  evidenceSource: OpenWorldMissingSlotConflictInput["evidenceSource"],
): OpenWorldMissingSlotConflictInput {
  const value = fixture(evidenceSource);
  return {
    bundleHex: value.bundle_hex,
    expectedWorldId: value.world_id,
    expectedAuthorityKey: value.authority_key,
    expectedTransparencyLogSessionId: value.transparency_log_session_id,
    expectedTransparencyPublisherKey: value.transparency_publisher_key,
    expectedTransparencyCheckpointDigest:
      value.transparency_checkpoint_digest,
    expectedAuditCheckpointDigest: value.audit_checkpoint_digest,
    expectedSealCheckpointDigest: value.seal_checkpoint_digest,
    expectedEncounterCheckpointDigest: value.checkpoint_digest,
    expectedRegistrationIndex: 0,
    evidenceSource,
  };
}

describe("open-world seal-conflict pre-mutation gate", () => {
  it.each(["authority_signed_encounter", "observer_quorum"] as const)(
    "persists only after MoonBit and standard crypto accept %s",
    async (evidenceSource) => {
      const persist = vi.fn(async (conflict) => conflict.encounter_digest);
      const result = await persistOpenWorldMissingSlotConflictIfVerified(
        input(evidenceSource),
        createStandardWebCryptoBackend(crypto),
        persist,
      );
      expect(result.ok).toBe(true);
      expect(persist).toHaveBeenCalledOnce();
      expect(persist.mock.calls[0][0]).toMatchObject({
        decision: "persist_conflict",
        kind: "missing_slot",
        source: evidenceSource,
        registration_index: 0,
      });
    },
  );

  it("does not mutate after an independent standard-crypto failure", async () => {
    const persist = vi.fn();
    await expect(persistOpenWorldMissingSlotConflictIfVerified(
      input("authority_signed_encounter"),
      { hashString: async () => "0".repeat(64) },
      persist,
    )).resolves.toEqual({
      ok: false,
      error: "standard_crypto_root_mismatch",
    });
    expect(persist).not.toHaveBeenCalled();
  });

  it("does not mutate when the externally anchored encounter is changed", async () => {
    const value = input("observer_quorum");
    const persist = vi.fn();
    await expect(persistOpenWorldMissingSlotConflictIfVerified(
      {
        ...value,
        expectedEncounterCheckpointDigest:
          `00${value.expectedEncounterCheckpointDigest.slice(2)}`,
      },
      createStandardWebCryptoBackend(crypto),
      persist,
    )).resolves.toEqual({
      ok: false,
      error: "expected_encounter_checkpoint_mismatch",
    });
    expect(persist).not.toHaveBeenCalled();
  });
});
