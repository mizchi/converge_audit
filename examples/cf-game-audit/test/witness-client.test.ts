import { describe, expect, it } from "vitest";
import {
  audit_benchmark_make_checkpoint_delivery_authentication,
} from "../../../_build/js/release/build/x/game_audit/worker_fixture/worker_fixture.js";
import {
  audit_browser_ed25519_public_key,
} from "../../../_build/js/release/build/x/game_audit/browser_bridge/browser_bridge.js";
import {
  approveCheckpointWitnessCollection,
  approveCheckpointWitnessCollectionWithLegacySeed,
  selectCheckpointWitnessSigningKey,
  type PublicCheckpointWitnessCollection,
} from "../src/witness-client";
import {
  createStandardWebCryptoBackend,
} from "../../player-local-runtime/crypto-backend";
import {
  compileVerificationKeyHistory,
  type VerificationKeyRecord,
} from "../../player-local-runtime/key-lifecycle";

const PRODUCER_SEED =
  "000102030405060708090a0b0c0d0e0f" +
  "101112131415161718191a1b1c1d1e1f";
const WITNESS_SEEDS = [
  "404142434445464748494a4b4c4d4e4f" +
    "505152535455565758595a5b5c5d5e5f",
  "606162636465666768696a6b6c6d6e6f" +
    "707172737475767778797a7b7c7d7e7f",
];
const WITNESS_IDS = ["witness-a", "witness-b"];
const ROTATED_WITNESS_SEED =
  "c0c1c2c3c4c5c6c7c8c9cacbcccdcecf" +
  "d0d1d2d3d4d5d6d7d8d9dadbdcdddedf";
const standardBackend = createStandardWebCryptoBackend(crypto);

function witnessMigration(witnessIndex: number, scopeId: string) {
  const publicKey = audit_benchmark_make_checkpoint_delivery_authentication(
    PRODUCER_SEED,
    "checkpoint-producer",
    WITNESS_SEEDS,
    WITNESS_IDS,
    2,
    2,
    1,
    "checkpoint-v1",
    "manifest-1",
    scopeId,
    "peer-client",
    "authority-1",
    0,
    "genesis",
    "checkpoint-peer-client",
    "canonical-envelope-peer-client",
  );
  const fixture = JSON.parse(publicKey) as {
    policy: PublicCheckpointWitnessCollection["authentication_policy"];
  };
  const key: VerificationKeyRecord = {
    version: 1,
    keyId: `test-${WITNESS_IDS[witnessIndex]}`,
    keyVersion: 1,
    subjectId: WITNESS_IDS[witnessIndex],
    purpose: "checkpoint-witness",
    scopeId,
    scheme: "ed25519-v1",
    publicKey: fixture.policy.witnesses[witnessIndex].witness_key,
    validFromMs: 0,
    validUntilMs: Number.MAX_SAFE_INTEGER,
    revokedAtMs: null,
  };
  const compiled = compileVerificationKeyHistory([key]);
  if (!compiled.ok) throw new Error(compiled.reason);
  return { key, history: compiled.history };
}

function collectionFixture(): {
  collection: PublicCheckpointWitnessCollection;
  expectedApproval: PublicCheckpointWitnessCollection["producer_authentication"]["approvals"][number];
} {
  const statement = {
    boundary: {
      protocol_version: 1,
      purpose: "checkpoint-v1",
      manifest_digest: "manifest-1",
      scope_id: "cf:pvp:peer-client",
      unit_id: "peer-client",
    },
    destination_id: "authority-1",
    epoch: 0,
    previous_checkpoint: "genesis",
    checkpoint_digest: "checkpoint-peer-client",
    canonical_envelope: "canonical-envelope-peer-client",
  };
  const fixture = JSON.parse(
    audit_benchmark_make_checkpoint_delivery_authentication(
      PRODUCER_SEED,
      "checkpoint-producer",
      WITNESS_SEEDS,
      WITNESS_IDS,
      2,
      2,
      statement.boundary.protocol_version,
      statement.boundary.purpose,
      statement.boundary.manifest_digest,
      statement.boundary.scope_id,
      statement.boundary.unit_id,
      statement.destination_id,
      statement.epoch,
      statement.previous_checkpoint,
      statement.checkpoint_digest,
      statement.canonical_envelope,
    ),
  ) as {
    ok: true;
    policy: PublicCheckpointWitnessCollection["authentication_policy"];
    authentication: PublicCheckpointWitnessCollection["producer_authentication"];
  };
  const [expectedApproval] = fixture.authentication.approvals;
  return {
    collection: {
      ok: true,
      collection_id: "collection-peer-client",
      statement,
      producer_authentication: {
        ...fixture.authentication,
        approvals: [],
      },
      authentication_policy: fixture.policy,
      status: "collecting",
      approval_count: 0,
      required_approvals: 2,
      deadline_at: Date.now() + 60_000,
      created_at: Date.now(),
      ready_at: null,
    },
    expectedApproval,
  };
}

describe("checkpoint witness client", () => {
  it("selects the active rotated witness key at the signing time", () => {
    const scopeId = "cf:pvp:peer-client";
    const oldKey = witnessMigration(0, scopeId).key;
    const nextKey: VerificationKeyRecord = {
      ...oldKey,
      keyVersion: 2,
      publicKey: audit_browser_ed25519_public_key(ROTATED_WITNESS_SEED),
      validFromMs: 100,
      validUntilMs: 200,
    };
    const history = [{ ...oldKey, validUntilMs: 100 }, nextKey];

    expect(selectCheckpointWitnessSigningKey(
      history,
      WITNESS_IDS[0],
      scopeId,
      99,
    )?.keyVersion).toBe(1);
    expect(selectCheckpointWitnessSigningKey(
      history,
      WITNESS_IDS[0],
      scopeId,
      100,
    )?.keyVersion).toBe(2);
    expect(selectCheckpointWitnessSigningKey(
      [{ ...nextKey, revokedAtMs: 150 }],
      WITNESS_IDS[0],
      scopeId,
      150,
    )).toBeUndefined();
    expect(selectCheckpointWitnessSigningKey(
      history,
      WITNESS_IDS[0],
      "cf:pvp:retargeted",
      100,
    )).toBeUndefined();
  });

  it("keeps the CLI seed adapter on standard WebCrypto signing", async () => {
    const { collection, expectedApproval } = collectionFixture();
    const migration = witnessMigration(0, collection.statement.boundary.scope_id);
    let submitted: unknown;
    const fetchImpl = async (
      input: string | URL | Request,
      init?: RequestInit,
    ): Promise<Response> => {
      const request = new Request(input, init);
      if (request.method === "GET") return Response.json(collection);
      submitted = await request.json();
      return Response.json({ ok: true }, { status: 202 });
    };

    await approveCheckpointWitnessCollectionWithLegacySeed({
      baseUrl: "https://audit.example",
      mode: "pvp",
      unit: "peer-client",
      collectionId: collection.collection_id,
      witnessId: WITNESS_IDS[0],
      witnessSeedHex: WITNESS_SEEDS[0],
      verificationKey: migration.key,
      keyHistory: migration.history,
      legacyAcceptUntilMs: Number.MAX_SAFE_INTEGER,
      maxClockSkewMs: 5_000,
      cryptoBackend: standardBackend,
      fetchImpl,
    });
    expect(submitted).toMatchObject({
      collection_id: collection.collection_id,
      approval: {
        ...expectedApproval,
        signature: expect.stringMatching(/^[0-9a-f]{128}$/),
        key_authentication: {
          keyId: migration.key.keyId,
          keyVersion: 1,
        },
      },
    });
  });

  it("fetches the public collection, signs locally, and submits only the approval", async () => {
    const { collection, expectedApproval } = collectionFixture();
    const migration = witnessMigration(0, collection.statement.boundary.scope_id);
    let submitted: unknown;
    const fetchImpl = async (
      input: string | URL | Request,
      init?: RequestInit,
    ): Promise<Response> => {
      const request = new Request(input, init);
      if (request.method === "GET") return Response.json(collection);
      submitted = await request.json();
      return Response.json(
        { ok: true, decision: "accepted", status: "collecting", approval_count: 1 },
        { status: 202 },
      );
    };

    const result = await approveCheckpointWitnessCollection({
      baseUrl: "https://audit.example",
      mode: "pvp",
      unit: "peer-client",
      collectionId: collection.collection_id,
      witnessId: WITNESS_IDS[0],
      signer: (await standardBackend.importLegacySeed(
        WITNESS_SEEDS[0],
        expectedApproval.witness_key,
      )).signer,
      verificationKey: migration.key,
      keyHistory: migration.history,
      legacyAcceptUntilMs: Number.MAX_SAFE_INTEGER,
      maxClockSkewMs: 5_000,
      cryptoBackend: standardBackend,
      fetchImpl,
    });

    expect(submitted).toMatchObject({
      collection_id: collection.collection_id,
      approval: {
        ...expectedApproval,
        signature: expect.stringMatching(/^[0-9a-f]{128}$/),
        key_authentication: { keyId: migration.key.keyId },
      },
    });
    expect(result).toMatchObject({
      httpStatus: 202,
      witnessId: WITNESS_IDS[0],
      witnessKey: expectedApproval.witness_key,
      response: { ok: true, decision: "accepted", approval_count: 1 },
    });
  });

  it("uses a rotated key-history version without requiring the legacy roster key", async () => {
    const { collection } = collectionFixture();
    const scopeId = collection.statement.boundary.scope_id;
    const oldKey = witnessMigration(0, scopeId).key;
    const rotatedPublicKey = audit_browser_ed25519_public_key(
      ROTATED_WITNESS_SEED,
    );
    const rotatedKey: VerificationKeyRecord = {
      ...oldKey,
      keyVersion: 2,
      publicKey: rotatedPublicKey,
      validFromMs: 100,
      validUntilMs: Number.MAX_SAFE_INTEGER,
    };
    const compiled = compileVerificationKeyHistory([{
      ...oldKey,
      validUntilMs: 100,
    }, rotatedKey]);
    if (!compiled.ok) throw new Error(compiled.reason);
    let submitted: {
      approval?: { witness_key?: string; key_authentication?: { keyVersion?: number } };
    } | undefined;
    const fetchImpl = async (
      input: string | URL | Request,
      init?: RequestInit,
    ): Promise<Response> => {
      const request = new Request(input, init);
      if (request.method === "GET") return Response.json(collection);
      submitted = await request.json() as typeof submitted;
      return Response.json({ ok: true }, { status: 202 });
    };
    const signer = (await standardBackend.importLegacySeed(
      ROTATED_WITNESS_SEED,
      rotatedPublicKey,
    )).signer;

    await approveCheckpointWitnessCollection({
      baseUrl: "https://audit.example",
      mode: "pvp",
      unit: "peer-client",
      collectionId: collection.collection_id,
      witnessId: WITNESS_IDS[0],
      signer,
      verificationKey: rotatedKey,
      keyHistory: compiled.history,
      legacyAcceptUntilMs: Number.MAX_SAFE_INTEGER,
      maxClockSkewMs: 5_000,
      cryptoBackend: standardBackend,
      fetchImpl,
      now: () => 1_000,
    });

    expect(submitted?.approval).toMatchObject({
      witness_key: rotatedPublicKey,
      key_authentication: { keyVersion: 2 },
    });
  });

  it("rejects a signer that does not match the provisioned witness before POST", async () => {
    const { collection } = collectionFixture();
    const migration = witnessMigration(1, collection.statement.boundary.scope_id);
    let postCount = 0;
    const fetchImpl = async (
      input: string | URL | Request,
      init?: RequestInit,
    ): Promise<Response> => {
      const request = new Request(input, init);
      if (request.method === "GET") return Response.json(collection);
      postCount += 1;
      return Response.json({ ok: true }, { status: 202 });
    };

    await expect(approveCheckpointWitnessCollection({
      baseUrl: "https://audit.example",
      mode: "pvp",
      unit: "peer-client",
      collectionId: collection.collection_id,
      witnessId: WITNESS_IDS[1],
      signer: (await standardBackend.importLegacySeed(
        WITNESS_SEEDS[0],
        collection.authentication_policy.witnesses[0].witness_key,
      )).signer,
      verificationKey: migration.key,
      keyHistory: migration.history,
      legacyAcceptUntilMs: Number.MAX_SAFE_INTEGER,
      maxClockSkewMs: 5_000,
      cryptoBackend: standardBackend,
      fetchImpl,
    })).rejects.toThrow("witness_signer_does_not_match_verification_key");
    expect(postCount).toBe(0);
  });

  it("rejects a retargeted collection before signing or POST", async () => {
    const { collection, expectedApproval } = collectionFixture();
    const migration = witnessMigration(0, collection.statement.boundary.scope_id);
    let postCount = 0;
    const fetchImpl = async (
      input: string | URL | Request,
      init?: RequestInit,
    ): Promise<Response> => {
      const request = new Request(input, init);
      if (request.method === "GET") {
        return Response.json({
          ...collection,
          statement: {
            ...collection.statement,
            destination_id: "authority-retargeted",
          },
        });
      }
      postCount += 1;
      return Response.json({ ok: true }, { status: 202 });
    };

    await expect(approveCheckpointWitnessCollection({
      baseUrl: "https://audit.example",
      mode: "pvp",
      unit: "peer-client",
      collectionId: collection.collection_id,
      witnessId: WITNESS_IDS[0],
      signer: (await standardBackend.importLegacySeed(
        WITNESS_SEEDS[0],
        expectedApproval.witness_key,
      )).signer,
      verificationKey: migration.key,
      keyHistory: migration.history,
      legacyAcceptUntilMs: Number.MAX_SAFE_INTEGER,
      maxClockSkewMs: 5_000,
      cryptoBackend: standardBackend,
      fetchImpl,
    })).rejects.toThrow(
      "invalid_checkpoint_witness_producer_authentication:statement_digest_mismatch",
    );
    expect(postCount).toBe(0);
  });
});
