/**
 * Protocol errors are raised when an input can never be joined with the
 * current state: two payloads for one command id, two certificates for one
 * tick, two committed logs that are not prefixes of each other, a certificate
 * that fails verification, or a certificate whose chain does not match the
 * locally committed prefix. Merges that throw leave both inputs untouched.
 */
export type ProtocolErrorKind =
  | "ConflictingProposal"
  | "ConflictingClosure"
  | "PrefixConflict"
  | "InvalidCertificate"
  | "MalformedCertificate"
  | "ChainMismatch"
  | "OrderMismatch"
  | "TickMismatch";

export class ProtocolError extends Error {
  constructor(
    readonly kind: ProtocolErrorKind,
    message: string,
    readonly details: Readonly<Record<string, unknown>> = {},
  ) {
    super(`${kind}: ${message}`);
    this.name = "ProtocolError";
  }
}

export function isProtocolError(error: unknown, kind?: ProtocolErrorKind): error is ProtocolError {
  return error instanceof ProtocolError && (kind === undefined || error.kind === kind);
}
