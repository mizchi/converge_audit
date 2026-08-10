import { describe, expect, it } from "vitest";
import {
  audit_browser_ed25519_public_key,
  audit_browser_ed25519_sign,
  audit_browser_ed25519_verify,
  audit_browser_sha256,
} from "../../../_build/js/release/build/x/game_audit/browser_bridge/browser_bridge.js";
import {
  buildEvidenceCaseResolutionEnvelope,
  decodeEvidenceCaseResolutionPollPage,
  type EvidenceCaseResolutionNotice,
} from "../../player-local-runtime/evidence-case-resolution-relay.ts";
import { playerLocalEvidenceHoldEnvelopeStatement } from "../../player-local-runtime/evidence-hold-wire.ts";

const seed =
  "e0e1e2e3e4e5e6e7e8e9eaebecedeeef" +
  "f0f1f2f3f4f5f6f7f8f9fafbfcfdfeff";
const publicKey = audit_browser_ed25519_public_key(seed);
const boundary = {
  protocol_version: 1,
  purpose: "reference-game-checkpoint-v1",
  manifest_digest: "manifest-1",
  scope_id: "player-1",
  unit_id: "local-run-1",
};
const notice: EvidenceCaseResolutionNotice = {
  version: 1,
  noticeSequence: 0,
  scope: "reference-game",
  unit: "dungeon-1",
  caseId: "c".repeat(64),
  sourceId: "evidence-source-a",
  acceptedAtMs: 2_000_000,
  resolution: {
    boundary,
    hold_id: "challenge-1",
    epoch: 3,
    checkpoint_digest: "a".repeat(64),
    reference_digest: "b".repeat(64),
    decision: "dismissed",
    resolution_digest: "d".repeat(64),
  },
  authorization: { kind: "dismissal", certificate: "exact-certificate" },
};

function build(
  value: EvidenceCaseResolutionNotice = notice,
  authenticated = true,
) {
  return buildEvidenceCaseResolutionEnvelope(value, {
    cursor: {
      boundary,
      source_id: "evidence-source-a",
      sequence: 0,
      message_digest: "p".repeat(64),
    },
    authorizationVerifier: {
      verify: async (candidate) =>
        authenticated && candidate.authorization === value.authorization,
    },
    digest: { hashString: audit_browser_sha256 },
    signer: {
      scheme: "moonbit-ed25519-v1",
      sign: (digest) => audit_browser_ed25519_sign(seed, digest),
    },
  });
}

describe("evidence case resolution source relay", () => {
  it("decodes one bounded notice page at the exact resolution cursor", () => {
    expect(decodeEvidenceCaseResolutionPollPage({
      version: 1,
      source_id: notice.sourceId,
      after_sequence: -1,
      after_resolution_id: "resolution-genesis",
      source_cursor: {
        boundary,
        source_id: notice.sourceId,
        sequence: 0,
        message_digest: "p".repeat(64),
      },
      notices: [{
        version: 1,
        notice_sequence: 0,
        scope: notice.scope,
        unit: notice.unit,
        case_id: notice.caseId,
        source_id: notice.sourceId,
        accepted_at_ms: notice.acceptedAtMs,
        resolution: notice.resolution,
        authorization: notice.authorization,
      }],
    }, {
      sourceId: notice.sourceId,
      sequence: -1,
      resolutionId: "resolution-genesis",
    }, 1)).toEqual({
      ok: true,
      page: {
        sourceId: notice.sourceId,
        afterSequence: -1,
        afterResolutionId: "resolution-genesis",
        sourceCursor: {
          boundary,
          source_id: notice.sourceId,
          sequence: 0,
          message_digest: "p".repeat(64),
        },
        notices: [notice],
      },
    });
  });

  it("authenticates the arbiter notice before signing the next source envelope", async () => {
    const result = await build();
    expect(result).toMatchObject({
      ok: true,
      envelope: {
        source_id: notice.sourceId,
        message_id: notice.resolution.hold_id,
        sequence: 1,
        previous_message_digest: "p".repeat(64),
        operation: { kind: "resolve", resolution: notice.resolution },
        authentication: { scheme: "moonbit-ed25519-v1" },
      },
    });
    if (!result.ok) throw new Error(result.reason);
    expect(result.envelope.message_digest).toBe(audit_browser_sha256(
      playerLocalEvidenceHoldEnvelopeStatement(result.envelope),
    ));
    expect(audit_browser_ed25519_verify(
      publicKey,
      result.envelope.message_digest,
      result.envelope.authentication.signature,
    )).toBe(true);
    await expect(build()).resolves.toEqual(result);
  });

  it("refuses unauthenticated notices and a cursor owned by another source", async () => {
    await expect(build(notice, false)).resolves.toEqual({
      ok: false,
      reason: "authorization_rejected",
    });
    await expect(buildEvidenceCaseResolutionEnvelope(notice, {
      cursor: {
        boundary,
        source_id: "another-source",
        sequence: 0,
        message_digest: "p".repeat(64),
      },
      authorizationVerifier: { verify: () => true },
      digest: { hashString: audit_browser_sha256 },
      signer: {
        scheme: "moonbit-ed25519-v1",
        sign: (digest) => audit_browser_ed25519_sign(seed, digest),
      },
    })).resolves.toEqual({ ok: false, reason: "cursor_mismatch" });
  });
});
