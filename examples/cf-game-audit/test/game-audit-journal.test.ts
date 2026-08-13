import { describe, expect, it } from "vitest";
import {
  acknowledgeAuditCheckpoint,
  appendAuditTick,
  appendAuditTickAsync,
  createGameAuditJournal,
  createGameAuditJournalAsync,
  type AuditDigestAdapter,
  type AsyncAuditDigestAdapter,
  type GameAuditJournalState,
} from "../game/audit/journal";
import {
  advanceGame,
  createInitialGame,
  type Axis,
  type GameState,
} from "../game/kernel";

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

const ownerPublicKey = "a".repeat(64);

const asyncTestDigest: AsyncAuditDigestAdapter = {
  async hashString(value) {
    return testDigest.hashString(value);
  },
  async merkleRoot(payloads) {
    return testDigest.merkleRoot(payloads);
  },
};

function advanceAudited(
  game: GameState,
  audit: GameAuditJournalState,
  horizontal: Axis = 0,
  vertical: Axis = 0,
) {
  const input = { tick: game.tick + 1, horizontal, vertical };
  const advanced = advanceGame(game, input);
  if (!advanced.ok) throw new Error(advanced.reason);
  const appended = appendAuditTick(audit, {
    input,
    effects: advanced.effects,
    state: advanced.state,
  }, testDigest);
  if (!appended.ok) throw new Error(appended.reason);
  return { game: advanced.state, audit: appended.state, checkpoint: appended.checkpoint };
}

function runTicks(
  count: number,
  horizontal: Axis = 0,
): { game: GameState; audit: GameAuditJournalState } {
  let game = createInitialGame({ seed: 0x1234, playerId: "player-1" });
  let audit = createGameAuditJournal({
    seed: game.seed,
    playerId: game.player.id,
    ownerPublicKey,
    cadenceTicks: 30,
  }, testDigest);
  for (let tick = 0; tick < count; tick += 1) {
    const next = advanceAudited(game, audit, horizontal);
    game = next.game;
    audit = next.audit;
  }
  return { game, audit };
}

async function runTicksAsync(
  count: number,
  horizontal: Axis = 0,
): Promise<{ game: GameState; audit: GameAuditJournalState }> {
  let game = createInitialGame({ seed: 0x1234, playerId: "player-1" });
  let audit = await createGameAuditJournalAsync({
    seed: game.seed,
    playerId: game.player.id,
    ownerPublicKey,
    cadenceTicks: 30,
  }, asyncTestDigest);
  for (let tick = 0; tick < count; tick += 1) {
    const input = {
      tick: game.tick + 1,
      horizontal,
      vertical: 0 as Axis,
    };
    const advanced = advanceGame(game, input);
    if (!advanced.ok) throw new Error(advanced.reason);
    const appended = await appendAuditTickAsync(audit, {
      input,
      effects: advanced.effects,
      state: advanced.state,
    }, asyncTestDigest);
    if (!appended.ok) throw new Error(appended.reason);
    game = advanced.state;
    audit = appended.state;
  }
  return { game, audit };
}

describe("local game audit journal", () => {
  it("keeps asynchronous production hashing byte-identical to the synchronous fixture", async () => {
    const synchronous = runTicks(60, -1);
    const asynchronous = await runTicksAsync(60, -1);

    expect(asynchronous).toEqual(synchronous);
  });

  it("does not mutate or publish a checkpoint before asynchronous hashes settle", async () => {
    const game = createInitialGame({ seed: 7, playerId: "player-1" });
    const audit = await createGameAuditJournalAsync({
      seed: game.seed,
      playerId: game.player.id,
      ownerPublicKey,
      cadenceTicks: 1,
    }, asyncTestDigest);
    const input = { tick: 1, horizontal: 0 as Axis, vertical: 0 as Axis };
    const advanced = advanceGame(game, input);
    if (!advanced.ok) throw new Error(advanced.reason);
    let releaseEventRoot: (() => void) | undefined;
    const blockedDigest: AsyncAuditDigestAdapter = {
      async hashString(value) {
        return testDigest.hashString(value);
      },
      async merkleRoot(payloads) {
        await new Promise<void>((resolve) => {
          releaseEventRoot = resolve;
        });
        return testDigest.merkleRoot(payloads);
      },
    };

    const appending = appendAuditTickAsync(audit, {
      input,
      effects: advanced.effects,
      state: advanced.state,
    }, blockedDigest);
    await Promise.resolve();

    expect(audit.nextTick).toBe(1);
    expect(audit.checkpoints).toHaveLength(0);
    expect(releaseEventRoot).toBeTypeOf("function");
    releaseEventRoot?.();
    const appended = await appending;
    expect(appended.ok).toBe(true);
    if (!appended.ok) throw new Error(appended.reason);
    expect(appended.state.nextTick).toBe(2);
    expect(appended.state.checkpoints).toHaveLength(1);
  });

  it("seals one deterministic micro checkpoint for each 30 accepted ticks", () => {
    const first = runTicks(60).audit;
    const second = runTicks(60).audit;

    expect(first.checkpoints).toEqual(second.checkpoints);
    expect(first.checkpoints).toHaveLength(2);
    expect(first.checkpoints[0]).toMatchObject({
      version: 1,
      epoch: 0,
      firstTick: 1,
      lastTick: 30,
      eventCount: 30,
    });
    expect(first.checkpoints[1].previousCheckpoint).toBe(
      first.checkpoints[0].checkpointDigest,
    );
    expect(first.pending).toHaveLength(0);
    expect(first.retainedSegments).toHaveLength(2);
    expect(first.retainedSegments[0].events).toHaveLength(30);
    expect(first.retainedSegments[0].checkpointDigest).toBe(
      first.checkpoints[0].checkpointDigest,
    );
  });

  it("changes the commitment when one accepted input changes", () => {
    const idle = runTicks(30).audit.checkpoints[0];
    const moved = runTicks(30, -1).audit.checkpoints[0];

    expect(moved.eventRoot).not.toBe(idle.eventRoot);
    expect(moved.stateDigest).not.toBe(idle.stateDigest);
    expect(moved.checkpointDigest).not.toBe(idle.checkpointDigest);
  });

  it("refuses a tick gap without mutating the journal", () => {
    const game = createInitialGame({ seed: 9, playerId: "player-1" });
    const audit = createGameAuditJournal({
      seed: game.seed,
      playerId: game.player.id,
      ownerPublicKey,
      cadenceTicks: 30,
    }, testDigest);
    const refused = appendAuditTick(audit, {
      input: { tick: 2, horizontal: 0, vertical: 0 },
      effects: [],
      state: { ...game, tick: 2 },
    }, testDigest);

    expect(refused).toEqual({ ok: false, reason: "tick_mismatch" });
    expect(audit.nextTick).toBe(1);
    expect(audit.pending).toHaveLength(0);
  });

  it("binds the run owner public key into the genesis checkpoint chain", () => {
    const first = runTicks(30).audit;
    const game = createInitialGame({ seed: 0x1234, playerId: "player-1" });
    let second = createGameAuditJournal({
      seed: game.seed,
      playerId: game.player.id,
      ownerPublicKey: "b".repeat(64),
      cadenceTicks: 30,
    }, testDigest);
    let secondGame = game;
    for (let tick = 0; tick < 30; tick += 1) {
      const next = advanceAudited(secondGame, second);
      secondGame = next.game;
      second = next.audit;
    }

    expect(first.ownerPublicKey).toBe(ownerPublicKey);
    expect(second.genesisDigest).not.toBe(first.genesisDigest);
    expect(second.checkpoints[0].checkpointDigest).not.toBe(
      first.checkpoints[0].checkpointDigest,
    );
  });

  it("binds created asset ids to the checkpoint containing their drop", () => {
    const { audit } = runTicks(30);
    const drop = audit.checkpoints[0].createdAssetIds;

    expect(drop).toHaveLength(1);
    expect(drop[0]).toMatch(/^loot-v1:/);
    expect(audit.checkpoints[0].canonicalEnvelope).toContain(drop[0]);
  });

  it("advances rollback precision only for an exact sealed checkpoint", () => {
    const audit = runTicks(60).audit;
    expect(audit.acknowledgedTick).toBe(0);

    expect(acknowledgeAuditCheckpoint(audit, "unknown")).toEqual({
      ok: false,
      reason: "unknown_checkpoint",
    });
    const outOfOrder = acknowledgeAuditCheckpoint(
      audit,
      audit.checkpoints[1].checkpointDigest,
    );
    expect(outOfOrder).toEqual({ ok: false, reason: "ack_gap" });

    const first = acknowledgeAuditCheckpoint(
      audit,
      audit.checkpoints[0].checkpointDigest,
    );
    expect(first.ok).toBe(true);
    if (!first.ok) throw new Error(first.reason);
    expect(first.state.acknowledgedTick).toBe(30);
    expect(first.state.acknowledgedEpoch).toBe(0);
  });
});
