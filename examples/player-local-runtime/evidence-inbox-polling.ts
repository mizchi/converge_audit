import type {
  PlayerLocalEvidenceInboxCursor,
} from "./contracts.ts";

export interface PlayerLocalEvidenceInboxPollRequestBody {
  version: 1;
  source_id: string;
  after_sequence: number;
  after_message_digest: string;
  limit: number;
}

export interface PlayerLocalEvidenceInboxPage {
  version: 1;
  source_id: string;
  after_sequence: number;
  after_message_digest: string;
  messages: unknown[];
}

export type PlayerLocalEvidenceInboxPageDecodeResult =
  | { ok: true; page: PlayerLocalEvidenceInboxPage }
  | { ok: false; reason: "invalid_page" | "page_limit_exceeded" };

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function boundedString(value: unknown, maximumLength: number): value is string {
  return typeof value === "string" && value.length > 0 &&
    value.length <= maximumLength;
}

export function playerLocalEvidenceInboxPollRequest(
  cursor: PlayerLocalEvidenceInboxCursor,
  limit: number,
): PlayerLocalEvidenceInboxPollRequestBody {
  return {
    version: 1,
    source_id: cursor.source_id,
    after_sequence: cursor.sequence,
    after_message_digest: cursor.message_digest,
    limit,
  };
}

export function decodePlayerLocalEvidenceInboxPage(
  value: unknown,
  expectedCursor: PlayerLocalEvidenceInboxCursor,
  maxMessagesPerPage: number,
): PlayerLocalEvidenceInboxPageDecodeResult {
  if (
    !isRecord(value) ||
    value.version !== 1 ||
    !boundedString(value.source_id, 256) ||
    !Number.isSafeInteger(value.after_sequence) ||
    (value.after_sequence as number) < -1 ||
    !boundedString(value.after_message_digest, 4_096) ||
    !Array.isArray(value.messages)
  ) return { ok: false, reason: "invalid_page" };
  if (value.messages.length > maxMessagesPerPage) {
    return { ok: false, reason: "page_limit_exceeded" };
  }
  if (
    value.source_id !== expectedCursor.source_id ||
    value.after_sequence !== expectedCursor.sequence ||
    value.after_message_digest !== expectedCursor.message_digest
  ) return { ok: false, reason: "invalid_page" };
  return {
    ok: true,
    page: {
      version: 1,
      source_id: value.source_id,
      after_sequence: value.after_sequence as number,
      after_message_digest: value.after_message_digest,
      messages: value.messages,
    },
  };
}
