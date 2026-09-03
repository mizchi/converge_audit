/**
 * Cloudflare Workers adapter: one Durable Object per room hosts the
 * single-authority replica for the MMO sample. Only this file knows about
 * Cloudflare APIs; everything it calls is environment independent.
 *
 * Routes (all under /rooms/:room):
 *   POST /propose   { tick, command }        -> { envelope, decision }
 *   POST /delta     Delta JSON               -> { ok }
 *   GET  /delta                              -> Delta JSON (full knowledge, for anti-entropy)
 *   POST /close                              -> ClosureCertificate JSON
 *   GET  /decision                           -> decision JSON
 *   GET  /world                              -> domain state JSON
 */
import { DurableObject } from "cloudflare:workers";
import type { JsonValue } from "../../core/canonical.ts";
import { expectNumber, expectRecord } from "../../core/codec.ts";
import { sha256Hasher } from "../../core/hash.ts";
import {
  gameCommandOrder,
  gameProtocol,
  type GameCommand,
  type GameEvent,
  type GameRejection,
  type World,
} from "../../examples/mmo/index.ts";
import { sharedSecretAuthenticator } from "../../finalizer/finalizer.ts";
import { createSingleAuthority, createSingleAuthorityFinalizer } from "../../finalizer/single-authority.ts";
import { closureCertificateCodec } from "../../prdt/closure.ts";
import { ProtocolError } from "../../prdt/errors.ts";
import { AuthorityHost, decisionToJson, type SnapshotStorage } from "./authority-host.ts";

export interface Env {
  readonly PRDT_ROOM: DurableObjectNamespace<PrdtRoom>;
  /** Shared-secret MAC key for the dev authority. Replace with a real signer for deployments. */
  readonly AUTHORITY_SECRET?: string;
}

const SNAPSHOT_KEY = "prdt/snapshot";

type MmoHost = AuthorityHost<World, GameCommand, GameEvent, GameRejection>;

function durableStorage(storage: DurableObjectStorage): SnapshotStorage {
  return {
    load: async () => (await storage.get<JsonValue>(SNAPSHOT_KEY)) ?? undefined,
    save: async (snapshot) => {
      await storage.put(SNAPSHOT_KEY, snapshot);
    },
  };
}

export class PrdtRoom extends DurableObject<Env> {
  #host: Promise<MmoHost> | undefined;

  #open(): Promise<MmoHost> {
    if (this.#host === undefined) {
      const authenticator = sharedSecretAuthenticator(this.env.AUTHORITY_SECRET ?? "dev-only-secret");
      const protocol = gameProtocol({ finalizer: createSingleAuthorityFinalizer<GameCommand>(authenticator) });
      const authority = createSingleAuthority<GameCommand>({ signer: authenticator, order: gameCommandOrder, hasher: sha256Hasher });
      this.#host = AuthorityHost.open({
        protocol,
        authority,
        storage: durableStorage(this.ctx.storage),
        replicaId: "authority",
      });
    }
    return this.#host;
  }

  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    try {
      const host = await this.#open();
      const protocol = host.protocol;
      switch (`${request.method} ${url.pathname}`) {
        case "POST /propose": {
          const body = expectRecord((await request.json()) as JsonValue, "propose");
          const tick = expectNumber(body.tick, "propose.tick");
          const command = protocol.config.codec.command.decode(body.command ?? null);
          const envelope = await host.propose({ tick, command });
          return json({
            envelope: protocol.envelopeCodec.encode(envelope),
            decision: decisionToJson(protocol, host.decision()),
          });
        }
        case "POST /delta": {
          const delta = protocol.deltaCodec.decode((await request.json()) as JsonValue);
          await host.merge(delta);
          return json({ ok: true, nextTick: host.nextTick() });
        }
        case "GET /delta":
          return json(protocol.deltaCodec.encode(host.delta()));
        case "POST /close": {
          const certificate = await host.closeNextTick();
          return json(closureCertificateCodec.encode(certificate));
        }
        case "GET /decision":
          return json(decisionToJson(protocol, host.decision()));
        case "GET /world":
          return json({ tick: host.nextTick(), world: protocol.config.codec.state.encode(host.domainState()) });
        default:
          return json({ error: "not found" }, 404);
      }
    } catch (error) {
      if (error instanceof ProtocolError) return json({ error: error.kind, message: error.message }, 409);
      if (error instanceof TypeError || error instanceof RangeError) return json({ error: "bad request", message: error.message }, 400);
      throw error;
    }
  }
}

function json(value: JsonValue, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const match = /^\/rooms\/([^/]+)(\/.*)$/.exec(url.pathname);
    if (match === null) return json({ error: "expected /rooms/:room/<route>" }, 404);
    const [, room, rest] = match;
    const stub = env.PRDT_ROOM.get(env.PRDT_ROOM.idFromName(room!));
    const forwarded = new URL(request.url);
    forwarded.pathname = rest!;
    // Buffer the body so the object never has to read a stream after the outer response was sent.
    const body = request.method === "GET" || request.method === "HEAD" ? null : await request.arrayBuffer();
    return stub.fetch(new Request(forwarded, { method: request.method, headers: request.headers, body }));
  },
} satisfies ExportedHandler<Env>;
