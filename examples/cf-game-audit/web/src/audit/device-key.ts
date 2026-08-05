import {
  audit_browser_ed25519_public_key,
  audit_browser_ed25519_sign,
} from "../../../../../_build/js/release/build/x/game_audit/browser_bridge/browser_bridge.js";
import type { GameOwnerSigner } from "../../../game/authority/owner-authentication";

export interface ReferenceGameDeviceKey extends GameOwnerSigner {
  seedHex: string;
}

export type RandomFill = (bytes: Uint8Array) => Uint8Array;

function bytesToLowerHex(bytes: Uint8Array): string {
  let output = "";
  for (const byte of bytes) output += byte.toString(16).padStart(2, "0");
  return output;
}

export function deviceKeyFromSeedHex(seedHex: string): ReferenceGameDeviceKey {
  if (!/^[0-9a-f]{64}$/.test(seedHex)) {
    throw new Error("device seed must be 32-byte lower hex");
  }
  const publicKey = audit_browser_ed25519_public_key(seedHex);
  if (!/^[0-9a-f]{64}$/.test(publicKey)) {
    throw new Error("MoonBit Ed25519 public-key derivation failed");
  }
  return Object.freeze({
    seedHex,
    publicKey,
    signDigest(digest: string): string {
      const signature = audit_browser_ed25519_sign(seedHex, digest);
      if (!/^[0-9a-f]{128}$/.test(signature)) {
        throw new Error("MoonBit Ed25519 signing failed");
      }
      return signature;
    },
  });
}

export function generateDeviceKey(
  fill: RandomFill = (bytes) => crypto.getRandomValues(bytes),
): ReferenceGameDeviceKey {
  const bytes = fill(new Uint8Array(32));
  if (bytes.length !== 32) throw new Error("device key entropy must be 32 bytes");
  return deviceKeyFromSeedHex(bytesToLowerHex(bytes));
}
