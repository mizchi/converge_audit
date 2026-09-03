import { sha256Hasher } from "../src/core/hash.ts";
import type { Envelope, Tick } from "../src/core/ids.ts";
import type { GameEvent, GameRejection } from "../src/examples/mmo/events.ts";
import type { GameCommand } from "../src/examples/mmo/commands.ts";
import { gameCommandOrder } from "../src/examples/mmo/order.ts";
import { gameProtocol, type GameProtocol } from "../src/examples/mmo/scenario.ts";
import type { World } from "../src/examples/mmo/model.ts";
import { sharedSecretAuthenticator, type Signer, type Verifier } from "../src/finalizer/finalizer.ts";
import {
  createSingleAuthority,
  createSingleAuthorityFinalizer,
  type ClosureAuthority,
} from "../src/finalizer/single-authority.ts";
import type { ClosureCertificate } from "../src/prdt/closure.ts";
import { proposalsForTick } from "../src/prdt/proposal-state.ts";
import { ReplicatedDomain, type Delta } from "../src/prdt/replicated-domain.ts";

export interface SingleAuthoritySetup {
  readonly protocol: GameProtocol;
  readonly authority: ClosureAuthority<GameCommand>;
  readonly authenticator: Signer & Verifier;
}

export function singleAuthoritySetup(options: { secret?: string; initialWorld?: World } = {}): SingleAuthoritySetup {
  const authenticator = sharedSecretAuthenticator(options.secret ?? "test-secret");
  const finalizer = createSingleAuthorityFinalizer<GameCommand>(authenticator);
  const protocol = gameProtocol(
    options.initialWorld === undefined ? { finalizer } : { finalizer, initialWorld: options.initialWorld },
  );
  const authority = createSingleAuthority<GameCommand>({ signer: authenticator, order: gameCommandOrder, hasher: sha256Hasher });
  return { protocol, authority, authenticator };
}

export function envelope(submittedBy: string, localSequence: number, tick: Tick, command: GameCommand): Envelope<GameCommand> {
  return { id: `${submittedBy}:${localSequence}`, tick, submittedBy, localSequence, command };
}

export function proposalDelta(...envelopes: Envelope<GameCommand>[]): Delta<GameCommand> {
  return { proposals: envelopes, closures: [] };
}

export function closureDelta(...certificates: ClosureCertificate[]): Delta<GameCommand> {
  return { proposals: [], closures: certificates };
}

/** Close the next tick of `object` with everything it currently knows for that tick. */
export function closeNext(object: ReplicatedDomain<World, GameCommand, GameEvent, GameRejection>, authority: ClosureAuthority<GameCommand>): ClosureCertificate {
  const tick = object.nextTick();
  const known = [...proposalsForTick(object.state.proposals, tick).values()];
  const certificate = authority.close(tick, object.decision().headDecisionHash, known);
  object.closeTick(certificate);
  return certificate;
}

export function hpOf(world: World, id: string): number {
  return world.players.get(id)?.hp ?? Number.NaN;
}
