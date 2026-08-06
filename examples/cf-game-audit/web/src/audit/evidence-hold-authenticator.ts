import {
  audit_browser_ed25519_verify,
  audit_browser_sha256,
} from "../../../../../_build/js/release/build/x/game_audit/browser_bridge/browser_bridge.js";
import type {
  PlayerLocalEvidenceHoldAuthenticator,
} from "../../../../player-local-runtime/evidence-hold-wire.ts";

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
      if (!publicKey || !isAuthentication(input.authentication)) return false;
      const digest = audit_browser_sha256(input.canonical_statement);
      if (digest !== input.message_digest) return false;
      return audit_browser_ed25519_verify(
        publicKey,
        digest,
        input.authentication.signature,
      );
    },
  });
}
