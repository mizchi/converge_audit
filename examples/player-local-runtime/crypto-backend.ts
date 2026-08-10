/**
 * Host-side asynchronous crypto contract. The MoonBit core keeps synchronous
 * pure traits; browser and Worker WebCrypto adapters live at this I/O boundary.
 */
export type AuditCryptoAssurance = "experimental" | "standard-webcrypto";

export interface AuditCryptoBackendDescriptor {
  readonly id: string;
  readonly assurance: AuditCryptoAssurance;
  readonly hashScheme: "sha256-v1";
  readonly signatureScheme: "ed25519-v1";
}

export interface AuditCryptoBackend {
  readonly descriptor: AuditCryptoBackendDescriptor;
  hashString(value: string): Promise<string>;
  verify(
    publicKey: string,
    message: string,
    signature: string,
  ): Promise<boolean>;
}

export interface AsyncAuditSigner {
  readonly scheme: "ed25519-v1";
  readonly publicKey: string;
  signDigest(digest: string): Promise<string>;
}

export const STANDARD_WEBCRYPTO_BACKEND_ID =
  "standard-webcrypto-sha256-ed25519-v1";
export const EXPERIMENTAL_MOONBIT_BACKEND_ID =
  "experimental-moonbit-sha256-ed25519-v1";

export type CryptoRuntimeProfile = "development" | "test" | "production";

export type CryptoRuntimeAdmission =
  | { ok: true }
  | {
    ok: false;
    reason: "production_backend_required" | "backend_not_allowlisted";
  };

/** Fail-closed deployment gate; backend identifiers are pinned in source. */
export function cryptoRuntimeAdmission(
  profile: CryptoRuntimeProfile,
  descriptor: AuditCryptoBackendDescriptor,
): CryptoRuntimeAdmission {
  if (
    profile === "production" && descriptor.assurance !== "standard-webcrypto"
  ) {
    return { ok: false, reason: "production_backend_required" };
  }
  if (
    descriptor.id !== STANDARD_WEBCRYPTO_BACKEND_ID &&
    descriptor.id !== EXPERIMENTAL_MOONBIT_BACKEND_ID
  ) {
    return { ok: false, reason: "backend_not_allowlisted" };
  }
  return { ok: true };
}

/** Serializable only through structured clone/IndexedDB; never a wire DTO. */
export interface WebCryptoSigningKeyMaterial {
  readonly version: 1;
  readonly backendId: typeof STANDARD_WEBCRYPTO_BACKEND_ID;
  readonly scheme: "ed25519-v1";
  readonly publicKey: string;
  readonly privateKey: CryptoKey;
}

export interface GeneratedWebCryptoSigningKey {
  readonly material: WebCryptoSigningKeyMaterial;
  readonly signer: AsyncAuditSigner;
}

export interface StandardWebCryptoBackend extends AuditCryptoBackend {
  readonly descriptor: AuditCryptoBackendDescriptor & {
    readonly id: typeof STANDARD_WEBCRYPTO_BACKEND_ID;
    readonly assurance: "standard-webcrypto";
  };
  generateSigningKey(): Promise<GeneratedWebCryptoSigningKey>;
  importLegacySeed(
    seedHex: string,
    publicKey: string,
  ): Promise<GeneratedWebCryptoSigningKey>;
  restoreSigningKey(
    material: WebCryptoSigningKeyMaterial,
  ): Promise<AsyncAuditSigner>;
}

function bytesToLowerHex(bytes: ArrayBuffer): string {
  return Array.from(new Uint8Array(bytes), (value) =>
    value.toString(16).padStart(2, "0")
  ).join("");
}

function lowerHexToBytes(
  value: string,
  expectedBytes: number,
): Uint8Array<ArrayBuffer> | undefined {
  if (!new RegExp(`^[0-9a-f]{${expectedBytes * 2}}$`).test(value)) {
    return undefined;
  }
  const bytes = new Uint8Array(expectedBytes);
  for (let index = 0; index < expectedBytes; index += 1) {
    bytes[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}

function isPrivateEd25519SigningKey(value: unknown): value is CryptoKey {
  if (typeof value !== "object" || value === null) return false;
  const key = value as CryptoKey;
  return key.type === "private" &&
    key.extractable === false &&
    key.algorithm?.name === "Ed25519" &&
    key.usages.length === 1 &&
    key.usages[0] === "sign";
}

function signingMaterial(
  publicKey: string,
  privateKey: CryptoKey,
): WebCryptoSigningKeyMaterial {
  return Object.freeze({
    version: 1 as const,
    backendId: STANDARD_WEBCRYPTO_BACKEND_ID,
    scheme: "ed25519-v1" as const,
    publicKey,
    privateKey,
  });
}

/** Standard SHA-256/Ed25519 adapter shared by browsers and Cloudflare Workers. */
export function createStandardWebCryptoBackend(
  cryptoProvider: Pick<Crypto, "subtle">,
): StandardWebCryptoBackend {
  const descriptor = Object.freeze({
    id: STANDARD_WEBCRYPTO_BACKEND_ID,
    assurance: "standard-webcrypto" as const,
    hashScheme: "sha256-v1" as const,
    signatureScheme: "ed25519-v1" as const,
  });
  const encoder = new TextEncoder();

  async function hashString(value: string): Promise<string> {
    return bytesToLowerHex(
      await cryptoProvider.subtle.digest("SHA-256", encoder.encode(value)),
    );
  }

  async function verify(
    publicKey: string,
    message: string,
    signature: string,
  ): Promise<boolean> {
    const publicBytes = lowerHexToBytes(publicKey, 32);
    const signatureBytes = lowerHexToBytes(signature, 64);
    if (!publicBytes || !signatureBytes) return false;
    try {
      const key = await cryptoProvider.subtle.importKey(
        "raw",
        publicBytes,
        "Ed25519",
        false,
        ["verify"],
      );
      return await cryptoProvider.subtle.verify(
        "Ed25519",
        key,
        signatureBytes,
        encoder.encode(message),
      );
    } catch {
      return false;
    }
  }

  function signerFor(
    publicKey: string,
    privateKey: CryptoKey,
  ): AsyncAuditSigner {
    return Object.freeze({
      scheme: "ed25519-v1" as const,
      publicKey,
      async signDigest(digest: string): Promise<string> {
        return bytesToLowerHex(
          await cryptoProvider.subtle.sign(
            "Ed25519",
            privateKey,
            encoder.encode(digest),
          ),
        );
      },
    });
  }

  async function restoreSigningKey(
    material: WebCryptoSigningKeyMaterial,
  ): Promise<AsyncAuditSigner> {
    if (
      material?.version !== 1 ||
      material.backendId !== STANDARD_WEBCRYPTO_BACKEND_ID ||
      material.scheme !== "ed25519-v1" ||
      !lowerHexToBytes(material.publicKey, 32) ||
      !isPrivateEd25519SigningKey(material.privateKey)
    ) {
      throw new Error("invalid WebCrypto signing-key material");
    }
    const signer = signerFor(material.publicKey, material.privateKey);
    const challenge = "converge-audit-webcrypto-key-match-v1";
    if (!await verify(
      signer.publicKey,
      challenge,
      await signer.signDigest(challenge),
    )) {
      throw new Error("WebCrypto private/public key mismatch");
    }
    return signer;
  }

  async function generateSigningKey(): Promise<GeneratedWebCryptoSigningKey> {
    const pair = await cryptoProvider.subtle.generateKey(
      "Ed25519",
      false,
      ["sign", "verify"],
    ) as CryptoKeyPair;
    const publicKey = bytesToLowerHex(
      await cryptoProvider.subtle.exportKey("raw", pair.publicKey),
    );
    const material = signingMaterial(publicKey, pair.privateKey);
    return Object.freeze({
      material,
      signer: await restoreSigningKey(material),
    });
  }

  async function importLegacySeed(
    seedHex: string,
    publicKey: string,
  ): Promise<GeneratedWebCryptoSigningKey> {
    const seed = lowerHexToBytes(seedHex, 32);
    const publicBytes = lowerHexToBytes(publicKey, 32);
    if (!seed || !publicBytes) throw new Error("invalid legacy Ed25519 key");
    const privateKey = await cryptoProvider.subtle.importKey(
      "jwk",
      {
        kty: "OKP",
        crv: "Ed25519",
        x: bytesToBase64Url(publicBytes),
        d: bytesToBase64Url(seed),
        key_ops: ["sign"],
        ext: false,
      },
      "Ed25519",
      false,
      ["sign"],
    );
    const material = signingMaterial(publicKey, privateKey);
    return Object.freeze({
      material,
      signer: await restoreSigningKey(material),
    });
  }

  return Object.freeze({
    descriptor,
    hashString,
    verify,
    generateSigningKey,
    importLegacySeed,
    restoreSigningKey,
  });
}
