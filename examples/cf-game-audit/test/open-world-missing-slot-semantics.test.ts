import { describe, expect, it } from "vitest";
import { audit_benchmark_make_open_world_missing_slot_proof } from "../../../_build/js/release/build/x/game_audit/worker/worker.js";
import { createStandardWebCryptoBackend } from "../../player-local-runtime/crypto-backend";
import type { DependentDigestVerificationCheck } from "../../player-local-runtime/dependent-digest-verification-plan";
import {
  type OpenWorldMissingSlotTranscript,
  verifyOpenWorldMissingSlotSemantics,
} from "../src/open-world-missing-slot-semantics";
import {
  openWorldEncounterRegistrationKey,
  verifyOpenWorldMissingSlotProof,
} from "../src/moonbit";

interface OpenWorldMissingSlotFixture {
  ok: true;
  expected_root: string;
  registered_count: number;
  registration_index: number;
  proof_entry_count: number;
  directions: Array<"left" | "right">;
  parent_keys: string[];
  parent_values: string[];
  sibling_digests: string[];
}

function fixture(
  registeredCount = 8,
  registrationIndex = 3,
): OpenWorldMissingSlotFixture {
  return JSON.parse(audit_benchmark_make_open_world_missing_slot_proof(
    registeredCount,
    registrationIndex,
  )) as OpenWorldMissingSlotFixture;
}

async function openedFixture(
  input = fixture(),
): Promise<OpenWorldMissingSlotTranscript> {
  const opened = await verifyOpenWorldMissingSlotProof({
    expectedRegistryRoot: input.expected_root,
    registeredCount: input.registered_count,
    registrationIndex: input.registration_index,
    proofEntryCount: input.proof_entry_count,
    directions: input.directions,
    parentKeys: input.parent_keys,
    parentValues: input.parent_values,
    siblingDigests: input.sibling_digests,
  });
  if (!opened.ok) throw new Error(opened.error);
  return opened;
}

function appendReferenceField(value: string): string {
  return `${value.length}:${value}`;
}

function referenceTaggedPreimage(tag: string, fields: string[]): string {
  return [tag, ...fields].map(appendReferenceField).join("");
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

async function expectReferencePlan(
  transcript: OpenWorldMissingSlotTranscript,
): Promise<void> {
  const backend = createStandardWebCryptoBackend(crypto);
  const computed: string[] = [];
  let checkIndex = 0;
  const empty = transcript.hash_checks[checkIndex++];
  const emptyStatement = referenceTaggedPreimage("authmap-empty-v1", []);
  expect(materializeReferenceCheck(empty, computed)).toBe(emptyStatement);
  computed.push(await backend.hashString(emptyStatement));

  for (let pathIndex = transcript.path.length - 1; pathIndex >= 0; pathIndex--) {
    const step = transcript.path[pathIndex];
    const parent = transcript.hash_checks[checkIndex++];
    const childDigest = computed[parent.dependency_check_indices[0]];
    const statement = referenceTaggedPreimage("authmap-node-v1", [
      step.parent_key,
      step.parent_value,
      ...(step.direction === "left"
        ? [childDigest, step.sibling_digest]
        : [step.sibling_digest, childDigest]),
    ]);
    expect(materializeReferenceCheck(parent, computed)).toBe(statement);
    computed.push(await backend.hashString(statement));
  }

  const root = transcript.hash_checks[checkIndex++];
  const nodeDigest = computed[root.dependency_check_indices[0]];
  const rootStatement = referenceTaggedPreimage("authmap-root-v1", [
    transcript.proof_entry_count.toString(),
    nodeDigest,
  ]);
  expect(materializeReferenceCheck(root, computed)).toBe(rootStatement);
  computed.push(await backend.hashString(rootStatement));
  expect(checkIndex).toBe(transcript.hash_check_count);
  expect(computed[transcript.root_check_index]).toBe(transcript.expected_root);
}

describe("open-world missing-slot semantics", () => {
  it("opens a MoonBit-validated absence proof and recomputes its signed root", async () => {
    const transcript = await openedFixture();
    const expectedKey = await openWorldEncounterRegistrationKey(
      transcript.registration_index,
    );
    expect(transcript.proof_key).toBe(expectedKey);
    await expectReferencePlan(transcript);
    await expect(verifyOpenWorldMissingSlotSemantics(
      transcript,
      createStandardWebCryptoBackend(crypto),
      transcript.expected_root,
      transcript.registered_count,
      transcript.registration_index,
      expectedKey,
    )).resolves.toEqual({ ok: true, checkCount: transcript.hash_check_count });
  });

  it("supports an entirely omitted one-slot registry as an empty-to-root plan", async () => {
    const transcript = await openedFixture(fixture(1, 0));
    expect(transcript.path).toEqual([]);
    expect(transcript.hash_check_count).toBe(2);
    await expectReferencePlan(transcript);
  });

  it("rejects boundary, path, dependency, and digest substitution", async () => {
    const transcript = await openedFixture();
    const expectedKey = await openWorldEncounterRegistrationKey(
      transcript.registration_index,
    );
    const standard = createStandardWebCryptoBackend(crypto);
    const verify = (candidate: OpenWorldMissingSlotTranscript) =>
      verifyOpenWorldMissingSlotSemantics(
        candidate,
        standard,
        transcript.expected_root,
        transcript.registered_count,
        transcript.registration_index,
        expectedKey,
      );
    await expect(verify({
      ...transcript,
      registration_index: transcript.registration_index + 1,
    })).resolves.toEqual({ ok: false, reason: "boundary_mismatch" });
    await expect(verify({
      ...transcript,
      path: transcript.path.map((step, index) =>
        index === 0
          ? {
            ...step,
            direction: step.direction === "left" ? "right" : "left",
          }
          : step
      ),
    })).resolves.toEqual({ ok: false, reason: "path_mismatch" });
    const rootIndex = transcript.root_check_index;
    await expect(verify({
      ...transcript,
      hash_checks: transcript.hash_checks.map((check, index) =>
        index === rootIndex
          ? { ...check, dependency_check_indices: [rootIndex] }
          : check
      ),
    })).resolves.toEqual({ ok: false, reason: "invalid_transcript" });
    await expect(verifyOpenWorldMissingSlotSemantics(
      transcript,
      { hashString: async () => "0".repeat(64) },
      transcript.expected_root,
      transcript.registered_count,
      transcript.registration_index,
      expectedKey,
    )).resolves.toEqual({ ok: false, reason: "root_mismatch" });
  });

  it("refuses invalid proof inputs before emitting a host plan", async () => {
    const input = fixture();
    await expect(verifyOpenWorldMissingSlotProof({
      expectedRegistryRoot: "0".repeat(64),
      registeredCount: input.registered_count,
      registrationIndex: input.registration_index,
      proofEntryCount: input.proof_entry_count,
      directions: input.directions,
      parentKeys: input.parent_keys,
      parentValues: input.parent_values,
      siblingDigests: input.sibling_digests,
    })).resolves.toEqual({ ok: false, error: "invalid_non_membership_proof" });
    await expect(verifyOpenWorldMissingSlotProof({
      expectedRegistryRoot: input.expected_root,
      registeredCount: input.registered_count,
      registrationIndex: input.registration_index,
      proofEntryCount: input.proof_entry_count,
      directions: input.directions.slice(1),
      parentKeys: input.parent_keys,
      parentValues: input.parent_values,
      siblingDigests: input.sibling_digests,
    })).resolves.toEqual({ ok: false, error: "invalid_non_membership_shape" });
    await expect(openWorldEncounterRegistrationKey(2 ** 32 + 3)).resolves.toBe("");
    await expect(verifyOpenWorldMissingSlotProof({
      expectedRegistryRoot: input.expected_root,
      registeredCount: 2 ** 32 + 8,
      registrationIndex: input.registration_index,
      proofEntryCount: input.proof_entry_count,
      directions: input.directions,
      parentKeys: input.parent_keys,
      parentValues: input.parent_values,
      siblingDigests: input.sibling_digests,
    })).resolves.toEqual({ ok: false, error: "invalid_non_membership_shape" });
  });
});
