import { describe, expect, it } from "vitest";
import {
  audit_browser_ed25519_public_key,
  audit_browser_ed25519_sign,
  audit_browser_ed25519_verify,
  audit_browser_merkle_empty_payload,
  audit_browser_merkle_leaf_payload,
  audit_browser_merkle_node_payload,
  audit_browser_merkle_root_payload,
  audit_browser_merkle_root,
  audit_browser_sha256,
} from "../../../_build/js/release/build/x/game_audit/browser_bridge/browser_bridge.js";
import { createStandardWebCryptoBackend } from "../../player-local-runtime/crypto-backend";
import { createAsyncAuditDigestAdapter } from "../../player-local-runtime/merkle-digest";
import {
  deviceKeyFromSeedHex,
  generateDeviceKey,
} from "../web/src/audit/device-key";

describe("MoonBit browser audit bridge", () => {
  it("keeps WebCrypto Merkle roots identical to MoonBit framing", async () => {
    const standard = createStandardWebCryptoBackend(crypto);
    const asyncDigest = createAsyncAuditDigestAdapter(standard, {
      leaf: audit_browser_merkle_leaf_payload,
      node: audit_browser_merkle_node_payload,
      empty: audit_browser_merkle_empty_payload,
      root: audit_browser_merkle_root_payload,
    });
    const fixtures: string[][] = [
      [],
      ["only"],
      ["a", "b", "c"],
      ["ascii", "é", "👾", "four"],
      ...[2, 4, 5, 7, 8, 15, 16, 30, 31, 32, 33].map((length) =>
        Array.from({ length }, (_, index) => `leaf-${length}-${index}`)
      ),
    ];

    for (const payloads of fixtures) {
      await expect(asyncDigest.merkleRoot(payloads)).resolves.toBe(
        audit_browser_merkle_root(payloads),
      );
    }
  });

  it("exposes SHA-256 and the generic Merkle implementation to JavaScript", () => {
    expect(audit_browser_sha256("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223" +
        "b00361a396177a9cb410ff61f20015ad",
    );
    const root = audit_browser_merkle_root(["a", "b", "c"]);
    expect(root).toMatch(/^[0-9a-f]{64}$/);
    expect(audit_browser_merkle_root(["b", "a", "c"])).not.toBe(root);
  });

  it("creates a deterministic owner signer at the MoonBit crypto boundary", () => {
    const seed =
      "000102030405060708090a0b0c0d0e0f" +
      "101112131415161718191a1b1c1d1e1f";
    const signer = deviceKeyFromSeedHex(seed);
    const signature = signer.signDigest("checkpoint-digest");

    expect(Object.keys(signer).sort()).toEqual(["publicKey", "signDigest"]);
    expect(JSON.stringify(signer)).not.toContain(seed);
    expect(signer.publicKey).toBe(audit_browser_ed25519_public_key(seed));
    expect(signature).toBe(audit_browser_ed25519_sign(seed, "checkpoint-digest"));
    expect(audit_browser_ed25519_verify(
      signer.publicKey,
      "checkpoint-digest",
      signature,
    )).toBe(true);
  });

  it("generates exactly 32 random seed bytes", () => {
    const signer = generateDeviceKey((bytes) => {
      expect(bytes).toHaveLength(32);
      bytes.fill(0x5a);
      return bytes;
    });

    expect(Object.keys(signer).sort()).toEqual(["publicKey", "signDigest"]);
    expect(signer.publicKey).toMatch(/^[0-9a-f]{64}$/);
  });
});
