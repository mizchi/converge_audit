/**
 * Single-authority finalization.
 *
 * One designated replica closes ticks by signing the closure payload. Every
 * replica verifies the signature before admitting the closure. Liveness
 * depends on the authority; safety (closure uniqueness) depends on the
 * authority never signing two certificates for one tick, which this MVP does
 * not police beyond the local `ConflictingClosure` check.
 */
import { hashValue, type Hasher } from "../core/hash.ts";
import type { CommandId, Envelope, Hash, Tick } from "../core/ids.ts";
import { sortCommands, type CommandOrder } from "../core/order.ts";
import type { ClosureCertificate } from "../prdt/closure.ts";
import { closureMessage, type Finalizer, type Signer, type Verifier } from "./finalizer.ts";

export function createSingleAuthorityFinalizer<C>(verifier: Verifier): Finalizer<C> {
  return {
    verify(certificate) {
      return verifier.verify(closureMessage(certificate), certificate.certificate);
    },
  };
}

export interface ClosureAuthority<C> {
  /** Produce the certificate that fixes `commands` as the complete set for `tick`. */
  close(tick: Tick, parentDecisionHash: Hash, commands: readonly Envelope<C>[]): ClosureCertificate;
}

export function hashCommandIds(hasher: Hasher, ids: readonly CommandId[]): Hash {
  return hashValue(hasher, ids);
}

export function createSingleAuthority<C>(options: {
  readonly signer: Signer;
  readonly order: CommandOrder<C>;
  readonly hasher: Hasher;
}): ClosureAuthority<C> {
  return {
    close(tick, parentDecisionHash, commands) {
      for (const envelope of commands) {
        if (envelope.tick !== tick) {
          throw new RangeError(`command ${envelope.id} is for tick ${envelope.tick}, closing tick ${tick}`);
        }
      }
      const orderedCommandIds = sortCommands(commands, options.order).map((e) => e.id);
      const orderedCommandsHash = hashCommandIds(options.hasher, orderedCommandIds);
      const payload = { tick, parentDecisionHash, orderedCommandsHash };
      return {
        ...payload,
        orderedCommandIds,
        certificate: options.signer.sign(closureMessage(payload)),
      };
    },
  };
}
