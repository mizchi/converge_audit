import {
  audit_browser_ed25519_verify,
  audit_browser_merkle_empty_payload,
  audit_browser_merkle_leaf_payload,
  audit_browser_merkle_node_payload,
  audit_browser_merkle_root,
  audit_browser_merkle_root_payload,
  audit_browser_sha256,
} from "../../../_build/js/release/build/x/game_audit/browser_bridge/browser_bridge.js";
import type { AuditDigestAdapter } from "../game/audit/journal";
import type { GameOwnerSignatureVerifier } from "../game/authority/owner-authentication";
import type { LineageDecisionVerifierRegistry } from "./lineage-decision-certificate";
import type { AuditMerkleFraming } from "../../player-local-runtime/merkle-digest";

export const referenceGameDigest: AuditDigestAdapter = Object.freeze({
  hashString: audit_browser_sha256,
  merkleRoot: audit_browser_merkle_root,
});

export const referenceGameOwnerVerifier: GameOwnerSignatureVerifier =
  Object.freeze({ verify: audit_browser_ed25519_verify });

export const referenceGameMerkleFraming: AuditMerkleFraming = Object.freeze({
  leaf: audit_browser_merkle_leaf_payload,
  node: audit_browser_merkle_node_payload,
  empty: audit_browser_merkle_empty_payload,
  root: audit_browser_merkle_root_payload,
});

export const referenceGameLineageDecisionVerifiers:
  LineageDecisionVerifierRegistry = Object.freeze({
    "moonbit-ed25519-v1": referenceGameOwnerVerifier,
    "ed25519-v1": referenceGameOwnerVerifier,
  });
