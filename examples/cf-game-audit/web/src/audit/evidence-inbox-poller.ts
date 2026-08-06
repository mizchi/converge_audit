import type {
  PlayerLocalEvidenceHoldAuthenticator,
} from "../../../../player-local-runtime/evidence-hold-wire.ts";
import {
  decodePlayerLocalEvidenceInboxPage,
  playerLocalEvidenceInboxPollRequest,
} from "../../../../player-local-runtime/evidence-inbox-polling.ts";
import type {
  PlayerLocalEvidenceInboxCursor,
} from "../../../../player-local-runtime/contracts.ts";
import type {
  BrowserPlayerLocalCheckpointRuntime,
} from "./player-local-checkpoint-runtime.ts";

export interface PlayerLocalEvidenceInboxPollInput {
  runtime: BrowserPlayerLocalCheckpointRuntime;
  endpoint: string;
  expectedSourceId: string;
  initialMessageDigest: string;
  authenticator: PlayerLocalEvidenceHoldAuthenticator;
  deadlineAtMs: number;
  maxMessagesPerPage: number;
  maxResponseBytes: number;
  requestTimeoutMs: number;
  fetcher?: typeof fetch;
  now?: () => number;
}

export type PlayerLocalEvidenceInboxPollResult =
  | {
      decision: "applied" | "no_change";
      applied_messages: number;
      last_sequence: number;
    }
  | { decision: "deadline_expired"; applied_messages: 0 }
  | {
      decision: "refused";
      reason:
        | "invalid_configuration"
        | "request_timeout"
        | "request_failed"
        | "http_error"
        | "response_too_large"
        | "invalid_json"
        | "invalid_page"
        | "page_limit_exceeded"
        | "message_refused"
        | "concurrent_write";
      applied_messages: number;
      message_reason?: string;
      http_status?: number;
    };

class ResponseTooLargeError extends Error {}

function positiveInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}

function boundedString(value: string, maximumLength: number): boolean {
  return value.length > 0 && value.length <= maximumLength;
}

function endpointValid(value: string): boolean {
  if (!boundedString(value, 4_096)) return false;
  try {
    const endpoint = new URL(value);
    return endpoint.protocol === "https:" || endpoint.protocol === "http:";
  } catch {
    return false;
  }
}

function configurationValid(
  input: PlayerLocalEvidenceInboxPollInput,
  nowMs: number,
): boolean {
  return endpointValid(input.endpoint) &&
    boundedString(input.expectedSourceId, 256) &&
    boundedString(input.initialMessageDigest, 4_096) &&
    Number.isSafeInteger(nowMs) &&
    nowMs >= 0 &&
    Number.isSafeInteger(input.deadlineAtMs) &&
    input.deadlineAtMs >= 0 &&
    positiveInteger(input.maxMessagesPerPage) &&
    input.maxMessagesPerPage <= 128 &&
    positiveInteger(input.maxResponseBytes) &&
    input.maxResponseBytes <= 1_048_576 &&
    positiveInteger(input.requestTimeoutMs) &&
    input.requestTimeoutMs <= 60_000;
}

async function readBoundedResponse(
  response: Response,
  maximumBytes: number,
): Promise<Uint8Array> {
  const declaredLength = response.headers.get("content-length");
  if (declaredLength !== null) {
    const parsedLength = Number(declaredLength);
    if (Number.isFinite(parsedLength) && parsedLength > maximumBytes) {
      throw new ResponseTooLargeError();
    }
  }
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  while (true) {
    const chunk = await reader.read();
    if (chunk.done) break;
    length += chunk.value.byteLength;
    if (length > maximumBytes) {
      await reader.cancel().catch(() => undefined);
      throw new ResponseTooLargeError();
    }
    chunks.push(chunk.value);
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function cursorFor(
  input: PlayerLocalEvidenceInboxPollInput,
  cursors: PlayerLocalEvidenceInboxCursor[],
  boundary: PlayerLocalEvidenceInboxCursor["boundary"],
): PlayerLocalEvidenceInboxCursor {
  return cursors.find((cursor) =>
    cursor.source_id === input.expectedSourceId
  ) ?? {
    boundary,
    source_id: input.expectedSourceId,
    sequence: -1,
    message_digest: input.initialMessageDigest,
  };
}

export async function pollPlayerLocalEvidenceInbox(
  input: PlayerLocalEvidenceInboxPollInput,
): Promise<PlayerLocalEvidenceInboxPollResult> {
  const now = input.now ?? Date.now;
  let startedAtMs: number;
  try {
    startedAtMs = now();
  } catch {
    return {
      decision: "refused",
      reason: "invalid_configuration",
      applied_messages: 0,
    };
  }
  if (!configurationValid(input, startedAtMs)) {
    return {
      decision: "refused",
      reason: "invalid_configuration",
      applied_messages: 0,
    };
  }
  if (startedAtMs >= input.deadlineAtMs) {
    return { decision: "deadline_expired", applied_messages: 0 };
  }
  const image = await input.runtime.image();
  const expectedCursor = cursorFor(
    input,
    image.evidence_inbox_cursors,
    image.boundary,
  );
  const requestBody = playerLocalEvidenceInboxPollRequest(
    expectedCursor,
    input.maxMessagesPerPage,
  );
  const remainingMs = input.deadlineAtMs - startedAtMs;
  const deadlineLimitsRequest = remainingMs <= input.requestTimeoutMs;
  const effectiveTimeoutMs = Math.min(remainingMs, input.requestTimeoutMs);
  const controller = new AbortController();
  let timeoutTriggered = false;
  const timeout = setTimeout(() => {
    timeoutTriggered = true;
    controller.abort();
  }, effectiveTimeoutMs);
  let responseBytes: Uint8Array;
  try {
    const response = await (input.fetcher ?? fetch)(input.endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(requestBody),
      credentials: "omit",
      cache: "no-store",
      redirect: "error",
      signal: controller.signal,
    });
    if (!response.ok) {
      return {
        decision: "refused",
        reason: "http_error",
        applied_messages: 0,
        http_status: response.status,
      };
    }
    responseBytes = await readBoundedResponse(
      response,
      input.maxResponseBytes,
    );
  } catch (error) {
    if (error instanceof ResponseTooLargeError) {
      return {
        decision: "refused",
        reason: "response_too_large",
        applied_messages: 0,
      };
    }
    if (timeoutTriggered) {
      return deadlineLimitsRequest
        ? { decision: "deadline_expired", applied_messages: 0 }
        : {
            decision: "refused",
            reason: "request_timeout",
            applied_messages: 0,
          };
    }
    return {
      decision: "refused",
      reason: "request_failed",
      applied_messages: 0,
    };
  } finally {
    clearTimeout(timeout);
  }

  let receivedAtMs: number;
  try {
    receivedAtMs = now();
  } catch {
    return {
      decision: "refused",
      reason: "invalid_configuration",
      applied_messages: 0,
    };
  }
  if (!Number.isSafeInteger(receivedAtMs) || receivedAtMs < 0) {
    return {
      decision: "refused",
      reason: "invalid_configuration",
      applied_messages: 0,
    };
  }
  if (receivedAtMs >= input.deadlineAtMs) {
    return { decision: "deadline_expired", applied_messages: 0 };
  }

  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(
      responseBytes,
    ));
  } catch {
    return {
      decision: "refused",
      reason: "invalid_json",
      applied_messages: 0,
    };
  }
  const decoded = decodePlayerLocalEvidenceInboxPage(
    value,
    expectedCursor,
    input.maxMessagesPerPage,
  );
  if (!decoded.ok) {
    return {
      decision: "refused",
      reason: decoded.reason,
      applied_messages: 0,
    };
  }
  const pageAllowed = input.runtime.evidenceInboxPageAllowed({
    received_at_ms: receivedAtMs,
    deadline_at_ms: input.deadlineAtMs,
    message_count: decoded.page.messages.length,
    max_messages: input.maxMessagesPerPage,
    response_bytes: responseBytes.byteLength,
    max_response_bytes: input.maxResponseBytes,
    source_matches: decoded.page.source_id === expectedCursor.source_id,
    cursor_matches: decoded.page.after_sequence === expectedCursor.sequence &&
      decoded.page.after_message_digest === expectedCursor.message_digest,
  });
  if (!pageAllowed) {
    return {
      decision: "refused",
      reason: "invalid_page",
      applied_messages: 0,
    };
  }

  let appliedMessages = 0;
  for (const envelope of decoded.page.messages) {
    const result = await input.runtime.ingestEvidenceHoldEnvelope({
      envelope,
      expectedSourceId: input.expectedSourceId,
      initialMessageDigest: input.initialMessageDigest,
      authenticator: input.authenticator,
    });
    if (result.decision === "applied") {
      appliedMessages += 1;
      continue;
    }
    if (result.decision === "no_change") continue;
    if (result.decision === "concurrent_write") {
      return {
        decision: "refused",
        reason: "concurrent_write",
        applied_messages: appliedMessages,
      };
    }
    return {
      decision: "refused",
      reason: "message_refused",
      message_reason: "reason" in result
        ? result.reason
        : "unexpected_decision",
      applied_messages: appliedMessages,
    };
  }
  const current = await input.runtime.image();
  const cursor = current.evidence_inbox_cursors.find((candidate) =>
    candidate.source_id === input.expectedSourceId
  );
  return {
    decision: appliedMessages > 0 ? "applied" : "no_change",
    applied_messages: appliedMessages,
    last_sequence: cursor?.sequence ?? -1,
  };
}
