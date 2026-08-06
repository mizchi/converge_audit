import {
  audit_browser_ed25519_verify,
  audit_browser_merkle_root,
  audit_browser_sha256,
} from "../../../_build/js/release/build/x/game_audit/browser_bridge/browser_bridge.js";
import type { AuditDigestAdapter } from "../game/audit/journal";
import type { GameOwnerSignatureVerifier } from "../game/authority/owner-authentication";
import type { LineageDecisionVerifierRegistry } from "./lineage-decision-certificate";

export const referenceGameDigest: AuditDigestAdapter = Object.freeze({
  hashString: audit_browser_sha256,
  merkleRoot: audit_browser_merkle_root,
});

export const referenceGameOwnerVerifier: GameOwnerSignatureVerifier =
  Object.freeze({ verify: audit_browser_ed25519_verify });

export const referenceGameLineageDecisionVerifiers:
  LineageDecisionVerifierRegistry = Object.freeze({
    "moonbit-ed25519-v1": referenceGameOwnerVerifier,
  });
