import { env } from "cloudflare:workers";
import { evictDurableObject, runInDurableObject, SELF } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import { loadCheckpointRuntime } from "../src/moonbit";
import {
  InjectedObserverSigningStoreFault,
  OpenWorldObserverSigningStore,
  signAfterObserverReservation,
} from "../src/open-world-observer-signing-store";
import type { Env as AuditEnv } from "../src/index";

const OBSERVER_ID = "open-world-observer-a";
const SIGNER_KEY = "11".repeat(32);
const AUDIT_PLAN = "22".repeat(32);
const ENCOUNTER_A = "33".repeat(32);
const ENCOUNTER_B = "44".repeat(32);

function stub(name: string) {
  const auditEnv = env as unknown as AuditEnv;
  return auditEnv.AUDIT_SHARD.get(auditEnv.AUDIT_SHARD.idFromName(name));
}

describe("durable open-world observer signing store", () => {
  it("exposes reservation only through the internal observer-signer RPC", async () => {
    const name = `observer-signing-rpc:${crypto.randomUUID()}`;
    const target = stub(name);
    const internalHeaders = {
      "content-type": "application/json",
      "x-audit-internal": "observer-signer",
      "x-audit-mode": "open",
      "x-audit-unit": name,
    };
    const configure = await target.fetch("https://audit.internal/observer-signing-configure", {
      method: "POST",
      headers: internalHeaders,
      body: JSON.stringify({ observer_id: OBSERVER_ID, signer_key: SIGNER_KEY }),
    });
    expect(configure.status).toBe(201);
    const reserve = (encounterDigest: string) => stub(name).fetch(
      "https://audit.internal/observer-signing-reservations",
      {
        method: "POST",
        headers: internalHeaders,
        body: JSON.stringify({
          audit_checkpoint_digest: AUDIT_PLAN,
          registration_index: 4,
          encounter_digest: encounterDigest,
        }),
      },
    );
    expect((await reserve(ENCOUNTER_A)).status).toBe(201);
    expect((await reserve(ENCOUNTER_A)).status).toBe(200);
    expect((await reserve(ENCOUNTER_B)).status).toBe(409);
    const anchor = await target.fetch("https://audit.internal/observer-signing-anchor", {
      headers: internalHeaders,
    });
    expect(anchor.status).toBe(200);
    await expect(anchor.json()).resolves.toMatchObject({
      ok: true,
      observer_id: OBSERVER_ID,
      signer_key: SIGNER_KEY,
      size: 1,
    });

    const publicAttempt = await SELF.fetch(
      `https://example.test/v1/open/${name}/observer-signing-reservations`,
      {
        method: "POST",
        headers: { ...internalHeaders, authorization: "Bearer test-admin-token" },
        body: JSON.stringify({
          audit_checkpoint_digest: AUDIT_PLAN,
          registration_index: 5,
          encounter_digest: ENCOUNTER_A,
        }),
      },
    );
    expect(publicAttempt.status).toBe(404);
  });

  it("commits the reservation before signing and reuses only the exact digest", async () => {
    const target = stub(`observer-signing:${crypto.randomUUID()}`);
    await runInDurableObject(target, async (_instance, state) => {
      const runtime = await loadCheckpointRuntime();
      const store = new OpenWorldObserverSigningStore(state.storage);
      expect(store.open(runtime, {
        observerId: OBSERVER_ID,
        signerKey: SIGNER_KEY,
      }).decision).toBe("configured");
      const signer = vi.fn(async () => {
        expect(store.reservation(AUDIT_PLAN, 7)?.encounter_digest).toBe(
          ENCOUNTER_A,
        );
        return "signed-a";
      });
      await expect(signAfterObserverReservation(
        store,
        runtime,
        {
          auditCheckpointDigest: AUDIT_PLAN,
          registrationIndex: 7,
          encounterDigest: ENCOUNTER_A,
        },
        signer,
      )).resolves.toMatchObject({ decision: "signed", value: "signed-a" });
      await expect(signAfterObserverReservation(
        store,
        runtime,
        {
          auditCheckpointDigest: AUDIT_PLAN,
          registrationIndex: 7,
          encounterDigest: ENCOUNTER_A,
        },
        signer,
      )).resolves.toMatchObject({ decision: "reused", value: "signed-a" });
      const beforeConflict = store.snapshot(runtime);
      await expect(signAfterObserverReservation(
        store,
        runtime,
        {
          auditCheckpointDigest: AUDIT_PLAN,
          registrationIndex: 7,
          encounterDigest: ENCOUNTER_B,
        },
        signer,
      )).resolves.toMatchObject({
        decision: "conflict",
        previous_encounter_digest: ENCOUNTER_A,
      });
      expect(signer).toHaveBeenCalledTimes(2);
      expect(store.stats()).toMatchObject({ reservations: 1, conflicts: 1 });
      expect(store.snapshot(runtime)).toEqual(beforeConflict);
    });
  });

  it("survives eviction and rejects empty, stale, or foreign trusted anchors", async () => {
    const target = stub(`observer-signing-restart:${crypto.randomUUID()}`);
    const anchors = await runInDurableObject(target, async (_instance, state) => {
      const runtime = await loadCheckpointRuntime();
      const store = new OpenWorldObserverSigningStore(state.storage);
      const configured = store.open(runtime, {
        observerId: OBSERVER_ID,
        signerKey: SIGNER_KEY,
      });
      if (configured.decision !== "configured") {
        throw new Error("expected a newly configured signing store");
      }
      expect(store.reserve(runtime, {
        auditCheckpointDigest: AUDIT_PLAN,
        registrationIndex: 1,
        encounterDigest: ENCOUNTER_A,
      }).decision).toBe("reserved");
      return { empty: configured.anchor, current: store.snapshot(runtime) };
    });
    await evictDurableObject(target);
    await runInDurableObject(target, async (_instance, state) => {
      const runtime = await loadCheckpointRuntime();
      const store = new OpenWorldObserverSigningStore(state.storage);
      expect(store.open(runtime, {
        observerId: OBSERVER_ID,
        signerKey: SIGNER_KEY,
        trustedAnchor: anchors.current,
      }).decision).toBe("restored");
      expect(store.reserve(runtime, {
        auditCheckpointDigest: AUDIT_PLAN,
        registrationIndex: 1,
        encounterDigest: ENCOUNTER_B,
      })).toMatchObject({
        decision: "conflict",
        previous_encounter_digest: ENCOUNTER_A,
      });
      expect(store.open(runtime, {
        observerId: OBSERVER_ID,
        signerKey: SIGNER_KEY,
        trustedAnchor: anchors.empty,
      }).decision).toBe("anchor_mismatch");
      expect(store.open(runtime, {
        observerId: OBSERVER_ID,
        signerKey: SIGNER_KEY,
        trustedAnchor: { ...anchors.current, root: "55".repeat(32) },
      }).decision).toBe("anchor_mismatch");
      expect(store.open(runtime, {
        observerId: "foreign-observer",
        signerKey: SIGNER_KEY,
      }).decision).toBe("identity_mismatch");
      expect(store.reserve(runtime, {
        auditCheckpointDigest: AUDIT_PLAN,
        registrationIndex: 2,
        encounterDigest: ENCOUNTER_A,
      }).decision).toBe("reserved");
      expect(store.open(runtime, {
        observerId: OBSERVER_ID,
        signerKey: SIGNER_KEY,
        trustedAnchor: anchors.current,
      }).decision).toBe("anchor_mismatch");
    });
  });

  it("keeps a reservation when the signer fails and reuses it after restart", async () => {
    const target = stub(`observer-signing-signer-failure:${crypto.randomUUID()}`);
    await runInDurableObject(target, async (_instance, state) => {
      const runtime = await loadCheckpointRuntime();
      const store = new OpenWorldObserverSigningStore(state.storage);
      store.open(runtime, { observerId: OBSERVER_ID, signerKey: SIGNER_KEY });
      await expect(signAfterObserverReservation(
        store,
        runtime,
        {
          auditCheckpointDigest: AUDIT_PLAN,
          registrationIndex: 2,
          encounterDigest: ENCOUNTER_A,
        },
        () => {
          throw new Error("signer unavailable");
        },
      )).rejects.toThrow("signer unavailable");
      expect(store.reservation(AUDIT_PLAN, 2)?.encounter_digest).toBe(
        ENCOUNTER_A,
      );
    });
    await evictDurableObject(target);
    await runInDurableObject(target, async (_instance, state) => {
      const runtime = await loadCheckpointRuntime();
      const store = new OpenWorldObserverSigningStore(state.storage);
      expect(store.open(runtime, {
        observerId: OBSERVER_ID,
        signerKey: SIGNER_KEY,
      }).decision).toBe("restored");
      await expect(signAfterObserverReservation(
        store,
        runtime,
        {
          auditCheckpointDigest: AUDIT_PLAN,
          registrationIndex: 2,
          encounterDigest: ENCOUNTER_A,
        },
        () => "signed-after-restart",
      )).resolves.toMatchObject({
        decision: "reused",
        value: "signed-after-restart",
      });
      expect(store.reserve(runtime, {
        auditCheckpointDigest: AUDIT_PLAN,
        registrationIndex: 2,
        encounterDigest: ENCOUNTER_B,
      }).decision).toBe("conflict");
    });
  });

  it("serializes simultaneous conflicting reservations across the internal RPC", async () => {
    const name = `observer-signing-race:${crypto.randomUUID()}`;
    const target = stub(name);
    const headers = {
      "content-type": "application/json",
      "x-audit-internal": "observer-signer",
      "x-audit-mode": "open",
      "x-audit-unit": name,
    };
    expect((await target.fetch(
      "https://audit.internal/observer-signing-configure",
      {
        method: "POST",
        headers,
        body: JSON.stringify({ observer_id: OBSERVER_ID, signer_key: SIGNER_KEY }),
      },
    )).status).toBe(201);
    const reserve = async (encounterDigest: string) => {
      const response = await stub(name).fetch(
        "https://audit.internal/observer-signing-reservations",
        {
          method: "POST",
          headers,
          body: JSON.stringify({
            audit_checkpoint_digest: AUDIT_PLAN,
            registration_index: 6,
            encounter_digest: encounterDigest,
          }),
        },
      );
      return {
        status: response.status,
        body: await response.json() as {
          decision: string;
          reservation?: { encounter_digest: string };
        },
      };
    };
    const responses = await Promise.all([reserve(ENCOUNTER_A), reserve(ENCOUNTER_B)]);
    expect(responses.map((response) => response.status).sort()).toEqual([201, 409]);
    const winner = responses.find((response) => response.body.decision === "reserved")!
      .body.reservation!.encounter_digest;
    const loser = winner === ENCOUNTER_A ? ENCOUNTER_B : ENCOUNTER_A;
    expect((await reserve(winner)).status).toBe(200);
    expect((await reserve(loser)).status).toBe(409);
  });

  it("fails closed on incompatible schema and corrupted key binding", async () => {
    const target = stub(`observer-signing-corruption:${crypto.randomUUID()}`);
    await runInDurableObject(target, async (_instance, state) => {
      const runtime = await loadCheckpointRuntime();
      const store = new OpenWorldObserverSigningStore(state.storage);
      store.open(runtime, { observerId: OBSERVER_ID, signerKey: SIGNER_KEY });
      store.reserve(runtime, {
        auditCheckpointDigest: AUDIT_PLAN,
        registrationIndex: 8,
        encounterDigest: ENCOUNTER_A,
      });
      state.storage.sql.exec(
        "UPDATE open_world_observer_signing_metadata SET schema_version = 2",
      );
      expect(store.open(runtime, {
        observerId: OBSERVER_ID,
        signerKey: SIGNER_KEY,
      }).decision).toBe("incompatible_schema");

      state.storage.sql.exec(
        "UPDATE open_world_observer_signing_metadata SET schema_version = 1",
      );
      state.storage.sql.exec(
        `UPDATE open_world_observer_signing_reservations
         SET registration_index = registration_index + 1`,
      );
      expect(store.open(runtime, {
        observerId: OBSERVER_ID,
        signerKey: SIGNER_KEY,
      }).decision).toBe("corrupt_store");
    });
  });

  it.each(["after_reservation", "after_sequence"] as const)(
    "rolls back the whole reservation transaction at %s",
    async (point) => {
      const target = stub(`observer-signing-fault:${point}:${crypto.randomUUID()}`);
      await runInDurableObject(target, async (_instance, state) => {
        const runtime = await loadCheckpointRuntime();
        const store = new OpenWorldObserverSigningStore(state.storage);
        store.open(runtime, { observerId: OBSERVER_ID, signerKey: SIGNER_KEY });
        const signer = vi.fn();
        await expect(signAfterObserverReservation(
          store,
          runtime,
          {
            auditCheckpointDigest: AUDIT_PLAN,
            registrationIndex: 3,
            encounterDigest: ENCOUNTER_A,
          },
          signer,
          new InjectedObserverSigningStoreFault(point),
        )).resolves.toMatchObject({ decision: "unavailable" });
        expect(signer).not.toHaveBeenCalled();
        expect(store.reservation(AUDIT_PLAN, 3)).toBeUndefined();
        expect(store.stats()).toMatchObject({ reservations: 0, next_sequence: 0 });
      });
    },
  );

  it("keeps reservations while pruning only unprotected conflict attempts", async () => {
    const target = stub(`observer-signing-prune:${crypto.randomUUID()}`);
    await runInDurableObject(target, async (_instance, state) => {
      const runtime = await loadCheckpointRuntime();
      const store = new OpenWorldObserverSigningStore(state.storage);
      store.open(runtime, { observerId: OBSERVER_ID, signerKey: SIGNER_KEY });
      for (const registrationIndex of [0, 1]) {
        store.reserve(runtime, {
          auditCheckpointDigest: AUDIT_PLAN,
          registrationIndex,
          encounterDigest: ENCOUNTER_A,
        }, registrationIndex + 1);
        store.reserve(runtime, {
          auditCheckpointDigest: AUDIT_PLAN,
          registrationIndex,
          encounterDigest: ENCOUNTER_B,
        }, registrationIndex + 10);
      }
      const protectedKey = store.reservation(AUDIT_PLAN, 1)!.signing_key;
      expect(store.pruneConflictAttempts({
        before: 20,
        protectedSigningKeys: [protectedKey],
      })).toEqual({ pruned: 1, retained: 1 });
      expect(store.stats()).toMatchObject({ reservations: 2, conflicts: 1 });
      expect(store.reservation(AUDIT_PLAN, 0)).toBeDefined();
      expect(store.reservation(AUDIT_PLAN, 1)).toBeDefined();
    });
  });
});
