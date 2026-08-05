import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

import {
  audit_benchmark_make_checkpoint_delivery_authentication,
  audit_experimental_sign_checkpoint_delivery_approval,
  audit_verify_checkpoint_delivery_authentication,
} from "../../../_build/js/release/build/x/game_audit/worker/worker.js";

type Witness = "W1" | "W2" | "W3" | "W4";
type Status = "Collecting" | "Ready" | "Expired";

interface Approval {
  statement_digest: string;
  witness_id: string;
  witness_key: string;
  digest: string;
  signature: string;
}

interface Authentication {
  version: 1;
  producer_id: string;
  producer_key: string;
  statement_digest: string;
  producer_signature: string;
  approvals: Approval[];
}

interface Policy {
  producer_id: string;
  producer_key: string;
  witnesses: Array<{ witness_id: string; witness_key: string }>;
  required_approvals: number;
}

interface Fixture {
  ok: true;
  policy: Policy;
  authentication: Authentication;
}

interface VerificationSuccess {
  ok: true;
  producer_id: string;
  approval_count: number;
}

interface VerificationFailure {
  ok: false;
  error: string;
}

interface ItfTrace {
  states: Array<Record<string, unknown>>;
}

const producerSeed =
  "000102030405060708090a0b0c0d0e0f" +
  "101112131415161718191a1b1c1d1e1f";
const witnessSeeds = [
  "202122232425262728292a2b2c2d2e2f" +
    "303132333435363738393a3b3c3d3e3f",
  "404142434445464748494a4b4c4d4e4f" +
    "505152535455565758595a5b5c5d5e5f",
  "606162636465666768696a6b6c6d6e6f" +
    "707172737475767778797a7b7c7d7e7f",
  "808182838485868788898a8b8c8d8e8f" +
    "909192939495969798999a9b9c9d9e9f",
];
const intruderSeed =
  "a0a1a2a3a4a5a6a7a8a9aaabacadaeaf" +
  "b0b1b2b3b4b5b6b7b8b9babbbcbdbebf";
const witnessIds: Witness[] = ["W1", "W2", "W3", "W4"];
const statement = {
  protocolVersion: 1,
  purpose: "quint-witness-mbt-v1",
  manifestDigest: "quint-model",
  scopeId: "scope-1",
  unitId: "witness-quorum",
  destinationId: "authority",
  epoch: 0,
  previousCheckpoint: "genesis",
  checkpointDigest: "checkpoint-0",
  canonicalEnvelope: "quint-witness-envelope-0",
};

function record(value: unknown, label: string): Record<string, unknown> {
  assert(value !== null && typeof value === "object" && !Array.isArray(value), label);
  return value as Record<string, unknown>;
}

function numberValue(value: unknown): number {
  if (typeof value === "number") return value;
  const encoded = record(value, "expected ITF integer")["#bigint"];
  assert(typeof encoded === "string", "expected ITF bigint string");
  const decoded = Number(encoded);
  assert(Number.isSafeInteger(decoded), "ITF integer exceeds host range");
  return decoded;
}

function variantTag(value: unknown): string {
  const tag = record(value, "expected ITF variant").tag;
  assert(typeof tag === "string", "expected ITF variant tag");
  return tag;
}

function setValues(value: unknown): unknown[] {
  const values = record(value, "expected ITF set")["#set"];
  assert(Array.isArray(values), "expected ITF set entries");
  return values;
}

function modelState(itfState: Record<string, unknown>) {
  const stateKey = Object.keys(itfState).find((key) => key.endsWith("::state"));
  assert(stateKey, "trace state is missing the witness protocol state");
  const state = record(itfState[stateKey], "expected witness protocol state");
  return {
    acceptedWitnesses: setValues(state.acceptedWitnesses)
      .map((value) => variantTag(value) as Witness)
      .sort(),
    classification: variantTag(state.classification),
    receiverAdvanced: state.receiverAdvanced,
    status: variantTag(state.status) as Status,
  };
}

function fixture(approvalCount: number): Fixture {
  return JSON.parse(
    audit_benchmark_make_checkpoint_delivery_authentication(
      producerSeed,
      "producer",
      witnessSeeds,
      witnessIds,
      3,
      approvalCount,
      statement.protocolVersion,
      statement.purpose,
      statement.manifestDigest,
      statement.scopeId,
      statement.unitId,
      statement.destinationId,
      statement.epoch,
      statement.previousCheckpoint,
      statement.checkpointDigest,
      statement.canonicalEnvelope,
    ),
  ) as Fixture;
}

function verify(
  policy: Policy,
  authentication: Authentication,
): VerificationSuccess | VerificationFailure {
  return JSON.parse(
    audit_verify_checkpoint_delivery_authentication(
      statement.protocolVersion,
      statement.purpose,
      statement.manifestDigest,
      statement.scopeId,
      statement.unitId,
      statement.destinationId,
      statement.epoch,
      statement.previousCheckpoint,
      statement.checkpointDigest,
      statement.canonicalEnvelope,
      policy.producer_id,
      policy.producer_key,
      policy.witnesses.map((witness) => witness.witness_id),
      policy.witnesses.map((witness) => witness.witness_key),
      policy.required_approvals,
      authentication.producer_id,
      authentication.producer_key,
      authentication.statement_digest,
      authentication.producer_signature,
      authentication.approvals.map((approval) => approval.statement_digest),
      authentication.approvals.map((approval) => approval.witness_id),
      authentication.approvals.map((approval) => approval.witness_key),
      authentication.approvals.map((approval) => approval.digest),
      authentication.approvals.map((approval) => approval.signature),
    ),
  ) as VerificationSuccess | VerificationFailure;
}

function expectFailure(
  value: VerificationSuccess | VerificationFailure,
  error: string,
): void {
  assert.deepEqual(value, { ok: false, error });
}

function mutateSignature(approval: Approval): Approval {
  const last = approval.signature.at(-1);
  assert(last, "fixture signature is empty");
  return {
    ...approval,
    signature: approval.signature.slice(0, -1) + (last === "0" ? "1" : "0"),
  };
}

function compareProjection(
  itfState: Record<string, unknown>,
  acceptedWitnesses: Witness[],
  receiverAdvanced: boolean,
  action: string,
): void {
  const model = modelState(itfState);
  assert.deepEqual(
    [...acceptedWitnesses].sort(),
    model.acceptedWitnesses,
    `${action}: accepted witness set diverged`,
  );
  assert.equal(
    acceptedWitnesses.length >= 3 ? "Ready" : "Collecting",
    model.status,
    `${action}: collection status diverged`,
  );
  assert.equal(model.classification, "Unclassified");
  assert.equal(
    receiverAdvanced,
    model.receiverAdvanced,
    `${action}: receiver gate diverged`,
  );
}

function replayTrace(trace: ItfTrace): void {
  assert.equal(trace.states.length, 12, "witness MBT driver trace did not complete");
  const base = fixture(0);
  const acceptedWitnesses: Witness[] = [];
  let receiverAdvanced = false;

  for (const [index, itfState] of trace.states.entries()) {
    const action = itfState["mbt::actionTaken"];
    assert(typeof action === "string", "trace is missing mbt::actionTaken");
    if (index === 0) {
      assert.equal(action, "init");
    } else if (action.startsWith("send")) {
      // The model owns the transport soup; the host projection starts at verify.
    } else if (action === "deliverIntruder") {
      const signed = JSON.parse(
        audit_experimental_sign_checkpoint_delivery_approval(
          intruderSeed,
          "Intruder",
          base.authentication.statement_digest,
        ),
      ) as { ok: true; approval: Approval };
      assert.equal(signed.ok, true);
      expectFailure(
        verify(base.policy, {
          ...base.authentication,
          approvals: [signed.approval],
        }),
        "unknown_witness",
      );
    } else if (action === "deliverInvalidW2") {
      const candidate = fixture(2);
      candidate.authentication.approvals[1] = mutateSignature(
        candidate.authentication.approvals[1],
      );
      expectFailure(
        verify(candidate.policy, candidate.authentication),
        "invalid_witness_signature",
      );
    } else if (action === "deliverW1" || action === "deliverW2") {
      const witness = action === "deliverW1" ? "W1" : "W2";
      const candidate = fixture(acceptedWitnesses.length + 1);
      expectFailure(
        verify(candidate.policy, candidate.authentication),
        "under_quorum",
      );
      acceptedWitnesses.push(witness);
    } else if (action === "deliverW3") {
      const candidate = fixture(3);
      assert.deepEqual(verify(candidate.policy, candidate.authentication), {
        ok: true,
        producer_id: "producer",
        approval_count: 3,
      });
      acceptedWitnesses.push("W3");
    } else if (action === "advanceReceiver") {
      const candidate = fixture(acceptedWitnesses.length);
      assert.equal(verify(candidate.policy, candidate.authentication).ok, true);
      receiverAdvanced = true;
    } else {
      assert.fail(`unsupported witness MBT action: ${action}`);
    }
    compareProjection(itfState, acceptedWitnesses, receiverAdvanced, action);
  }
  assert.equal(numberValue(trace.states.at(-1)!.phase), 11);
}

const traceDirectory = process.argv[2];
assert(traceDirectory, "usage: quint-witness-mbt.ts TRACE_DIRECTORY");
const files = (await readdir(traceDirectory))
  .filter((file) => file.endsWith(".itf.json"))
  .sort();
assert(files.length > 0, "Quint did not generate any witness ITF traces");
for (const file of files) {
  const trace = JSON.parse(
    await readFile(join(traceDirectory, file), "utf8"),
  ) as ItfTrace;
  replayTrace(trace);
}
console.log(`replayed ${files.length} Quint witness trace(s) against MoonBit authentication`);
