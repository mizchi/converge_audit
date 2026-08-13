import { env } from "cloudflare:workers";
import { runInDurableObject, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import {
  compileVerificationKeyHistory,
  verifyKeyBoundStatementAsync,
} from "../../player-local-runtime/key-lifecycle";
import {
  createStandardWebCryptoBackend,
} from "../../player-local-runtime/crypto-backend";
import type {
  VerificationKeySignerEnv,
} from "../src/verification-key-signer-worker";

const SEED =
  "000102030405060708090a0b0c0d0e0f" +
  "101112131415161718191a1b1c1d1e1f";
const PUBLIC_KEY =
  "03a107bff3ce10be1d70dd18e74bc099" +
  "67e4d6309ba50d5f1ddc8664125531b8";
const adminHeaders = { authorization: "Bearer test-signer-admin-token" };
const callerHeaders = {
  authorization: "Bearer test-signer-caller-token-000000",
};

describe("verification-key signer Worker custody", () => {
  it("returns a verifiable key-bound authentication without exposing its secret", async () => {
    const response = await SELF.fetch("https://signer.test/v1/key-bound-sign", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-audit-signing-purpose": "evidence-case-resolution",
        ...callerHeaders,
      },
      body: JSON.stringify({
        version: 1,
        subject_id: "evidence-source-a",
        purpose: "evidence-case-resolution",
        scope_id: "reference-game",
        unit_id: "encounter-7",
        statement_digest: "ab".repeat(32),
      }),
    });
    expect(response.status).toBe(200);
    const body = await response.json() as Record<string, unknown>;
    const encoded = JSON.stringify(body);
    expect(encoded).not.toContain(SEED);
    expect(encoded).not.toMatch(/private|seed/i);

    const historyResponse = await SELF.fetch(
      "https://signer.test/v1/key-history/source-signing-key",
      { headers: adminHeaders },
    );
    expect(historyResponse.status).toBe(200);
    const historyBody = await historyResponse.json() as {
      records: Array<Record<string, unknown>>;
      events: Array<Record<string, unknown>>;
    };
    const records = historyBody.records.map((record) => ({
      version: record.version as 1,
      keyId: record.keyId as string,
      keyVersion: record.keyVersion as number,
      subjectId: record.subjectId as string,
      purpose: record.purpose as string,
      scopeId: record.scopeId as string,
      scheme: record.scheme as string,
      publicKey: record.publicKey as string,
      validFromMs: record.validFromMs as number,
      validUntilMs: record.validUntilMs as number,
      revokedAtMs: record.revokedAtMs as number | null,
    }));
    const compiled = compileVerificationKeyHistory(records);
    expect(compiled.ok).toBe(true);
    if (!compiled.ok) throw new Error(compiled.reason);
    const backend = createStandardWebCryptoBackend(crypto);
    await expect(verifyKeyBoundStatementAsync(
      body.authentication as never,
      {
        purpose: "evidence-case-resolution",
        scopeId: "reference-game",
        unitId: "encounter-7",
        subjectId: "evidence-source-a",
        statementDigest: "ab".repeat(32),
        nowMs: Date.now() + 1_000,
        maxClockSkewMs: 2_000,
        history: compiled.history,
        digest: backend,
        verifiers: { "ed25519-v1": backend },
      },
    )).resolves.toMatchObject({ ok: true });
    expect(JSON.stringify(historyBody)).not.toContain(SEED);
  });

  it("never persists the secret and denies public history access", async () => {
    expect((await SELF.fetch(
      "https://signer.test/v1/key-history/source-signing-key",
    )).status).toBe(401);

    const signerEnv = env as unknown as VerificationKeySignerEnv;
    const target = signerEnv.KEY_SIGNER.get(
      signerEnv.KEY_SIGNER.idFromName("source-signing-key"),
    );
    await runInDurableObject(target, async (_instance, state) => {
      const rows = state.storage.sql.exec<{ sql: string }>(
        "SELECT sql FROM sqlite_master WHERE sql IS NOT NULL",
      ).toArray();
      const values = state.storage.sql.exec<Record<string, SqlStorageValue>>(
        "SELECT * FROM verification_key_versions",
      ).toArray();
      const events = state.storage.sql.exec<Record<string, SqlStorageValue>>(
        "SELECT * FROM verification_key_lifecycle_events",
      ).toArray();
      const persisted = JSON.stringify({ rows, values, events });
      expect(persisted).not.toContain(SEED);
      expect(persisted).not.toMatch(/private_key|seed_hex/i);
    });
  });

  it("keeps the legacy relay signing endpoint explicit and secret-free", async () => {
    const response = await SELF.fetch("https://signer.test/v1/sign", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-audit-signing-purpose": "evidence-case-resolution",
        ...callerHeaders,
      },
      body: JSON.stringify({
        version: 1,
        source_id: "evidence-source-a",
        scheme: "ed25519-v1",
        digest: "cd".repeat(32),
      }),
    });
    expect(response.status).toBe(200);
    const encoded = await response.text();
    expect(encoded).not.toContain(SEED);
    expect(encoded).not.toMatch(/private|seed/i);
    expect(JSON.parse(encoded)).toMatchObject({
      ok: true,
      scheme: "ed25519-v1",
      key_id: "source-signing-key",
      key_version: 1,
      public_key: PUBLIC_KEY,
    });
  });
});
