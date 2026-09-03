import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { JsonValue } from "../../src/core/canonical.ts";
import type { GameCommand } from "../../src/examples/mmo/commands.ts";
import { FIREBALL, LETHAL_HIT, PLAYER_A, gameProtocol } from "../../src/examples/mmo/scenario.ts";
import { sharedSecretAuthenticator } from "../../src/finalizer/finalizer.ts";
import { createSingleAuthorityFinalizer } from "../../src/finalizer/single-authority.ts";
import { closureCertificateCodec } from "../../src/prdt/closure.ts";
import { ReplicatedDomain } from "../../src/prdt/replicated-domain.ts";

const BASE = "https://example.com/rooms/lethal-race";

async function call(path: string, init?: RequestInit): Promise<{ status: number; body: JsonValue }> {
  const response = await SELF.fetch(`${BASE}${path}`, init);
  return { status: response.status, body: (await response.json()) as JsonValue };
}

function post(path: string, body: JsonValue): Promise<{ status: number; body: JsonValue }> {
  return call(path, { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } });
}

describe("PrdtRoom Durable Object", () => {
  it("resolves the lethal-race scenario through HTTP and lets a client replica converge", async () => {
    // Client replica X shares the verifier of the dev authority (secret from wrangler vars).
    const protocol = gameProtocol({ finalizer: createSingleAuthorityFinalizer<GameCommand>(sharedSecretAuthenticator("dev-only-secret")) });
    const x = new ReplicatedDomain(protocol, "X");
    const { delta } = x.propose({ tick: 0, command: FIREBALL });

    expect((await post("/delta", protocol.deltaCodec.encode(delta))).status).toBe(200);
    const proposed = await post("/propose", { tick: 0, command: LETHAL_HIT });
    expect(proposed.status).toBe(200);
    expect(proposed.body).toMatchObject({ decision: { commands: { "X:0": { status: "Pending" } } } });

    const closed = await post("/close", {});
    expect(closed.status).toBe(200);
    const certificate = closureCertificateCodec.decode(closed.body);
    expect(certificate.orderedCommandIds).toEqual(["authority:0", "X:0"]);

    const decision = await call("/decision");
    expect(decision.body).toMatchObject({
      committedTicks: [0],
      commands: {
        "authority:0": { status: "Accepted", event: { type: "DamageApplied", target: PLAYER_A } },
        "X:0": { status: "Rejected", reason: { type: "ActorDead" } },
      },
    });
    const world = await call("/world");
    expect(world.body).toMatchObject({ tick: 1, world: { players: [[PLAYER_A, { hp: 0, mp: 100 }]] } });

    // Anti-entropy: X pulls the authority's full knowledge and reaches the same verdicts.
    const full = await call("/delta");
    x.merge(protocol.deltaCodec.decode(full.body));
    expect(x.decision().commands.get("X:0")).toEqual({ status: "Rejected", tick: 0, reason: { type: "ActorDead" } });
    expect(x.domainState().players.get(PLAYER_A)?.hp).toBe(0);
  });

  it("refuses a conflicting payload for a known command id", async () => {
    const protocol = gameProtocol({ finalizer: createSingleAuthorityFinalizer<GameCommand>(sharedSecretAuthenticator("dev-only-secret")) });
    const y = new ReplicatedDomain(protocol, "Y");
    const { envelope } = y.propose({ tick: 5, command: FIREBALL });
    expect((await post("/delta", protocol.deltaCodec.encode({ proposals: [envelope], closures: [] }))).status).toBe(200);
    const conflicting = { ...envelope, command: LETHAL_HIT };
    const response = await post("/delta", protocol.deltaCodec.encode({ proposals: [conflicting], closures: [] }));
    expect(response.status).toBe(409);
    expect(response.body).toMatchObject({ error: "ConflictingProposal" });
  });
});
