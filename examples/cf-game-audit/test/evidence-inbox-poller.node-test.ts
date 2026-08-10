import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { IDBFactory } from "fake-indexeddb";
import {
  audit_browser_ed25519_public_key,
  audit_browser_ed25519_sign,
  audit_browser_sha256,
} from "../../../_build/js/release/build/x/game_audit/browser_bridge/browser_bridge.js";

import {
  buildEvidenceCaseResolutionEnvelope,
  type EvidenceCaseResolutionNotice,
} from "../../player-local-runtime/evidence-case-resolution-relay.ts";
import {
  playerLocalEvidenceHoldEnvelopeStatement,
  type PlayerLocalEvidenceHoldUnsignedEnvelope,
} from "../../player-local-runtime/evidence-hold-wire.ts";
import type {
  AuditBoundary,
  PlayerLocalStoreConfiguration,
} from "../../player-local-runtime/contracts.ts";
import {
  createMoonBitEd25519EvidenceHoldAuthenticator,
} from "../web/src/audit/evidence-hold-authenticator.ts";
import {
  pollPlayerLocalEvidenceInbox,
} from "../web/src/audit/evidence-inbox-poller.ts";
import {
  BrowserPlayerLocalCheckpointRuntime,
} from "../web/src/audit/player-local-checkpoint-runtime.ts";

const boundary: AuditBoundary = {
  protocol_version: 1,
  purpose: "checkpoint-v1",
  manifest_digest: "manifest-poller",
  scope_id: "player-alice",
  unit_id: "match-poller",
};

const configuration: PlayerLocalStoreConfiguration = {
  boundary,
  genesis_digest: "genesis",
  outbox_capacity: 2,
};

const seed =
  "000102030405060708090a0b0c0d0e0f" +
  "101112131415161718191a1b1c1d1e1f";
const sourceId = "authority-a";
const initialMessageDigest = "inbox-genesis";

function sign(unsigned: PlayerLocalEvidenceHoldUnsignedEnvelope) {
  const messageDigest = audit_browser_sha256(
    playerLocalEvidenceHoldEnvelopeStatement(unsigned),
  );
  return {
    ...unsigned,
    message_digest: messageDigest,
    authentication: {
      scheme: "moonbit-ed25519-v1" as const,
      signature: audit_browser_ed25519_sign(seed, messageDigest),
    },
  };
}

function placement(): PlayerLocalEvidenceHoldUnsignedEnvelope {
  return {
    version: 1,
    source_id: sourceId,
    message_id: "challenge-0",
    sequence: 0,
    previous_message_digest: initialMessageDigest,
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
}

function resolution(
  previousMessageDigest: string,
): PlayerLocalEvidenceHoldUnsignedEnvelope {
  return {
    version: 1,
    source_id: sourceId,
    message_id: "challenge-0",
    sequence: 1,
    previous_message_digest: previousMessageDigest,
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
}

async function openRuntime() {
  const runtime = await BrowserPlayerLocalCheckpointRuntime.open({
    factory: new IDBFactory(),
    databaseName: `evidence-poller-${crypto.randomUUID()}`,
    configuration,
  });
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
  return runtime;
}

function authenticator() {
  return createMoonBitEd25519EvidenceHoldAuthenticator({
    [sourceId]: audit_browser_ed25519_public_key(seed),
  });
}

function page(
  afterSequence: number,
  afterMessageDigest: string,
  messages: unknown[],
) {
  return {
    version: 1,
    source_id: sourceId,
    after_sequence: afterSequence,
    after_message_digest: afterMessageDigest,
    messages,
  };
}

function pollInput(
  runtime: BrowserPlayerLocalCheckpointRuntime,
  fetcher: typeof fetch,
  overrides: Partial<Parameters<typeof pollPlayerLocalEvidenceInbox>[0]> = {},
) {
  return {
    runtime,
    endpoint: "https://audit.example/evidence-inbox",
    expectedSourceId: sourceId,
    initialMessageDigest,
    authenticator: authenticator(),
    deadlineAtMs: 2_000,
    maxMessagesPerPage: 2,
    maxResponseBytes: 16_384,
    requestTimeoutMs: 100,
    fetcher,
    now: () => 1_000,
    ...overrides,
  };
}

test("bounded evidence polling applies a signed page and resumes from its durable cursor", async () => {
  const runtime = await openRuntime();
  const signedPlacement = sign(placement());
  const signedResolution = sign(resolution(signedPlacement.message_digest));
  const requests: unknown[] = [];
  const fetcher = (async (_input, init) => {
    requests.push(JSON.parse(String(init?.body)));
    return Response.json(page(
      -1,
      initialMessageDigest,
      [signedPlacement, signedResolution],
    ));
  }) as typeof fetch;

  assert.deepEqual(await pollPlayerLocalEvidenceInbox(
    pollInput(runtime, fetcher),
  ), {
    decision: "applied",
    applied_messages: 2,
    last_sequence: 1,
  });
  assert.deepEqual(requests, [{
    version: 1,
    source_id: sourceId,
    after_sequence: -1,
    after_message_digest: initialMessageDigest,
    limit: 2,
  }]);
  const image = await runtime.image();
  assert.equal(image.evidence_inbox_cursors[0]?.sequence, 1);
  assert.equal(image.evidence_holds[0]?.state.kind, "resolved");

  let resumedRequest: unknown;
  const emptyFetcher = (async (_input, init) => {
    resumedRequest = JSON.parse(String(init?.body));
    return Response.json(page(
      1,
      signedResolution.message_digest,
      [],
    ));
  }) as typeof fetch;
  assert.deepEqual(await pollPlayerLocalEvidenceInbox(
    pollInput(runtime, emptyFetcher),
  ), {
    decision: "no_change",
    applied_messages: 0,
    last_sequence: 1,
  });
  assert.deepEqual(resumedRequest, {
    version: 1,
    source_id: sourceId,
    after_sequence: 1,
    after_message_digest: signedResolution.message_digest,
    limit: 2,
  });
  runtime.close();
});

test("an authenticated arbiter notice is source-signed before the inbox resolves a hold", async () => {
  const runtime = await openRuntime();
  const signedPlacement = sign(placement());
  const unsignedResolution = resolution(signedPlacement.message_digest);
  if (unsignedResolution.operation.kind !== "resolve") {
    assert.fail("expected resolution");
  }
  const notice: EvidenceCaseResolutionNotice = {
    version: 1,
    noticeSequence: 0,
    scope: "reference-game",
    unit: "dungeon-1",
    caseId: "c".repeat(64),
    sourceId,
    acceptedAtMs: 1_000,
    resolution: unsignedResolution.operation.resolution,
    authorization: { kind: "dismissal", certificate: "authenticated" },
  };
  const relayed = await buildEvidenceCaseResolutionEnvelope(notice, {
    cursor: {
      boundary,
      source_id: sourceId,
      sequence: 0,
      message_digest: signedPlacement.message_digest,
    },
    authorizationVerifier: {
      verify: (candidate) => candidate.authorization === notice.authorization,
    },
    digest: { hashString: audit_browser_sha256 },
    signer: {
      scheme: "moonbit-ed25519-v1",
      sign: (digest) => audit_browser_ed25519_sign(seed, digest),
    },
  });
  if (!relayed.ok) throw new Error(relayed.reason);
  const fetcher = (async () => Response.json(page(
    -1,
    initialMessageDigest,
    [signedPlacement, relayed.envelope],
  ))) as typeof fetch;
  assert.deepEqual(await pollPlayerLocalEvidenceInbox(
    pollInput(runtime, fetcher),
  ), {
    decision: "applied",
    applied_messages: 2,
    last_sequence: 1,
  });
  const image = await runtime.image();
  assert.deepEqual(image.evidence_holds[0]?.state, {
    kind: "resolved",
    decision: "dismissed",
    resolution_digest: "resolution-0",
  });
  runtime.close();
});

test("bounded evidence polling sends its cursor over a real HTTP POST", async (t) => {
  const runtime = await openRuntime();
  const signedPlacement = sign(placement());
  let requestBody: unknown;
  const responseText = JSON.stringify(page(
    -1,
    initialMessageDigest,
    [signedPlacement],
  ));
  const server = createServer((request, response) => {
    void (async () => {
      let body = "";
      request.setEncoding("utf8");
      for await (const chunk of request) body += chunk;
      requestBody = {
        method: request.method,
        content_type: request.headers["content-type"],
        body: JSON.parse(body),
      };
      response.writeHead(200, {
        "content-type": "application/json",
        "content-length": String(Buffer.byteLength(responseText)),
      });
      response.end(responseText);
    })().catch((error: unknown) => {
      response.statusCode = 500;
      response.end(error instanceof Error ? error.message : String(error));
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => {
    server.closeAllConnections();
    server.close();
    await once(server, "close");
    runtime.close();
  });
  const address = server.address() as AddressInfo;

  assert.deepEqual(await pollPlayerLocalEvidenceInbox(pollInput(
    runtime,
    fetch,
    { endpoint: `http://127.0.0.1:${address.port}/evidence-inbox` },
  )), {
    decision: "applied",
    applied_messages: 1,
    last_sequence: 0,
  });
  assert.deepEqual(requestBody, {
    method: "POST",
    content_type: "application/json",
    body: {
      version: 1,
      source_id: sourceId,
      after_sequence: -1,
      after_message_digest: initialMessageDigest,
      limit: 2,
    },
  });
});

test("bounded evidence polling rejects expiry, timeout, byte excess, and page excess without mutation", async () => {
  const runtime = await openRuntime();
  const before = await runtime.image();
  let calls = 0;
  const unusedFetcher = (async () => {
    calls += 1;
    return Response.json(page(-1, initialMessageDigest, []));
  }) as typeof fetch;
  assert.deepEqual(await pollPlayerLocalEvidenceInbox(pollInput(
    runtime,
    unusedFetcher,
    { deadlineAtMs: 1_000 },
  )), {
    decision: "deadline_expired",
    applied_messages: 0,
  });
  assert.equal(calls, 0);
  assert.deepEqual(await runtime.image(), before);

  const unavailableFetcher = (async () =>
    new Response("unavailable", { status: 503 })) as typeof fetch;
  assert.deepEqual(await pollPlayerLocalEvidenceInbox(pollInput(
    runtime,
    unavailableFetcher,
  )), {
    decision: "refused",
    reason: "http_error",
    http_status: 503,
    applied_messages: 0,
  });
  assert.deepEqual(await runtime.image(), before);

  const wrongAnchorFetcher = (async () => Response.json(page(
    0,
    "unrelated-inbox-head",
    [],
  ))) as typeof fetch;
  assert.deepEqual(await pollPlayerLocalEvidenceInbox(pollInput(
    runtime,
    wrongAnchorFetcher,
  )), {
    decision: "refused",
    reason: "invalid_page",
    applied_messages: 0,
  });
  assert.deepEqual(await runtime.image(), before);

  let clockReads = 0;
  const lateResponseFetcher = (async () =>
    Response.json(page(-1, initialMessageDigest, []))) as typeof fetch;
  assert.deepEqual(await pollPlayerLocalEvidenceInbox(pollInput(
    runtime,
    lateResponseFetcher,
    {
      now: () => {
        clockReads += 1;
        return clockReads === 1 ? 1_000 : 2_000;
      },
    },
  )), {
    decision: "deadline_expired",
    applied_messages: 0,
  });
  assert.deepEqual(await runtime.image(), before);

  const timeoutFetcher = ((_input: RequestInfo | URL, init?: RequestInit) =>
    new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => {
        reject(new DOMException("aborted", "AbortError"));
      }, { once: true });
    })) as typeof fetch;
  assert.deepEqual(await pollPlayerLocalEvidenceInbox(pollInput(
    runtime,
    timeoutFetcher,
    { requestTimeoutMs: 1 },
  )), {
    decision: "refused",
    reason: "request_timeout",
    applied_messages: 0,
  });
  assert.deepEqual(await runtime.image(), before);

  const oversizedFetcher = (async () =>
    new Response("x".repeat(65))) as typeof fetch;
  assert.deepEqual(await pollPlayerLocalEvidenceInbox(pollInput(
    runtime,
    oversizedFetcher,
    { maxResponseBytes: 64 },
  )), {
    decision: "refused",
    reason: "response_too_large",
    applied_messages: 0,
  });
  assert.deepEqual(await runtime.image(), before);

  const tooManyFetcher = (async () => Response.json(page(
    -1,
    initialMessageDigest,
    [sign(placement()), sign(placement())],
  ))) as typeof fetch;
  assert.deepEqual(await pollPlayerLocalEvidenceInbox(pollInput(
    runtime,
    tooManyFetcher,
    { maxMessagesPerPage: 1 },
  )), {
    decision: "refused",
    reason: "page_limit_exceeded",
    applied_messages: 0,
  });
  assert.deepEqual(await runtime.image(), before);
  runtime.close();
});

test("bounded evidence polling commits only the valid prefix of an adversarial page", async () => {
  const runtime = await openRuntime();
  const signedPlacement = sign(placement());
  const invalidResolution = sign(resolution("wrong-previous-digest"));
  const fetcher = (async () => Response.json(page(
    -1,
    initialMessageDigest,
    [signedPlacement, invalidResolution],
  ))) as typeof fetch;

  assert.deepEqual(await pollPlayerLocalEvidenceInbox(
    pollInput(runtime, fetcher),
  ), {
    decision: "refused",
    reason: "message_refused",
    message_reason: "cursor_mismatch",
    applied_messages: 1,
  });
  const afterPrefix = await runtime.image();
  assert.equal(afterPrefix.evidence_inbox_cursors[0]?.sequence, 0);
  assert.equal(afterPrefix.evidence_holds[0]?.state.kind, "active");

  let calls = 0;
  assert.deepEqual(await pollPlayerLocalEvidenceInbox(pollInput(
    runtime,
    (async () => {
      calls += 1;
      return Response.json(page(0, signedPlacement.message_digest, []));
    }) as typeof fetch,
    { deadlineAtMs: 1_000 },
  )), {
    decision: "deadline_expired",
    applied_messages: 0,
  });
  assert.equal(calls, 0);
  assert.deepEqual(await runtime.image(), afterPrefix);
  runtime.close();
});
