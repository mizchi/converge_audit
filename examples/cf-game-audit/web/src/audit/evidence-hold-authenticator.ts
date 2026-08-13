import {
  audit_browser_ed25519_verify,
  audit_browser_sha256,
} from "../../../../../_build/js/release/build/x/game_audit/browser_bridge/browser_bridge.js";
import type {
  PlayerLocalEvidenceHoldAuthenticator,
} from "../../../../player-local-runtime/evidence-hold-wire.ts";
import {
  verifyKeyBoundStatement,
  type CompiledVerificationKeyHistory,
  type KeyBoundAuthentication,
} from "../../../../player-local-runtime/key-lifecycle.ts";

export interface EvidenceHoldAuthenticationMigration {
  keyHistory: CompiledVerificationKeyHistory;
  keyScopeId: string;
  nowMs: () => number;
  maxClockSkewMs: number;
  legacyAcceptUntilMs: number;
}

export interface MoonBitEd25519EvidenceHoldAuthentication {
  scheme: "moonbit-ed25519-v1";
  signature: string;
}

function isAuthentication(
  value: unknown,
): value is MoonBitEd25519EvidenceHoldAuthentication {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const authentication = value as Record<string, unknown>;
  return authentication.scheme === "moonbit-ed25519-v1" &&
    typeof authentication.signature === "string" &&
    /^[0-9a-f]{128}$/.test(authentication.signature);
}

/**
 * Reference crypto adapter. The wire/runtime depend only on the authenticator
 * interface, so production can replace this implementation without changing
 * hold storage or pruning.
 */
export function createMoonBitEd25519EvidenceHoldAuthenticator(
  sourcePublicKeys: Readonly<Record<string, string>>,
  migration?: EvidenceHoldAuthenticationMigration,
): PlayerLocalEvidenceHoldAuthenticator {
  const keys = new Map<string, string>();
  for (const [sourceId, publicKey] of Object.entries(sourcePublicKeys)) {
    if (sourceId.length === 0 || sourceId.length > 256) {
      throw new TypeError("invalid evidence hold source id");
    }
    if (!/^[0-9a-f]{64}$/.test(publicKey)) {
      throw new TypeError("invalid evidence hold source public key");
    }
    keys.set(sourceId, publicKey);
  }
  return Object.freeze({
    verify(
      input: Parameters<PlayerLocalEvidenceHoldAuthenticator["verify"]>[0],
    ): boolean {
      const publicKey = keys.get(input.source_id);
      const digest = audit_browser_sha256(input.canonical_statement);
      if (digest !== input.message_digest) return false;
      const authentication = input.authentication as
        | KeyBoundAuthentication
        | undefined;
      if (authentication?.version === 1) {
        if (!migration) return false;
        const boundary = operationBoundary(input.canonical_statement);
        if (!boundary) return false;
        return verifyKeyBoundStatement(authentication, {
          purpose: "evidence-case-resolution",
          scopeId: migration.keyScopeId,
          unitId: boundary.unitId,
          subjectId: input.source_id,
          statementDigest: digest,
          nowMs: migration.nowMs(),
          maxClockSkewMs: migration.maxClockSkewMs,
          history: migration.keyHistory,
          digest: { hashString: audit_browser_sha256 },
          verifiers: {
            "moonbit-ed25519-v1": {
              verify: audit_browser_ed25519_verify,
            },
            "ed25519-v1": {
              verify: audit_browser_ed25519_verify,
            },
          },
        }).ok;
      }
      if (
        migration && migration.nowMs() >= migration.legacyAcceptUntilMs
      ) return false;
      if (!publicKey || !isAuthentication(input.authentication)) return false;
      return audit_browser_ed25519_verify(
        publicKey,
        digest,
        input.authentication.signature,
      );
    },
  });
}

function operationBoundary(
  canonicalStatement: string,
): { unitId: string } | undefined {
  try {
    const fields: unknown = JSON.parse(canonicalStatement);
    if (
      !Array.isArray(fields) || fields.length < 12 ||
      fields[0] !== "converge-player-local-evidence-hold-envelope-v1" ||
      typeof fields[11] !== "string" || fields[11].length === 0 ||
      fields[11].length > 256
    ) return undefined;
    return { unitId: fields[11] };
  } catch {
    return undefined;
  }
}
