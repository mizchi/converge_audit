import { env } from "cloudflare:workers";
import { SELF, evictDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type {
  EvidenceResolutionRelayEnv,
} from "../src/evidence-resolution-relay-worker";

const adminHeaders = {
  authorization: "Bearer test-relay-admin-token-000000",
  "content-type": "application/json",
};

describe("evidence resolution relay worker", () => {
  it("persists lease attempts and exponential retry across eviction", async () => {
    const first = await SELF.fetch("https://relay.test/v1/relay/run", {
      method: "POST",
      headers: adminHeaders,
      body: JSON.stringify({ now_ms: 100 }),
    });
    expect(first.status).toBe(200);
    await expect(first.json()).resolves.toMatchObject({
      decision: "completed",
      outcome: "retry_scheduled",
      failures: 1,
      next_poll_at_ms: 200,
    });

    const early = await SELF.fetch("https://relay.test/v1/relay/run", {
      method: "POST",
      headers: adminHeaders,
      body: JSON.stringify({ now_ms: 150 }),
    });
    await expect(early.json()).resolves.toMatchObject({
      decision: "idle",
      reason: "not_due",
    });

    const relayEnv = env as unknown as EvidenceResolutionRelayEnv;
    const stub = relayEnv.SOURCE_RELAY.get(
      relayEnv.SOURCE_RELAY.idFromName("evidence-source-a"),
    );
    await evictDurableObject(stub);

    const recovered = await SELF.fetch("https://relay.test/v1/relay/run", {
      method: "POST",
      headers: adminHeaders,
      body: JSON.stringify({ now_ms: 200 }),
    });
    await expect(recovered.json()).resolves.toMatchObject({
      decision: "completed",
      outcome: "no_change",
      failures: 0,
      next_poll_at_ms: 1200,
    });

    const status = await SELF.fetch("https://relay.test/v1/relay/status", {
      headers: adminHeaders,
    });
    await expect(status.json()).resolves.toMatchObject({
      ok: true,
      job: {
        cursor: {
          sourceId: "evidence-source-a",
          sequence: -1,
          resolutionId: "resolution-genesis",
        },
        failures: 0,
        attemptCount: 2,
        leaseExpiresAtMs: null,
        pending: null,
      },
    });

    const publishInterrupted = await SELF.fetch(
      "https://relay.test/v1/relay/run",
      {
        method: "POST",
        headers: adminHeaders,
        body: JSON.stringify({ now_ms: 1200 }),
      },
    );
    await expect(publishInterrupted.json()).resolves.toMatchObject({
      decision: "completed",
      outcome: "retry_scheduled",
      failures: 1,
      next_poll_at_ms: 1300,
    });
    const pendingStatus = await SELF.fetch(
      "https://relay.test/v1/relay/status",
      { headers: adminHeaders },
    );
    await expect(pendingStatus.json()).resolves.toMatchObject({
      job: {
        cursor: { sequence: -1, resolutionId: "resolution-genesis" },
        pending: {
          caseId: "c".repeat(64),
          noticeSequence: 0,
          envelope: {
            authentication: {
              version: 1,
              keyId: "source-signing-key",
              keyVersion: 1,
              scheme: "ed25519-v1",
            },
          },
        },
      },
    });

    await evictDurableObject(stub);
    const exactRetry = await SELF.fetch("https://relay.test/v1/relay/run", {
      method: "POST",
      headers: adminHeaders,
      body: JSON.stringify({ now_ms: 1300 }),
    });
    await expect(exactRetry.json()).resolves.toMatchObject({
      decision: "completed",
      outcome: "delivered",
      failures: 0,
      next_poll_at_ms: 2300,
    });
    const deliveredStatus = await SELF.fetch(
      "https://relay.test/v1/relay/status",
      { headers: adminHeaders },
    );
    await expect(deliveredStatus.json()).resolves.toMatchObject({
      job: {
        cursor: { sequence: 0 },
        failures: 0,
        attemptCount: 4,
        pending: null,
      },
    });
  });

  it("does not expose the scheduler without its control credential", async () => {
    const response = await SELF.fetch("https://relay.test/v1/relay/status");
    expect(response.status).toBe(401);
  });
});
