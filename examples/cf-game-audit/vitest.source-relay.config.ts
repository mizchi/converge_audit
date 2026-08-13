import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

const arbiterPublicKey =
  "dde3bccec7f3a66a1115f45d720f4dc135c3ae7c4e22dca38fdb1efd6a495ff8";
const evidenceCaseId = "c".repeat(64);
const dismissalStatement = {
  version: 1,
  scope: "reference-game",
  unit: "dungeon-a",
  evidence_case_id: evidenceCaseId,
  reason_code: "challenge_not_reproduced",
  issued_at_ms: 1_000,
  expires_at_ms: 2_000,
};
const dismissalId =
  "646c8c7c3004b34bf5d8ef5196c6e46a1d88bfda53d4dbb883613cd2d5e95de8";
const dismissalCertificate = {
  statement: dismissalStatement,
  authentication: {
    scheme: "moonbit-ed25519-v1",
    arbiter_id: "external-arbiter-a",
    signature:
      "44cc18b7a51c18d10c151d74f6d04b052ab9a5a41543b3335be0de16e963b223" +
      "40976dcc7d5bccaf4031575ebfa311f03c421119c419419fd26b7d9ea448f90d",
  },
};
let pollCalls = 0;
let firstPublishedEnvelope = "";
let publishCalls = 0;

export default defineConfig({
  test: {
    include: ["test/evidence-resolution-relay-worker.test.ts"],
  },
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.source-relay.jsonc" },
      miniflare: {
        bindings: {
          RELAY_ADMIN_TOKEN: "test-relay-admin-token-000000",
          SOURCE_SIGNER_TOKEN: "test-signer-caller-token-000000",
          AUTHORITY_ORIGIN: "https://authority.test",
          EVIDENCE_SOURCE_ID: "evidence-source-a",
          EVIDENCE_SOURCE_SCHEME: "ed25519-v1",
          EVIDENCE_SOURCE_KEY_SCOPE_ID: "reference-game",
          EVIDENCE_UNIT: "dungeon-a",
          RELAY_SUCCESS_INTERVAL_MS: "1000",
          RELAY_BASE_BACKOFF_MS: "100",
          RELAY_MAX_BACKOFF_MS: "800",
          RELAY_LEASE_DURATION_MS: "100",
          RELAY_REQUEST_TIMEOUT_MS: "50",
          RELAY_RUNTIME_PROFILE: "test",
          LINEAGE_DECISION_MAX_CLOCK_SKEW_MS: "0",
          LINEAGE_ARBITER_ROSTER: JSON.stringify({
            "external-arbiter-a": {
              scheme: "moonbit-ed25519-v1",
              public_key: arbiterPublicKey,
            },
          }),
        },
        serviceBindings: {
          AUTHORITY: async (request) => {
            const url = new URL(request.url);
            if (url.pathname.endsWith("game-evidence-case-resolution-envelopes")) {
              publishCalls += 1;
              const encoded = await request.text();
              if (publishCalls === 1) {
                firstPublishedEnvelope = encoded;
                return new Response("unavailable", { status: 503 });
              }
              if (encoded !== firstPublishedEnvelope) {
                return Response.json({
                  ok: false,
                  error: "conflicting_retry",
                }, { status: 409 });
              }
              return Response.json({ ok: true, decision: "duplicate" });
            }
            pollCalls += 1;
            if (pollCalls === 1) {
              return new Response("unavailable", { status: 503 });
            }
            const body = await request.json() as Record<string, unknown>;
            const authentication = body.authentication as
              | Record<string, unknown>
              | undefined;
            if (
              body.version !== 2 ||
              body.audience !== "https://authority.test" ||
              body.unit !== "dungeon-a" ||
              body.source_id !== "evidence-source-a" ||
              authentication?.keyId !== "source-signing-key" ||
              authentication?.keyVersion !== 1 ||
              authentication?.scheme !== "ed25519-v1" ||
              typeof authentication.signature !== "string" ||
              typeof authentication.statementDigest !== "string"
            ) return new Response("unauthorized", { status: 401 });
            const notice: Record<string, unknown> = {
              version: 1,
              notice_sequence: 0,
              scope: "reference-game",
              unit: "dungeon-a",
              case_id: evidenceCaseId,
              source_id: "evidence-source-a",
              accepted_at_ms: 1_200,
              resolution: {
                boundary: {
                  protocol_version: 1,
                  purpose: "reference-game-checkpoint-v1",
                  manifest_digest: "manifest-1",
                  scope_id: "player-a",
                  unit_id: "run-a",
                },
                hold_id: "challenge-a",
                epoch: 0,
                checkpoint_digest: "b".repeat(64),
                reference_digest: "d".repeat(64),
                decision: "dismissed",
                resolution_digest: dismissalId,
              },
              authorization: {
                kind: "dismissal",
                certificate: dismissalCertificate,
              },
            };
            return Response.json({
              version: 1,
              source_id: body.source_id,
              after_sequence: body.after_sequence,
              after_resolution_id: body.after_resolution_id,
              source_cursor: {
                boundary: {
                  protocol_version: 1,
                  purpose: "reference-game-checkpoint-v1",
                  manifest_digest: "manifest-1",
                  scope_id: "player-a",
                  unit_id: "run-a",
                },
                source_id: body.source_id,
                sequence: 0,
                message_digest: "a".repeat(64),
              },
              notices: pollCalls >= 3 ? [notice] : [],
            });
          },
          SOURCE_SIGNER: async (request) => {
            const body = await request.json() as Record<string, unknown>;
            if (
              request.headers.get("authorization") !==
                "Bearer test-signer-caller-token-000000" ||
              request.headers.get("x-audit-signing-purpose") !==
                "evidence-case-resolution" ||
              new URL(request.url).pathname !== "/v1/key-bound-sign" ||
              body.subject_id !== "evidence-source-a" ||
              body.purpose !== "evidence-case-resolution" ||
              body.scope_id !== "reference-game" ||
              typeof body.unit_id !== "string" ||
              typeof body.statement_digest !== "string"
            ) return new Response("refused", { status: 403 });
            return Response.json({
              ok: true,
              authentication: {
                version: 1,
                purpose: body.purpose,
                scopeId: body.scope_id,
                unitId: body.unit_id,
                subjectId: body.subject_id,
                keyId: "source-signing-key",
                keyVersion: 1,
                scheme: "ed25519-v1",
                publicKey: "2".repeat(64),
                statementDigest: body.statement_digest,
                issuedAtMs: 1_000,
                signature: "1".repeat(128),
              },
            });
          },
        },
      },
    }),
  ],
});
