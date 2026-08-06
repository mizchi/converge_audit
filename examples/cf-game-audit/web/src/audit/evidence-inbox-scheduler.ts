import type {
  PlayerLocalEvidenceHoldAuthenticator,
} from "../../../../player-local-runtime/evidence-hold-wire.ts";
import type {
  PlayerLocalEvidencePollJob,
} from "../../../../player-local-runtime/contracts.ts";
import {
  pollPlayerLocalEvidenceInbox,
  type PlayerLocalEvidenceInboxPollResult,
} from "./evidence-inbox-poller.ts";
import type {
  BrowserPlayerLocalCheckpointRuntime,
} from "./player-local-checkpoint-runtime.ts";

export interface PlayerLocalEvidencePollSchedulerInput {
  runtime: BrowserPlayerLocalCheckpointRuntime;
  sourceId: string;
  authenticator: PlayerLocalEvidenceHoldAuthenticator;
  successIntervalMs: number;
  baseBackoffMs: number;
  maxBackoffMs: number;
  leaseDurationMs: number;
  maxMessagesPerPage: number;
  maxResponseBytes: number;
  requestTimeoutMs: number;
  fetcher?: typeof fetch;
  now?: () => number;
}

export type PlayerLocalEvidencePollSchedulerResult =
  | { decision: "idle"; reason: "not_due" | "not_found" }
  | {
      decision: "terminal";
      state: "expired" | "escalated";
      poll_result?: PlayerLocalEvidenceInboxPollResult;
    }
  | {
      decision: "completed";
      poll_result: PlayerLocalEvidenceInboxPollResult;
      failures: number;
      next_poll_at_ms: number;
    }
  | {
      decision: "lost_lease";
      poll_result: PlayerLocalEvidenceInboxPollResult;
    }
  | {
      decision: "refused";
      reason: "invalid_configuration" | "storage_refused";
      storage_reason?: string;
    };

function positiveInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}

function configurationValid(
  input: PlayerLocalEvidencePollSchedulerInput,
): boolean {
  return input.sourceId.length > 0 &&
    input.sourceId.length <= 256 &&
    positiveInteger(input.successIntervalMs) &&
    positiveInteger(input.baseBackoffMs) &&
    positiveInteger(input.maxBackoffMs) &&
    input.maxBackoffMs >= input.baseBackoffMs &&
    positiveInteger(input.leaseDurationMs) &&
    positiveInteger(input.maxMessagesPerPage) &&
    input.maxMessagesPerPage <= 128 &&
    positiveInteger(input.maxResponseBytes) &&
    input.maxResponseBytes <= 1_048_576 &&
    positiveInteger(input.requestTimeoutMs) &&
    input.requestTimeoutMs <= 60_000 &&
    input.requestTimeoutMs <= input.leaseDurationMs;
}

function safeNow(now: () => number): number | undefined {
  try {
    const value = now();
    return Number.isSafeInteger(value) && value >= 0 ? value : undefined;
  } catch {
    return undefined;
  }
}

function claimedLease(
  job: PlayerLocalEvidencePollJob,
): number | undefined {
  return job.state.kind === "in_flight"
    ? job.state.lease_expires_at_ms
    : undefined;
}

/**
 * Claim and execute at most one durable poll job. Crashing anywhere after the
 * claim is safe: the persisted lease becomes reclaimable, while completion is
 * fenced by the monotonic attempt token.
 */
export async function runPlayerLocalEvidencePollSchedulerOnce(
  input: PlayerLocalEvidencePollSchedulerInput,
): Promise<PlayerLocalEvidencePollSchedulerResult> {
  if (!configurationValid(input)) {
    return { decision: "refused", reason: "invalid_configuration" };
  }
  const now = input.now ?? Date.now;
  const claimedAtMs = safeNow(now);
  if (claimedAtMs === undefined) {
    return { decision: "refused", reason: "invalid_configuration" };
  }
  const claim = await input.runtime.claimEvidencePollJob(
    input.sourceId,
    claimedAtMs,
    input.leaseDurationMs,
  );
  if (claim.decision === "not_due" || claim.decision === "not_found") {
    return { decision: "idle", reason: claim.decision };
  }
  if (claim.decision === "terminal") return claim;
  if (claim.decision === "refused") {
    return {
      decision: "refused",
      reason: "storage_refused",
      storage_reason: claim.reason,
    };
  }
  if (claim.decision !== "claimed") {
    return {
      decision: "refused",
      reason: "storage_refused",
      storage_reason: "unexpected_claim_decision",
    };
  }
  const job = claim.job;
  const leaseExpiresAtMs = claimedLease(job);
  const policyLeaseExpiry = input.runtime.evidencePollLeaseExpiry({
    now_ms: claimedAtMs,
    deadline_at_ms: job.deadline_at_ms,
    lease_duration_ms: input.leaseDurationMs,
  });
  if (
    leaseExpiresAtMs === undefined ||
    leaseExpiresAtMs !== policyLeaseExpiry ||
    !input.runtime.evidencePollClaimAllowed({
      now_ms: claimedAtMs,
      deadline_at_ms: job.deadline_at_ms,
      next_poll_at_ms: job.next_poll_at_ms,
      lease_available: true,
    })
  ) {
    return {
      decision: "refused",
      reason: "storage_refused",
      storage_reason: "claim_policy_mismatch",
    };
  }

  const pollResult = await pollPlayerLocalEvidenceInbox({
    runtime: input.runtime,
    endpoint: job.endpoint,
    expectedSourceId: job.source_id,
    initialMessageDigest: job.initial_message_digest,
    authenticator: input.authenticator,
    deadlineAtMs: job.deadline_at_ms,
    maxMessagesPerPage: input.maxMessagesPerPage,
    maxResponseBytes: input.maxResponseBytes,
    requestTimeoutMs: input.requestTimeoutMs,
    fetcher: input.fetcher,
    now,
  });
  const completedAtMs = safeNow(now);
  if (completedAtMs === undefined) {
    return { decision: "refused", reason: "invalid_configuration" };
  }
  if (
    pollResult.decision === "deadline_expired" ||
    completedAtMs >= job.deadline_at_ms
  ) {
    const terminal = await input.runtime.claimEvidencePollJob(
      input.sourceId,
      completedAtMs,
      input.leaseDurationMs,
    );
    if (terminal.decision === "terminal") {
      return { ...terminal, poll_result: pollResult };
    }
    return {
      decision: "refused",
      reason: "storage_refused",
      storage_reason: terminal.decision === "refused"
        ? terminal.reason
        : "deadline_transition_failed",
    };
  }

  let failures: number;
  let nextPollAtMs: number;
  if (pollResult.decision === "applied" || pollResult.decision === "no_change") {
    failures = 0;
    const requested = completedAtMs + input.successIntervalMs;
    if (!Number.isSafeInteger(requested) || requested <= completedAtMs) {
      return { decision: "refused", reason: "invalid_configuration" };
    }
    nextPollAtMs = Math.min(requested, job.deadline_at_ms);
  } else {
    failures = job.failures + 1;
    if (!Number.isSafeInteger(failures)) {
      return { decision: "refused", reason: "invalid_configuration" };
    }
    nextPollAtMs = input.runtime.evidencePollNextRetryAt({
      now_ms: completedAtMs,
      deadline_at_ms: job.deadline_at_ms,
      failures: job.failures,
      base_backoff_ms: input.baseBackoffMs,
      max_backoff_ms: input.maxBackoffMs,
    });
    if (nextPollAtMs < completedAtMs) {
      return { decision: "refused", reason: "invalid_configuration" };
    }
  }
  const completion = await input.runtime.completeEvidencePollJob({
    source_id: job.source_id,
    expected_attempt_count: job.attempt_count,
    expected_lease_expires_at_ms: leaseExpiresAtMs,
    completed_at_ms: completedAtMs,
    next_poll_at_ms: nextPollAtMs,
    failures,
  });
  if (completion.decision === "concurrent_write") {
    return { decision: "lost_lease", poll_result: pollResult };
  }
  if (completion.decision === "refused") {
    return {
      decision: "refused",
      reason: "storage_refused",
      storage_reason: completion.reason,
    };
  }
  return {
    decision: "completed",
    poll_result: pollResult,
    failures,
    next_poll_at_ms: nextPollAtMs,
  };
}
