import type { AuditCryptoBackend } from "./crypto-backend";

/** MoonBit-owned canonical preimages consumed by a platform hash backend. */
export interface AuditMerkleFraming {
  leaf(payload: string): string;
  node(left: string, right: string): string;
  empty(): string;
  root(leafCount: number, contentRoot: string): string;
}

export interface AsyncAuditDigestAdapter {
  hashString(value: string): Promise<string>;
  merkleRoot(payloads: string[]): Promise<string>;
}

/**
 * Build the converge Merkle tree with parallel hashes at each tree level.
 * Framing remains injected so this adapter cannot silently redefine the wire.
 */
export function createAsyncAuditDigestAdapter(
  backend: Pick<AuditCryptoBackend, "hashString">,
  framing: AuditMerkleFraming,
): AsyncAuditDigestAdapter {
  return Object.freeze({
    hashString: (value: string) => backend.hashString(value),
    async merkleRoot(payloads: string[]): Promise<string> {
      let current = await Promise.all(
        payloads.map((payload) => backend.hashString(framing.leaf(payload))),
      );
      if (current.length === 0) {
        current = [await backend.hashString(framing.empty())];
      } else {
        while (current.length > 1) {
          const next: Promise<string>[] = [];
          for (let index = 0; index < current.length; index += 2) {
            const left = current[index];
            const right = current[index + 1] ?? left;
            next.push(backend.hashString(framing.node(left, right)));
          }
          current = await Promise.all(next);
        }
      }
      return backend.hashString(framing.root(payloads.length, current[0]));
    },
  });
}
