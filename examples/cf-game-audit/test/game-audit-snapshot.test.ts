import { describe, expect, it } from "vitest";
import {
  appendAuditTick,
  createGameAuditJournal,
  type AuditDigestAdapter,
  type AsyncAuditDigestAdapter,
} from "../game/audit/journal";
import {
  captureRunSnapshot,
  createRunSnapshot,
  createRunSnapshotAsync,
  restoreRunSnapshot,
  restoreRunSnapshotAsync,
} from "../game/audit/snapshot";
import { advanceGame, createInitialGame } from "../game/kernel";

const testDigest: AuditDigestAdapter = {
  hashString(value) {
    let hash = 0x811c9dc5;
    for (let index = 0; index < value.length; index += 1) {
      hash ^= value.charCodeAt(index);
      hash = Math.imul(hash, 0x01000193);
    }
    return (hash >>> 0).toString(16).padStart(8, "0");
  },
  merkleRoot(payloads) {
    return this.hashString(JSON.stringify(["test-merkle-v1", ...payloads]));
  },
};

const asyncTestDigest: AsyncAuditDigestAdapter = {
  async hashString(value) {
    return testDigest.hashString(value);
  },
  async merkleRoot(payloads) {
    return testDigest.merkleRoot(payloads);
  },
};

function runTo(ticks: number) {
  let game = createInitialGame({ seed: 7, playerId: "player-1" });
  let audit = createGameAuditJournal({
    seed: game.seed,
    playerId: game.player.id,
    ownerPublicKey: "a".repeat(64),
    cadenceTicks: 30,
  }, testDigest);
  while (game.tick < ticks) {
    const input = { tick: game.tick + 1, horizontal: 0 as const, vertical: 0 as const };
    const advanced = advanceGame(game, input);
    if (!advanced.ok) throw new Error(advanced.reason);
    const appended = appendAuditTick(audit, {
      input,
      effects: advanced.effects,
      state: advanced.state,
    }, testDigest);
    if (!appended.ok) throw new Error(appended.reason);
    game = advanced.state;
    audit = appended.state;
  }
  return { game, audit };
}

describe("player-local run snapshot", () => {
  it("captures an already sealed boundary without rehashing its history", () => {
    const run = runTo(30);

    expect(captureRunSnapshot(run.game, run.audit, 1234)).toEqual({
      version: 1,
      savedAtMs: 1234,
      game: run.game,
      audit: run.audit,
    });
  });

  it("keeps asynchronous snapshot validation identical to the fixture path", async () => {
    const run = runTo(30);
    const synchronous = createRunSnapshot(
      run.game,
      run.audit,
      1234,
      testDigest,
    );
    const asynchronous = await createRunSnapshotAsync(
      run.game,
      run.audit,
      1234,
      asyncTestDigest,
    );

    expect(asynchronous).toEqual(synchronous);
    await expect(restoreRunSnapshotAsync(
      structuredClone(asynchronous),
      asyncTestDigest,
    )).resolves.toEqual({ ok: true, snapshot: asynchronous });
  });

  it("refuses a changed event through asynchronous snapshot validation", async () => {
    const run = runTo(30);
    const snapshot = createRunSnapshot(run.game, run.audit, 1234, testDigest);
    const changed = structuredClone(snapshot);
    changed.audit.retainedSegments[0].events[0].canonicalPayload += "tampered";

    await expect(restoreRunSnapshotAsync(changed, asyncTestDigest)).resolves
      .toEqual({ ok: false, reason: "event_root_mismatch" });
  });

  it("round-trips only a complete micro-checkpoint boundary", () => {
    const run = runTo(30);
    const snapshot = createRunSnapshot(run.game, run.audit, 1234, testDigest);
    const stored = JSON.parse(JSON.stringify(snapshot));
    const restored = restoreRunSnapshot(stored, testDigest);

    expect(restored.ok).toBe(true);
    if (!restored.ok) throw new Error(restored.reason);
    expect(restored.snapshot).toEqual(snapshot);
  });

  it("refuses to persist an incomplete micro segment", () => {
    const run = runTo(29);
    expect(() => createRunSnapshot(run.game, run.audit, 1234, testDigest)).toThrow(
      "snapshot requires a sealed checkpoint boundary",
    );
  });

  it("detects a changed retained event leaf", () => {
    const run = runTo(30);
    const snapshot = createRunSnapshot(run.game, run.audit, 1234, testDigest);
    const changed = structuredClone(snapshot);
    changed.audit.retainedSegments[0].events[0].canonicalPayload += "tampered";

    expect(restoreRunSnapshot(changed, testDigest)).toEqual({
      ok: false,
      reason: "event_root_mismatch",
    });
  });

  it("detects a game state that is ahead of its journal", () => {
    const run = runTo(30);
    const snapshot = createRunSnapshot(run.game, run.audit, 1234, testDigest);
    const changed = structuredClone(snapshot);
    changed.game.tick = 31;

    expect(restoreRunSnapshot(changed, testDigest)).toEqual({
      ok: false,
      reason: "journal_game_mismatch",
    });
  });
});
