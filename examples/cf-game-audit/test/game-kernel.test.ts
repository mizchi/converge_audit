import { describe, expect, it } from "vitest";
import {
  advanceGame,
  applyItemVerification,
  createInitialGame,
  listingEligibility,
  type Axis,
  type GameState,
  type StepEffect,
} from "../game/kernel";

function advance(
  state: GameState,
  horizontal: Axis = 0,
  vertical: Axis = 0,
): { state: GameState; effects: StepEffect[] } {
  const result = advanceGame(state, {
    tick: state.tick + 1,
    horizontal,
    vertical,
  });
  if (!result.ok) throw new Error(`unexpected refusal: ${result.reason}`);
  return result;
}

function advanceUntil(
  initial: GameState,
  tick: number,
  horizontal: Axis = 0,
  vertical: Axis = 0,
): { state: GameState; effects: StepEffect[] } {
  let state = initial;
  const effects: StepEffect[] = [];
  while (state.tick < tick) {
    const advanced = advance(state, horizontal, vertical);
    state = advanced.state;
    effects.push(...advanced.effects);
  }
  return { state, effects };
}

describe("deterministic encounter kernel", () => {
  it("moves at fixed integer rates and refuses malformed input", () => {
    const initial = createInitialGame({ seed: 42, playerId: "player-1" });
    const axis = advance(initial, 1, 0).state;
    expect(axis.player).toMatchObject({
      x: initial.player.x + 6,
      y: initial.player.y,
    });
    const diagonal = advance(axis, 1, 1).state;
    expect(diagonal.player).toMatchObject({
      x: axis.player.x + 4,
      y: axis.player.y + 4,
    });
    expect(advanceGame(diagonal, {
      tick: diagonal.tick + 2,
      horizontal: 0,
      vertical: 0,
    })).toEqual({ ok: false, reason: "tick_mismatch" });
    expect(advanceGame(diagonal, {
      tick: diagonal.tick + 1,
      horizontal: 2 as 1,
      vertical: 0,
    })).toEqual({ ok: false, reason: "invalid_axis" });
  });

  it("resolves an announced AoE against the position at its resolve tick", () => {
    const initial = createInitialGame({ seed: 42, playerId: "player-1" });
    const idle = advanceUntil(initial, 45);
    expect(idle.state.player.hp).toBe(initial.player.hp - 1);
    expect(idle.effects).toContainEqual({
      kind: "telegraph_resolved",
      telegraphId: "telegraph-0",
      outcome: "hit",
      resolveTick: 45,
    });

    const escaped = advanceUntil(
      createInitialGame({ seed: 42, playerId: "player-1" }),
      45,
      -1,
      0,
    );
    expect(escaped.state.player.hp).toBe(initial.player.hp);
    expect(escaped.effects).toContainEqual({
      kind: "telegraph_resolved",
      telegraphId: "telegraph-0",
      outcome: "dodged",
      resolveTick: 45,
    });
  });

  it("derives the same Diablo-style drop from the same seed and transcript", () => {
    const first = advanceUntil(
      createInitialGame({ seed: 0x1234, playerId: "player-1" }),
      30,
    );
    const second = advanceUntil(
      createInitialGame({ seed: 0x1234, playerId: "player-1" }),
      30,
    );
    const firstDrop = first.effects.find((effect) => effect.kind === "item_dropped");
    const secondDrop = second.effects.find((effect) => effect.kind === "item_dropped");
    expect(firstDrop).toBeDefined();
    expect(secondDrop).toEqual(firstDrop);
    expect(second.state).toEqual(first.state);
  });

  it("allows provisional loot in inventory but gates marketplace listing", () => {
    let state = advanceUntil(
      createInitialGame({ seed: 0x1234, playerId: "player-1" }),
      30,
    ).state;
    state = advanceUntil(state, 40, 1, 0).state;
    expect(state.inventory).toHaveLength(1);
    const provisional = state.inventory[0];
    expect(provisional.audit.status).toBe("provisional");
    expect(listingEligibility(provisional)).toEqual({
      allowed: false,
      reason: "awaiting_checkpoint",
    });

    const verified = applyItemVerification(state, {
      authorityReceiptId: "authority-receipt-1",
      assetId: provisional.assetId,
      ownerId: "player-1",
      ownerPublicKey: "a".repeat(64),
      ownerVersion: 0,
      ownerHeadId: "b".repeat(64),
      checkpointDigest: "checkpoint-30",
      inventoryEpoch: 1,
    });
    expect(verified.ok).toBe(true);
    if (!verified.ok) throw new Error(verified.reason);
    expect(listingEligibility(verified.state.inventory[0])).toEqual({
      allowed: true,
      authorityReceiptId: "authority-receipt-1",
      ownerPublicKey: "a".repeat(64),
      ownerVersion: 0,
      ownerHeadId: "b".repeat(64),
      checkpointDigest: "checkpoint-30",
      inventoryEpoch: 1,
    });
  });
});
