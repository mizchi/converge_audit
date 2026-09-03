import { describe, expect, it } from "vitest";
import type { JsonValue } from "../../src/core/canonical.ts";
import { FIREBALL, LETHAL_HIT, PLAYER_A } from "../../src/examples/mmo/scenario.ts";
import { ReplicatedDomain } from "../../src/prdt/replicated-domain.ts";
import { AuthorityHost, decisionToJson, type SnapshotStorage } from "../../src/runtime/cloudflare/authority-host.ts";
import { hpOf, singleAuthoritySetup } from "../helpers.ts";

class FakeAsyncStorage implements SnapshotStorage {
  writes = 0;
  #value: string | undefined;
  async load(): Promise<JsonValue | undefined> {
    return this.#value === undefined ? undefined : (JSON.parse(this.#value) as JsonValue);
  }
  async save(snapshot: JsonValue): Promise<void> {
    this.writes += 1;
    this.#value = JSON.stringify(snapshot);
  }
}

describe("AuthorityHost", () => {
  it("persists after every mutation and survives a reopen", async () => {
    const { protocol, authority } = singleAuthoritySetup();
    const storage = new FakeAsyncStorage();
    const host = await AuthorityHost.open({ protocol, authority, storage, replicaId: "authority" });

    const client = new ReplicatedDomain(protocol, "X");
    const { delta } = client.propose({ tick: 0, command: FIREBALL });
    await host.merge(delta);
    await host.propose({ tick: 0, command: LETHAL_HIT });
    const certificate = await host.closeNextTick();
    expect(storage.writes).toBe(3);
    expect(certificate.orderedCommandIds).toEqual(["authority:0", "X:0"]);

    const reopened = await AuthorityHost.open({ protocol, authority, storage, replicaId: "authority" });
    expect(reopened.replica.stateHash()).toBe(host.replica.stateHash());
    expect(reopened.commandDecision("X:0")).toEqual({ status: "Rejected", tick: 0, reason: { type: "ActorDead" } });
    expect(hpOf(reopened.domainState(), PLAYER_A)).toBe(0);
    expect(reopened.nextTick()).toBe(1);

    // The client catches up from the host's full delta.
    client.merge(reopened.delta());
    expect(client.stateHash()).toBe(reopened.replica.stateHash());

    const json = decisionToJson(protocol, reopened.decision());
    expect(json).toMatchObject({ committedTicks: [0], commands: { "X:0": { status: "Rejected" } } });
  });
});
