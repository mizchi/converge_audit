import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import {
  compileVerificationKeyHistory,
  type VerificationKeyRecord,
} from "../../player-local-runtime/key-lifecycle";
import {
  VerificationKeyLifecycleStore,
} from "../src/verification-key-lifecycle-store";
import type { Env as AuditEnv } from "../src/index";

const OLD_PUBLIC_KEY = "11".repeat(32);
const NEW_PUBLIC_KEY = "22".repeat(32);

function key(
  keyVersion: number,
  publicKey: string,
  validFromMs: number,
  validUntilMs: number,
): VerificationKeyRecord {
  return {
    version: 1,
    keyId: "source-signing-key",
    keyVersion,
    subjectId: "evidence-source-a",
    purpose: "evidence-case-resolution",
    scopeId: "dungeon-a",
    scheme: "ed25519-v1",
    publicKey,
    validFromMs,
    validUntilMs,
    revokedAtMs: null,
  };
}

function stub(name: string) {
  const auditEnv = env as unknown as AuditEnv;
  return auditEnv.AUDIT_SHARD.get(auditEnv.AUDIT_SHARD.idFromName(name));
}

const digest = {
  async hashString(value: string): Promise<string> {
    const encoded = new TextEncoder().encode(value);
    return Array.from(
      new Uint8Array(await crypto.subtle.digest("SHA-256", encoded)),
      (byte) => byte.toString(16).padStart(2, "0"),
    ).join("");
  },
};

describe("Cloudflare verification-key lifecycle store", () => {
  it("atomically provisions, rotates, and revokes public verification keys", async () => {
    await runInDurableObject(
      stub(`verification-key-lifecycle:${crypto.randomUUID()}`),
      async (_instance, state) => {
        const store = new VerificationKeyLifecycleStore(state.storage);

        await expect(store.provision({
          record: key(1, OLD_PUBLIC_KEY, 0, 1_000),
          expectedRevision: 0,
          committedAtMs: 10,
          digest,
        })).resolves.toMatchObject({ decision: "committed", revision: 1 });
        await expect(store.rotate({
          keyId: "source-signing-key",
          previousKeyVersion: 1,
          nextRecord: key(2, NEW_PUBLIC_KEY, 500, 2_000),
          cutoverMs: 500,
          expectedRevision: 1,
          committedAtMs: 400,
          digest,
        })).resolves.toMatchObject({ decision: "committed", revision: 2 });

        const beforeStale = store.image("source-signing-key");
        await expect(store.revoke({
          keyId: "source-signing-key",
          keyVersion: 2,
          revokedAtMs: 750,
          expectedRevision: 1,
          committedAtMs: 700,
          digest,
        })).resolves.toEqual({
          decision: "refused",
          reason: "stale_revision",
        });
        expect(store.image("source-signing-key")).toEqual(beforeStale);

        await expect(store.revoke({
          keyId: "source-signing-key",
          keyVersion: 2,
          revokedAtMs: 750,
          expectedRevision: 2,
          committedAtMs: 700,
          digest,
        })).resolves.toMatchObject({ decision: "committed", revision: 3 });

        const image = store.image("source-signing-key");
        expect(image.records).toEqual([
          key(1, OLD_PUBLIC_KEY, 0, 500),
          { ...key(2, NEW_PUBLIC_KEY, 500, 2_000), revokedAtMs: 750 },
        ]);
        expect(image.events.map((event) => [
          event.lifecycleRevision,
          event.eventKind,
        ])).toEqual([
          [1, "provision"],
          [2, "rotate"],
          [3, "revoke"],
        ]);
        expect(new Set(image.events.map((event) => event.eventDigest)).size)
          .toBe(3);
        expect(compileVerificationKeyHistory(image.records).ok).toBe(true);
      },
    );
  });

  it("refuses a skipped key version without appending a lifecycle event", async () => {
    await runInDurableObject(
      stub(`verification-key-skip:${crypto.randomUUID()}`),
      async (_instance, state) => {
        const store = new VerificationKeyLifecycleStore(state.storage);
        await store.provision({
          record: key(1, OLD_PUBLIC_KEY, 0, 1_000),
          expectedRevision: 0,
          committedAtMs: 10,
          digest,
        });
        await expect(store.rotate({
          keyId: "source-signing-key",
          previousKeyVersion: 1,
          nextRecord: key(3, NEW_PUBLIC_KEY, 500, 2_000),
          cutoverMs: 500,
          expectedRevision: 1,
          committedAtMs: 400,
          digest,
        })).resolves.toEqual({
          decision: "refused",
          reason: "invalid_transition",
        });
        expect(store.image("source-signing-key").events).toHaveLength(1);
      },
    );
  });

  it("fails closed when a materialized revocation has no matching event", async () => {
    await runInDurableObject(
      stub(`verification-key-corrupt:${crypto.randomUUID()}`),
      async (_instance, state) => {
        const store = new VerificationKeyLifecycleStore(state.storage);
        await store.provision({
          record: key(1, OLD_PUBLIC_KEY, 0, 1_000),
          expectedRevision: 0,
          committedAtMs: 10,
          digest,
        });
        state.storage.sql.exec(
          `UPDATE verification_key_versions SET revoked_at_ms = 500
           WHERE key_id = 'source-signing-key' AND key_version = 1`,
        );

        await expect(store.rotate({
          keyId: "source-signing-key",
          previousKeyVersion: 1,
          nextRecord: key(2, NEW_PUBLIC_KEY, 600, 2_000),
          cutoverMs: 600,
          expectedRevision: 1,
          committedAtMs: 400,
          digest,
        })).resolves.toEqual({
          decision: "refused",
          reason: "corrupt_store",
        });
        expect(store.image("source-signing-key").events).toHaveLength(1);
      },
    );
  });
});
