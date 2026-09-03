/**
 * Finalizer interface.
 *
 * A finalizer decides whether a closure certificate is authoritative. The
 * replicated domain never trusts a certificate it cannot verify, and the
 * same interface is implemented by the single-authority MVP and by the
 * quorum finalizer so they can be swapped without touching the domain or
 * finalization layers.
 */
import { bytesEqual, canonicalize, utf8Encode } from "../core/canonical.ts";
import { sha256 } from "../core/hash.ts";
import type { CommandId, Envelope, Hash, Tick } from "../core/ids.ts";
import type { ClosureCertificate } from "../prdt/closure.ts";

export interface Finalizer<C, Cert extends ClosureCertificate = ClosureCertificate> {
  verify(certificate: Cert, knownCommands: ReadonlyMap<CommandId, Envelope<C>>): boolean;
}

/** The part of a certificate that a signer commits to. */
export interface ClosurePayload {
  readonly tick: Tick;
  readonly parentDecisionHash: Hash;
  readonly orderedCommandsHash: Hash;
}

export const CLOSURE_MESSAGE_DOMAIN = "prdt/closure/v1";

export function closurePayload(certificate: ClosurePayload): ClosurePayload {
  return {
    tick: certificate.tick,
    parentDecisionHash: certificate.parentDecisionHash,
    orderedCommandsHash: certificate.orderedCommandsHash,
  };
}

/** Domain-separated canonical bytes that closure signatures cover. */
export function closureMessage(payload: ClosurePayload): Uint8Array {
  return utf8Encode(canonicalize({ domain: CLOSURE_MESSAGE_DOMAIN, ...closurePayload(payload) }));
}

export interface Signer {
  sign(message: Uint8Array): Uint8Array;
}

export interface Verifier {
  verify(message: Uint8Array, signature: Uint8Array): boolean;
}

/**
 * Test/dev keyed-hash authenticator. This is a shared-secret MAC, not a
 * signature: anyone who can verify can also forge. Substitute a real
 * signature scheme (for example Ed25519 through WebCrypto or the MoonBit
 * crypto adapter) for deployments.
 */
export function sharedSecretAuthenticator(secret: string): Signer & Verifier {
  const key = sha256(utf8Encode(`prdt/shared-secret/v1:${secret}`));
  const sign = (message: Uint8Array): Uint8Array => {
    const input = new Uint8Array(key.length + 1 + message.length);
    input.set(key, 0);
    input[key.length] = 0x00;
    input.set(message, key.length + 1);
    return sha256(input);
  };
  return {
    sign,
    verify: (message, signature) => bytesEqual(sign(message), signature),
  };
}

/** A verifier that never accepts; useful as a safe default. */
export const rejectAllVerifier: Verifier = { verify: () => false };
