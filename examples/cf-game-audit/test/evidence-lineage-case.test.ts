import { describe, expect, it } from "vitest";
import {
  audit_browser_ed25519_public_key,
  audit_browser_ed25519_sign,
  audit_browser_sha256,
  audit_browser_ed25519_verify,
} from "../../../_build/js/release/build/x/game_audit/browser_bridge/browser_bridge.js";
import {
  evidenceLineageCaseHoldResolutionDraft,
  evidenceLineageCaseReferenceDigest,
  parseEvidenceLineageCaseSourceRoster,
  verifyEvidenceLineageCaseProposal,
  type EvidenceLineageCaseReference,
} from "../../player-local-runtime/evidence-lineage-case.ts";
import {
  playerLocalEvidenceHoldEnvelopeStatement,
  type PlayerLocalEvidenceHoldUnsignedEnvelope,
} from "../../player-local-runtime/evidence-hold-wire.ts";

const seed =
  "000102030405060708090a0b0c0d0e0f" +
  "101112131415161718191a1b1c1d1e1f";
const sourceId = "evidence-source-a";
const digest = { hashString: audit_browser_sha256 };
const verifier = {
  verify: (publicKey: string, value: string, signature: string) =>
    // The verifier is intentionally injected by scheme.
    audit_browser_ed25519_verify(publicKey, value, signature),
};

const boundary = {
  protocol_version: 1,
  purpose: "reference-game-checkpoint-v1",
  manifest_digest: "manifest-1",
  scope_id: "player-1",
  unit_id: "local-run-1",
};

function signedProposal(overrides: Partial<EvidenceLineageCaseReference> = {}) {
  const reference: EvidenceLineageCaseReference = {
    version: 1,
    scope: "reference-game",
    unit: "reference:player-1:seed:run",
    assetId: "asset-1",
    ancestorId: "a".repeat(64),
    ancestorKind: "origin",
    boundary,
    sourceId,
    holdId: "challenge-1",
    epoch: 0,
    checkpointDigest: "b".repeat(64),
    holdKind: "challenge",
    ...overrides,
  };
  const unsigned: PlayerLocalEvidenceHoldUnsignedEnvelope = {
    version: 1,
    source_id: sourceId,
    message_id: reference.holdId,
    sequence: 0,
    previous_message_digest: "inbox-genesis",
    operation: {
      kind: "place",
      hold: {
        boundary,
        hold_id: reference.holdId,
        epoch: reference.epoch,
        checkpoint_digest: reference.checkpointDigest,
        kind: reference.holdKind,
        reference_digest: evidenceLineageCaseReferenceDigest(reference, digest),
        state: { kind: "active" },
      },
    },
  };
  const messageDigest = audit_browser_sha256(
    playerLocalEvidenceHoldEnvelopeStatement(unsigned),
  );
  return {
    version: 1,
    scope: reference.scope,
    unit: reference.unit,
    asset_id: reference.assetId,
    ancestor_id: reference.ancestorId,
    ancestor_kind: reference.ancestorKind,
    boundary,
    source_id: sourceId,
    hold_envelope: {
      ...unsigned,
      message_digest: messageDigest,
      authentication: {
        scheme: "moonbit-ed25519-v1",
        signature: audit_browser_ed25519_sign(seed, messageDigest),
      },
    },
  };
}

describe("evidence lineage case certificate", () => {
  it("derives a local hold resolution draft without source authentication", () => {
    const proposal = signedProposal();
    const operation = proposal.hold_envelope.operation;
    if (operation.kind !== "place") throw new Error("expected place operation");
    const reference: EvidenceLineageCaseReference = {
      version: 1,
      scope: proposal.scope,
      unit: proposal.unit,
      assetId: proposal.asset_id,
      ancestorId: proposal.ancestor_id,
      ancestorKind: proposal.ancestor_kind,
      boundary,
      sourceId,
      holdId: operation.hold.hold_id,
      epoch: operation.hold.epoch,
      checkpointDigest: operation.hold.checkpoint_digest,
      holdKind: operation.hold.kind,
    };
    expect(evidenceLineageCaseHoldResolutionDraft(
      reference,
      evidenceLineageCaseReferenceDigest(reference, digest),
      "dismissed",
      "d".repeat(64),
    )).toEqual({
      boundary,
      hold_id: "challenge-1",
      epoch: 0,
      checkpoint_digest: "b".repeat(64),
      reference_digest: evidenceLineageCaseReferenceDigest(reference, digest),
      decision: "dismissed",
      resolution_digest: "d".repeat(64),
    });
  });

  it("admits an authenticated active hold bound to the exact lineage target", async () => {
    const roster = parseEvidenceLineageCaseSourceRoster(JSON.stringify({
      [sourceId]: {
        scheme: "moonbit-ed25519-v1",
        public_key: audit_browser_ed25519_public_key(seed),
      },
    }));
    expect(roster).toBeDefined();
    await expect(verifyEvidenceLineageCaseProposal(signedProposal(), {
      roster: roster!,
      verifiers: { "moonbit-ed25519-v1": verifier },
      digest,
    })).resolves.toMatchObject({
      ok: true,
      proposal: {
        target: { assetId: "asset-1", ancestorKind: "origin" },
      },
    });
  });

  it("rejects retargeting, unknown sources, and invalid signatures", async () => {
    const roster = parseEvidenceLineageCaseSourceRoster(JSON.stringify({
      [sourceId]: {
        scheme: "moonbit-ed25519-v1",
        public_key: audit_browser_ed25519_public_key(seed),
      },
    }))!;
    const options = {
      roster,
      verifiers: { "moonbit-ed25519-v1": verifier },
      digest,
    };
    await expect(verifyEvidenceLineageCaseProposal({
      ...signedProposal(),
      asset_id: "retargeted-asset",
    }, options)).resolves.toEqual({ ok: false, reason: "reference_mismatch" });
    await expect(verifyEvidenceLineageCaseProposal({
      ...signedProposal(),
      source_id: "unknown-source",
    }, options)).resolves.toEqual({ ok: false, reason: "invalid_proposal" });
    const forged = signedProposal();
    forged.hold_envelope.authentication.signature = "0".repeat(128);
    await expect(verifyEvidenceLineageCaseProposal(forged, options)).resolves
      .toEqual({ ok: false, reason: "invalid_signature" });
  });
});
