import {
  audit_browser_merkle_root,
  audit_browser_sha256,
} from "../../../../../_build/js/release/build/x/game_audit/browser_bridge/browser_bridge.js";
import type { AuditDigestAdapter } from "../../../game/audit/journal";

export const moonBitAuditDigest: AuditDigestAdapter = Object.freeze({
  hashString: audit_browser_sha256,
  merkleRoot: audit_browser_merkle_root,
});
