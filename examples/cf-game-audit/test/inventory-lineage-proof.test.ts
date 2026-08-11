import { describe, expect, it } from "vitest";
import { audit_browser_sha256 } from "../../../_build/js/release/build/x/game_audit/browser_bridge/browser_bridge.js";
import { createStandardWebCryptoBackend } from "../../player-local-runtime/crypto-backend";
import {
  inventoryLineageProofDigest,
  inventoryLineageProofDigestAsync,
} from "../src/inventory-lineage-proof";

const identity = {
  unit: "open-world-1",
  assetId: "asset-1",
  lineageBundleHex: "0123456789abcdef",
};

describe("inventory lineage proof identity", () => {
  it("derives the same proof digest with MoonBit and WebCrypto", async () => {
    const moonBit = inventoryLineageProofDigest(identity, {
      hashString: audit_browser_sha256,
    });
    const standard = createStandardWebCryptoBackend(crypto);

    await expect(inventoryLineageProofDigestAsync(
      identity,
      standard,
    )).resolves.toBe(moonBit);
  });

  it("exposes an incompatible asynchronous backend", async () => {
    const moonBit = inventoryLineageProofDigest(identity, {
      hashString: audit_browser_sha256,
    });

    await expect(inventoryLineageProofDigestAsync(identity, {
      hashString: async () => "0".repeat(64),
    })).resolves.not.toBe(moonBit);
  });
});
