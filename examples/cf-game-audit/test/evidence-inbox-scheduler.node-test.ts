import assert from "node:assert/strict";
import test from "node:test";
import { IDBFactory } from "fake-indexeddb";

import type {
  AuditBoundary,
  PlayerLocalStoreConfiguration,
} from "../../player-local-runtime/contracts.ts";
import {
  runPlayerLocalEvidencePollSchedulerOnce,
} from "../web/src/audit/evidence-inbox-scheduler.ts";
import {
  BrowserPlayerLocalCheckpointRuntime,
} from "../web/src/audit/player-local-checkpoint-runtime.ts";

const boundary: AuditBoundary = {
  protocol_version: 1,
  purpose: "checkpoint-v1",
  manifest_digest: "manifest-scheduler",
  scope_id: "player-alice",
  unit_id: "match-scheduler",
};

const configuration: PlayerLocalStoreConfiguration = {
  boundary,
  genesis_digest: "genesis",
  outbox_capacity: 1,
};

const sourceId = "authority-a";
const initialMessageDigest = "inbox-genesis";

function page() {
  return {
    version: 1,
    source_id: sourceId,
    after_sequence: -1,
    after_message_digest: initialMessageDigest,
    messages: [],
  };
}

async function fixture(
  deadlineAtMs = 1_000,
  withHold = false,
  nextPollAtMs = 100,
) {
  const factory = new IDBFactory();
  const databaseName = `evidence-scheduler-${crypto.randomUUID()}`;
  const open = () => BrowserPlayerLocalCheckpointRuntime.open({
    factory,
    databaseName,
    configuration,
  });
  const runtime = await open();
  assert.deepEqual(await runtime.scheduleEvidencePollJob({
    boundary,
    source_id: sourceId,
    endpoint: "https://audit.example/evidence-inbox",
    initial_message_digest: initialMessageDigest,
    deadline_at_ms: deadlineAtMs,
    next_poll_at_ms: nextPollAtMs,
  }), { decision: "stored" });
  if (withHold) {
    assert.deepEqual(await runtime.seal({
      boundary,
      epoch: 0,
      previous_checkpoint: "genesis",
      checkpoint_digest: "checkpoint-0",
      canonical_envelope: "envelope:checkpoint-0",
    }, {
      boundary,
      epoch: 0,
      roster_digest: "roster",
      frontier_digest: "frontier",
      certificate_digest: "certificate",
    }, ["authority"]), { decision: "committed" });
    assert.deepEqual(await runtime.placeEvidenceHold({
      hold: {
        boundary,
        hold_id: "challenge-0",
        epoch: 0,
        checkpoint_digest: "checkpoint-0",
        kind: "challenge",
        reference_digest: "challenge-reference-0",
        state: { kind: "active" },
      },
      authenticationSucceeded: true,
    }), { decision: "stored" });
  }
  return { runtime, open };
}

function schedulerInput(
  runtime: BrowserPlayerLocalCheckpointRuntime,
  now: () => number,
  fetcher: typeof fetch,
) {
  return {
    runtime,
    sourceId,
    authenticator: { verify: () => true },
    successIntervalMs: 200,
    baseBackoffMs: 100,
    maxBackoffMs: 800,
    leaseDurationMs: 100,
    maxMessagesPerPage: 2,
    maxResponseBytes: 16_384,
    requestTimeoutMs: 50,
    now,
    fetcher,
  };
}

test("durable evidence scheduler runs only due work and persists capped backoff", async () => {
  const { runtime } = await fixture();
  let clock = 99;
  let calls = 0;
  let fail = false;
  const fetcher = (async () => {
    calls += 1;
    return fail ? new Response("unavailable", { status: 503 }) : Response.json(page());
  }) as typeof fetch;
  const input = schedulerInput(runtime, () => clock, fetcher);

  assert.deepEqual(await runPlayerLocalEvidencePollSchedulerOnce(input), {
    decision: "idle",
    reason: "not_due",
  });
  assert.equal(calls, 0);
  clock = 100;
  assert.deepEqual(await runPlayerLocalEvidencePollSchedulerOnce(input), {
    decision: "completed",
    poll_result: {
      decision: "no_change",
      applied_messages: 0,
      last_sequence: -1,
    },
    failures: 0,
    next_poll_at_ms: 300,
  });
  fail = true;
  clock = 300;
  assert.deepEqual(await runPlayerLocalEvidencePollSchedulerOnce(input), {
    decision: "completed",
    poll_result: {
      decision: "refused",
      reason: "http_error",
      applied_messages: 0,
      http_status: 503,
    },
    failures: 1,
    next_poll_at_ms: 400,
  });
  clock = 400;
  assert.deepEqual(await runPlayerLocalEvidencePollSchedulerOnce(input), {
    decision: "completed",
    poll_result: {
      decision: "refused",
      reason: "http_error",
      applied_messages: 0,
      http_status: 503,
    },
    failures: 2,
    next_poll_at_ms: 600,
  });
  const job = (await runtime.image()).evidence_poll_jobs[0]!;
  assert.equal(job.failures, 2);
  assert.equal(job.next_poll_at_ms, 600);
  runtime.close();
});

test("durable evidence scheduler recovers an expired lease after restart", async () => {
  const { runtime, open } = await fixture();
  assert.equal(
    (await runtime.claimEvidencePollJob(sourceId, 100, 100)).decision,
    "claimed",
  );
  runtime.close();
  const restarted = await open();
  let clock = 150;
  const input = schedulerInput(
    restarted,
    () => clock,
    (async () => Response.json(page())) as typeof fetch,
  );
  assert.deepEqual(await runPlayerLocalEvidencePollSchedulerOnce(input), {
    decision: "idle",
    reason: "not_due",
  });
  clock = 200;
  const result = await runPlayerLocalEvidencePollSchedulerOnce(input);
  assert.equal(result.decision, "completed");
  assert.equal((await restarted.image()).evidence_poll_jobs[0]?.attempt_count, 2);
  restarted.close();
});

test("durable evidence scheduler expires at deadline and never releases a hold", async () => {
  const { runtime } = await fixture(150, true);
  let clock = 100;
  const input = schedulerInput(
    runtime,
    () => clock,
    (async () => {
      clock = 150;
      return Response.json(page());
    }) as typeof fetch,
  );
  const result = await runPlayerLocalEvidencePollSchedulerOnce(input);
  assert.equal(result.decision, "terminal");
  const image = await runtime.image();
  assert.deepEqual(image.evidence_poll_jobs[0]?.state, {
    kind: "expired",
    expired_at_ms: 150,
  });
  assert.equal(image.evidence_holds[0]?.state.kind, "active");
  runtime.close();
});

test("durable evidence scheduler cannot complete after another claimant fences it", async () => {
  const { runtime } = await fixture();
  let clock = 100;
  const input = schedulerInput(
    runtime,
    () => clock,
    (async () => {
      clock = 200;
      assert.equal(
        (await runtime.claimEvidencePollJob(sourceId, clock, 100)).decision,
        "claimed",
      );
      return Response.json(page());
    }) as typeof fetch,
  );
  const result = await runPlayerLocalEvidencePollSchedulerOnce(input);
  assert.equal(result.decision, "lost_lease");
  assert.equal((await runtime.image()).evidence_poll_jobs[0]?.attempt_count, 2);
  runtime.close();
});

test("durable evidence scheduler normalizes absolute Unix milliseconds for MoonBit", async () => {
  const clock = Date.now();
  const { runtime } = await fixture(clock + 1_000, false, clock);
  const result = await runPlayerLocalEvidencePollSchedulerOnce(schedulerInput(
    runtime,
    () => clock,
    (async () => Response.json(page())) as typeof fetch,
  ));
  assert.equal(result.decision, "completed");
  assert.equal(
    (await runtime.image()).evidence_poll_jobs[0]?.next_poll_at_ms,
    clock + 200,
  );
  runtime.close();
});
