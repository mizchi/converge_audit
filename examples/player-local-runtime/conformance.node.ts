import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";

import type {
  PlayerLocalAuditImage,
  PlayerLocalAuditStorage,
  PlayerLocalEvidenceInboxWriteSet,
  PlayerLocalSealWriteSet,
  PlayerLocalStoreConfiguration,
} from "./contracts.ts";
import { MoonBitCheckpointPolicy } from "./moonbit-checkpoint-policy.ts";

export interface PlayerLocalStorageConformanceFixture {
  configuration: PlayerLocalStoreConfiguration;
  open(): Promise<PlayerLocalAuditStorage>;
}

export type PlayerLocalStorageConformanceFactory = (
  context: TestContext,
  outboxCapacity: number,
) => Promise<PlayerLocalStorageConformanceFixture>;

function writeSet(
  image: PlayerLocalAuditImage,
  destinations: string[],
  digest: string,
): PlayerLocalSealWriteSet {
  const boundary = image.boundary;
  const epoch = image.head.epoch + 1;
  const activeOutboxCount = image.outbox.filter(
    (entry) => entry.state.kind !== "acknowledged",
  ).length;
  return {
    expected_revision: image.storage_revision,
    expected_snapshot: {
      boundary,
      current_epoch: image.head.epoch,
      current_digest: image.head.checkpoint_digest,
      incoming_epoch_known: false,
      known_digest_matches: false,
      known_seal_complete: false,
      closure_consumed: false,
      outbox_entry_count: activeOutboxCount,
      outbox_capacity: image.outbox_capacity,
      next_created_order: image.next_created_order,
    },
    checkpoint: {
      boundary,
      epoch,
      previous_checkpoint: image.head.checkpoint_digest,
      checkpoint_digest: digest,
      canonical_envelope: `envelope:${digest}`,
    },
    next_head: { boundary, epoch, checkpoint_digest: digest },
    outbox_entries: destinations.map((destination_id, index) => ({
      boundary,
      destination_id,
      epoch,
      checkpoint_digest: digest,
      canonical_envelope: `envelope:${digest}`,
      created_order: image.next_created_order + index,
      state: { kind: "pending" },
    })),
    consumed_closure: {
      boundary,
      epoch,
      roster_digest: "roster",
      frontier_digest: `frontier:${epoch}`,
      certificate_digest: `certificate:${epoch}`,
    },
    next_outbox_entry_count: activeOutboxCount + destinations.length,
    next_created_order: image.next_created_order + destinations.length,
  };
}

export function runPlayerLocalStorageConformance(
  adapterName: string,
  createFixture: PlayerLocalStorageConformanceFactory,
): void {
  test(`${adapterName} conformance: restart retains sealed pending outbox`, async (t) => {
    const fixture = await createFixture(t, 2);
    const store = await fixture.open();
    const initial = await store.image();
    assert.deepEqual(
      await store.commitSeal(writeSet(initial, ["authority"], "checkpoint-0")),
      { decision: "committed" },
    );
    await store.close();
    const restarted = await fixture.open();
    const image = await restarted.image();
    assert.equal(image.head.checkpoint_digest, "checkpoint-0");
    assert.deepEqual(image.outbox[0]?.state, { kind: "pending" });
    await restarted.close();
  });

  test(`${adapterName} conformance: all seal fault points roll back`, async (t) => {
    const fixture = await createFixture(t, 2);
    const store = await fixture.open();
    const before = await store.image();
    for (
      const point of [
        "after_history",
        "after_head",
        "after_outbox",
        "after_closure",
      ] as const
    ) {
      await assert.rejects(Promise.resolve().then(() => store.commitSeal(
        writeSet(before, ["authority"], "checkpoint-0"),
        point,
      )));
      assert.deepEqual(await store.image(), before);
    }
    await store.close();
  });

  test(`${adapterName} conformance: stale revision changes no relation`, async (t) => {
    const fixture = await createFixture(t, 2);
    const store = await fixture.open();
    const stale = writeSet(
      await store.image(),
      ["authority"],
      "checkpoint-0",
    );
    const boundary = fixture.configuration.boundary;
    assert.deepEqual(await store.admitEvent({
      boundary,
      author_id: "alice",
      counter: 0,
      epoch: 0,
      event_digest: "event-0",
      canonical_event: "event:event-0",
    }), { decision: "stored" });
    const before = await store.image();
    assert.deepEqual(await store.commitSeal(stale), {
      decision: "concurrent_write",
    });
    assert.deepEqual(await store.image(), before);
    await store.close();
  });

  test(`${adapterName} conformance: ACK frees capacity but keeps evidence`, async (t) => {
    const fixture = await createFixture(t, 1);
    const store = await fixture.open();
    assert.deepEqual(await store.commitSeal(writeSet(
      await store.image(),
      ["authority"],
      "checkpoint-0",
    )), { decision: "committed" });
    assert(await store.claimOutbox(0, 100, 30));
    assert.deepEqual(await store.acknowledgeOutbox({
      boundary: fixture.configuration.boundary,
      authority_id: "authority",
      epoch: 0,
      checkpoint_digest: "checkpoint-0",
      decision: "accepted",
    }), { decision: "updated" });
    assert.deepEqual(await store.commitSeal(writeSet(
      await store.image(),
      ["authority"],
      "checkpoint-1",
    )), { decision: "committed" });
    const image = await store.image();
    assert.equal(image.outbox.length, 2);
    assert.equal(image.ack_history.length, 1);
    await store.close();
  });

  test(`${adapterName} conformance: pruning advances a durable prefix anchor`, async (t) => {
    const fixture = await createFixture(t, 2);
    const store = await fixture.open();
    const policy = await MoonBitCheckpointPolicy.load();
    assert.deepEqual(await store.commitSeal(writeSet(
      await store.image(),
      ["authority"],
      "checkpoint-0",
    )), { decision: "committed" });
    assert.deepEqual(await store.acknowledgeOutbox({
      boundary: fixture.configuration.boundary,
      authority_id: "authority",
      epoch: 0,
      checkpoint_digest: "checkpoint-0",
      decision: "accepted",
    }), { decision: "updated" });
    assert.deepEqual(await store.commitSeal(writeSet(
      await store.image(),
      ["authority"],
      "checkpoint-1",
    )), { decision: "committed" });

    const prepared = policy.preparePruneWriteSet(await store.image(), {
      retain_from_epoch: 1,
      protected_epochs: [],
    });
    assert.equal(prepared.decision, "prepared");
    if (prepared.decision !== "prepared") return;
    assert.deepEqual(await store.pruneEvidence(prepared.write_set), {
      decision: "pruned",
      pruned_through_epoch: 0,
    });
    await store.close();

    const restarted = await fixture.open();
    const image = await restarted.image();
    assert.deepEqual(image.retention_anchor, {
      boundary: fixture.configuration.boundary,
      epoch: 0,
      checkpoint_digest: "checkpoint-0",
    });
    assert.deepEqual(image.checkpoints.map((checkpoint) => checkpoint.epoch), [1]);
    assert.deepEqual(image.outbox.map((entry) => entry.epoch), [1]);
    assert.equal(image.ack_history.length, 0);
    assert.equal(image.head.epoch, 1);
    assert.deepEqual(await restarted.admitEvent({
      boundary: fixture.configuration.boundary,
      author_id: "late-peer",
      counter: 99,
      epoch: 0,
      event_digest: "late-pruned-event",
      canonical_event: "event:late-pruned-event",
    }), { decision: "refused", reason: "pruned_epoch" });
    assert.deepEqual(await restarted.image(), image);
    assert.deepEqual(policy.preparePruneWriteSet(image, {
      retain_from_epoch: 1,
      protected_epochs: [0],
    }), {
      decision: "refused",
      reason: "protected_epoch_already_pruned",
    });
    await restarted.close();
  });

  test(`${adapterName} conformance: pruning stops before unACKed and protected evidence`, async (t) => {
    const fixture = await createFixture(t, 3);
    const store = await fixture.open();
    const policy = await MoonBitCheckpointPolicy.load();
    for (let epoch = 0; epoch < 2; epoch += 1) {
      assert.deepEqual(await store.commitSeal(writeSet(
        await store.image(),
        ["authority"],
        `checkpoint-${epoch}`,
      )), { decision: "committed" });
      assert.deepEqual(await store.acknowledgeOutbox({
        boundary: fixture.configuration.boundary,
        authority_id: "authority",
        epoch,
        checkpoint_digest: `checkpoint-${epoch}`,
        decision: "accepted",
      }), { decision: "updated" });
    }

    const protectedResult = policy.preparePruneWriteSet(await store.image(), {
      retain_from_epoch: 2,
      protected_epochs: [0],
    });
    assert.deepEqual(protectedResult, {
      decision: "no_change",
      reason: "protected_epoch",
    });

    const first = policy.preparePruneWriteSet(await store.image(), {
      retain_from_epoch: 1,
      protected_epochs: [],
    });
    assert.equal(first.decision, "prepared");
    if (first.decision !== "prepared") return;
    assert.deepEqual(await store.pruneEvidence(first.write_set), {
      decision: "pruned",
      pruned_through_epoch: 0,
    });

    assert.deepEqual(await store.commitSeal(writeSet(
      await store.image(),
      ["authority"],
      "checkpoint-2",
    )), { decision: "committed" });
    const blocked = policy.preparePruneWriteSet(await store.image(), {
      retain_from_epoch: 3,
      protected_epochs: [],
    });
    assert.equal(blocked.decision, "prepared");
    if (blocked.decision !== "prepared") return;
    assert.equal(blocked.write_set.next_anchor.epoch, 1);
    await store.close();
  });

  test(`${adapterName} conformance: stale and faulted pruning changes no relation`, async (t) => {
    const fixture = await createFixture(t, 2);
    const store = await fixture.open();
    const policy = await MoonBitCheckpointPolicy.load();
    assert.deepEqual(await store.commitSeal(writeSet(
      await store.image(),
      ["authority"],
      "checkpoint-0",
    )), { decision: "committed" });
    assert.deepEqual(await store.acknowledgeOutbox({
      boundary: fixture.configuration.boundary,
      authority_id: "authority",
      epoch: 0,
      checkpoint_digest: "checkpoint-0",
      decision: "accepted",
    }), { decision: "updated" });
    const prepared = policy.preparePruneWriteSet(await store.image(), {
      retain_from_epoch: 1,
      protected_epochs: [],
    });
    assert.equal(prepared.decision, "prepared");
    if (prepared.decision !== "prepared") return;

    for (
      const point of [
        "after_events",
        "after_checkpoints",
        "after_outbox",
        "after_anchor",
      ] as const
    ) {
      const before = await store.image();
      await assert.rejects(Promise.resolve().then(() =>
        store.pruneEvidence(prepared.write_set, point)
      ));
      assert.deepEqual(await store.image(), before);
    }
    assert.deepEqual(await store.admitEvent({
      boundary: fixture.configuration.boundary,
      author_id: "alice",
      counter: 10,
      epoch: 0,
      event_digest: "late-event",
      canonical_event: "event:late-event",
    }), { decision: "stored" });
    const beforeStale = await store.image();
    assert.deepEqual(await store.pruneEvidence(prepared.write_set), {
      decision: "concurrent_write",
    });
    assert.deepEqual(await store.image(), beforeStale);
    await store.close();
  });

  test(`${adapterName} conformance: equivocation pins its checkpoint evidence`, async (t) => {
    const fixture = await createFixture(t, 2);
    const store = await fixture.open();
    const policy = await MoonBitCheckpointPolicy.load();
    const boundary = fixture.configuration.boundary;
    const baseEvent = {
      boundary,
      author_id: "alice",
      counter: 0,
      epoch: 0,
      event_digest: "event-0",
      canonical_event: "event:event-0",
    };
    assert.deepEqual(await store.admitEvent(baseEvent), { decision: "stored" });
    assert.deepEqual(await store.admitEvent({
      ...baseEvent,
      event_digest: "event-fork",
      canonical_event: "event:event-fork",
    }), { decision: "equivocation" });
    assert.deepEqual(await store.commitSeal(writeSet(
      await store.image(),
      ["authority"],
      "checkpoint-0",
    )), { decision: "committed" });
    assert.deepEqual(await store.acknowledgeOutbox({
      boundary,
      authority_id: "authority",
      epoch: 0,
      checkpoint_digest: "checkpoint-0",
      decision: "accepted",
    }), { decision: "updated" });
    assert.deepEqual(policy.preparePruneWriteSet(await store.image(), {
      retain_from_epoch: 1,
      protected_epochs: [],
    }), { decision: "no_change", reason: "protected_epoch" });
    await store.close();
  });

  test(`${adapterName} conformance: durable evidence hold blocks pruning until resolution`, async (t) => {
    const fixture = await createFixture(t, 2);
    const store = await fixture.open();
    const policy = await MoonBitCheckpointPolicy.load();
    const boundary = fixture.configuration.boundary;
    assert.deepEqual(await store.commitSeal(writeSet(
      await store.image(),
      ["authority"],
      "checkpoint-0",
    )), { decision: "committed" });
    assert.deepEqual(await store.acknowledgeOutbox({
      boundary,
      authority_id: "authority",
      epoch: 0,
      checkpoint_digest: "checkpoint-0",
      decision: "accepted",
    }), { decision: "updated" });
    const stalePrune = policy.preparePruneWriteSet(await store.image(), {
      retain_from_epoch: 1,
      protected_epochs: [],
    });
    assert.equal(stalePrune.decision, "prepared");
    if (stalePrune.decision !== "prepared") return;
    const hold = {
      boundary,
      hold_id: "challenge-0",
      epoch: 0,
      checkpoint_digest: "checkpoint-0",
      kind: "challenge" as const,
      reference_digest: "challenge-reference-0",
      state: { kind: "active" as const },
    };
    assert.deepEqual(await store.placeEvidenceHold(hold), {
      decision: "stored",
    });
    assert.deepEqual(await store.placeEvidenceHold(hold), {
      decision: "duplicate",
    });
    const afterHold = await store.image();
    assert.deepEqual(await store.pruneEvidence(stalePrune.write_set), {
      decision: "concurrent_write",
    });
    assert.deepEqual(await store.image(), afterHold);
    assert.deepEqual(await store.placeEvidenceHold({
      ...hold,
      reference_digest: "conflicting-reference",
    }), { decision: "refused", reason: "hold_conflict" });
    assert.deepEqual(policy.preparePruneWriteSet(afterHold, {
      retain_from_epoch: 1,
      protected_epochs: [],
    }), { decision: "no_change", reason: "protected_epoch" });
    await store.close();

    const restarted = await fixture.open();
    assert.deepEqual(policy.preparePruneWriteSet(await restarted.image(), {
      retain_from_epoch: 1,
      protected_epochs: [],
    }), { decision: "no_change", reason: "protected_epoch" });
    assert.deepEqual(await restarted.resolveEvidenceHold({
      boundary,
      hold_id: "challenge-0",
      epoch: 0,
      checkpoint_digest: "checkpoint-0",
      reference_digest: "wrong-reference",
      decision: "dismissed",
      resolution_digest: "resolution-0",
    }), { decision: "refused", reason: "hold_mismatch" });
    assert.deepEqual(await restarted.resolveEvidenceHold({
      boundary,
      hold_id: "challenge-0",
      epoch: 0,
      checkpoint_digest: "checkpoint-0",
      reference_digest: "challenge-reference-0",
      decision: "dismissed",
      resolution_digest: "resolution-0",
    }), { decision: "resolved" });
    const resolved = await restarted.image();
    assert.deepEqual(resolved.evidence_holds[0]?.state, {
      kind: "resolved",
      decision: "dismissed",
      resolution_digest: "resolution-0",
    });
    const prepared = policy.preparePruneWriteSet(resolved, {
      retain_from_epoch: 1,
      protected_epochs: [],
    });
    assert.equal(prepared.decision, "prepared");
    if (prepared.decision !== "prepared") return;
    assert.deepEqual(await restarted.pruneEvidence(prepared.write_set), {
      decision: "pruned",
      pruned_through_epoch: 0,
    });
    assert.equal((await restarted.image()).evidence_holds.length, 0);
    await restarted.close();
  });

  test(`${adapterName} conformance: evidence inbox atomically applies a hash-chain cursor`, async (t) => {
    const fixture = await createFixture(t, 2);
    const store = await fixture.open();
    const boundary = fixture.configuration.boundary;
    assert.deepEqual(await store.commitSeal(writeSet(
      await store.image(),
      ["authority"],
      "checkpoint-0",
    )), { decision: "committed" });
    const before = await store.image();
    const place: PlayerLocalEvidenceInboxWriteSet = {
      expected_revision: before.storage_revision,
      expected_cursor: {
        boundary,
        source_id: "authority-a",
        sequence: -1,
        message_digest: "inbox-genesis",
      },
      next_cursor: {
        boundary,
        source_id: "authority-a",
        sequence: 0,
        message_digest: "message-digest-0",
      },
      message_id: "challenge-0",
      operation: {
        kind: "place",
        hold: {
          boundary,
          hold_id: "challenge-0",
          epoch: 0,
          checkpoint_digest: "checkpoint-0",
          kind: "challenge",
          reference_digest: "challenge-reference-0",
          state: { kind: "active" },
        },
      },
    };
    for (const point of ["after_hold", "after_cursor"] as const) {
      await assert.rejects(Promise.resolve().then(() =>
        store.applyEvidenceInbox(place, point)
      ));
      assert.deepEqual(await store.image(), before);
    }
    assert.deepEqual(await store.applyEvidenceInbox(place), {
      decision: "applied",
    });
    assert.deepEqual(await store.applyEvidenceInbox(place), {
      decision: "concurrent_write",
    });
    await store.close();

    const restarted = await fixture.open();
    const placed = await restarted.image();
    assert.deepEqual(placed.evidence_inbox_cursors, [place.next_cursor]);
    assert.equal(placed.evidence_holds[0]?.state.kind, "active");
    const resolve: PlayerLocalEvidenceInboxWriteSet = {
      expected_revision: placed.storage_revision,
      expected_cursor: place.next_cursor,
      next_cursor: {
        boundary,
        source_id: "authority-a",
        sequence: 1,
        message_digest: "message-digest-1",
      },
      message_id: "challenge-0",
      operation: {
        kind: "resolve",
        resolution: {
          boundary,
          hold_id: "challenge-0",
          epoch: 0,
          checkpoint_digest: "checkpoint-0",
          reference_digest: "challenge-reference-0",
          decision: "dismissed",
          resolution_digest: "resolution-0",
        },
      },
    };
    const badResolve: PlayerLocalEvidenceInboxWriteSet = {
      ...resolve,
      operation: {
        kind: "resolve",
        resolution: {
          ...(resolve.operation.kind === "resolve"
            ? resolve.operation.resolution
            : assert.fail("expected resolution")),
          reference_digest: "wrong-reference",
        },
      },
    };
    assert.deepEqual(await restarted.applyEvidenceInbox(badResolve), {
      decision: "refused",
      reason: "invalid_write_set",
    });
    assert.deepEqual(await restarted.image(), placed);
    assert.deepEqual(await restarted.applyEvidenceInbox(resolve), {
      decision: "applied",
    });
    const resolved = await restarted.image();
    assert.deepEqual(resolved.evidence_inbox_cursors, [resolve.next_cursor]);
    assert.deepEqual(resolved.evidence_holds[0]?.state, {
      kind: "resolved",
      decision: "dismissed",
      resolution_digest: "resolution-0",
    });
    const placeAfterResolution: PlayerLocalEvidenceInboxWriteSet = {
      expected_revision: resolved.storage_revision,
      expected_cursor: resolve.next_cursor,
      next_cursor: {
        boundary,
        source_id: "authority-a",
        sequence: 2,
        message_digest: "message-digest-2",
      },
      message_id: place.message_id,
      operation: place.operation,
    };
    assert.deepEqual(
      await restarted.applyEvidenceInbox(placeAfterResolution),
      { decision: "refused", reason: "invalid_write_set" },
    );
    assert.deepEqual(await restarted.image(), resolved);
    await restarted.close();
  });

  test(`${adapterName} conformance: evidence poll lease is fenced, restartable, and terminal`, async (t) => {
    const fixture = await createFixture(t, 2);
    let store = await fixture.open();
    const boundary = fixture.configuration.boundary;
    const draft = {
      boundary,
      source_id: "authority-a",
      endpoint: "https://authority.example/evidence/poll",
      initial_message_digest: "inbox-genesis",
      deadline_at_ms: 500,
      next_poll_at_ms: 100,
    };
    assert.deepEqual(await store.scheduleEvidencePollJob(draft), {
      decision: "stored",
    });
    assert.deepEqual(await store.scheduleEvidencePollJob(draft), {
      decision: "duplicate",
    });
    assert.deepEqual(await store.scheduleEvidencePollJob({
      ...draft,
      endpoint: "https://conflict.example/evidence/poll",
    }), { decision: "refused", reason: "source_conflict" });
    assert.deepEqual(await store.claimEvidencePollJob("authority-a", 99, 100), {
      decision: "not_due",
    });
    const first = await store.claimEvidencePollJob("authority-a", 100, 100);
    assert.equal(first.decision, "claimed");
    if (first.decision !== "claimed") return;
    assert.equal(first.job.attempt_count, 1);
    assert.deepEqual(first.job.state, {
      kind: "in_flight",
      lease_expires_at_ms: 200,
    });
    assert.deepEqual(await store.claimEvidencePollJob("authority-a", 150, 100), {
      decision: "not_due",
    });
    await store.close();

    store = await fixture.open();
    const recovered = await store.claimEvidencePollJob("authority-a", 200, 100);
    assert.equal(recovered.decision, "claimed");
    if (recovered.decision !== "claimed") return;
    assert.equal(recovered.job.attempt_count, 2);
    assert.deepEqual(recovered.job.state, {
      kind: "in_flight",
      lease_expires_at_ms: 300,
    });
    const beforeStaleCompletion = await store.image();
    assert.deepEqual(await store.completeEvidencePollJob({
      source_id: "authority-a",
      expected_attempt_count: 1,
      expected_lease_expires_at_ms: 200,
      completed_at_ms: 250,
      next_poll_at_ms: 300,
      failures: 1,
    }), { decision: "concurrent_write" });
    assert.deepEqual(await store.image(), beforeStaleCompletion);
    assert.deepEqual(await store.completeEvidencePollJob({
      source_id: "authority-a",
      expected_attempt_count: 2,
      expected_lease_expires_at_ms: 300,
      completed_at_ms: 250,
      next_poll_at_ms: 300,
      failures: 1,
    }), { decision: "updated" });
    const third = await store.claimEvidencePollJob("authority-a", 300, 100);
    assert.equal(third.decision, "claimed");
    if (third.decision !== "claimed") return;
    assert.equal(third.job.attempt_count, 3);
    assert.deepEqual(await store.completeEvidencePollJob({
      source_id: "authority-a",
      expected_attempt_count: 3,
      expected_lease_expires_at_ms: 400,
      completed_at_ms: 350,
      next_poll_at_ms: 370,
      failures: 0,
    }), { decision: "updated" });

    assert.deepEqual(await store.commitSeal(writeSet(
      await store.image(),
      ["authority"],
      "checkpoint-0",
    )), { decision: "committed" });
    assert.deepEqual(await store.placeEvidenceHold({
      boundary,
      hold_id: "challenge-0",
      epoch: 0,
      checkpoint_digest: "checkpoint-0",
      kind: "challenge",
      reference_digest: "challenge-reference-0",
      state: { kind: "active" },
    }), { decision: "stored" });
    assert.deepEqual(await store.claimEvidencePollJob("authority-a", 500, 100), {
      decision: "terminal",
      state: "expired",
    });
    let image = await store.image();
    assert.deepEqual(image.evidence_poll_jobs[0]?.state, {
      kind: "expired",
      expired_at_ms: 500,
    });
    assert.equal(image.evidence_holds[0]?.state.kind, "active");

    const escalatedDraft = {
      ...draft,
      source_id: "authority-b",
      deadline_at_ms: 900,
      next_poll_at_ms: 600,
    };
    assert.deepEqual(await store.scheduleEvidencePollJob(escalatedDraft), {
      decision: "stored",
    });
    assert.deepEqual(
      await store.escalateEvidencePollJob(
        "authority-b",
        550,
        "operator-case-digest",
      ),
      { decision: "updated" },
    );
    assert.deepEqual(
      await store.escalateEvidencePollJob(
        "authority-b",
        551,
        "operator-case-digest",
      ),
      { decision: "no_change" },
    );
    assert.deepEqual(await store.claimEvidencePollJob("authority-b", 600, 100), {
      decision: "terminal",
      state: "escalated",
    });
    image = await store.image();
    assert.equal(image.evidence_holds[0]?.state.kind, "active");
    await store.close();
  });
}
