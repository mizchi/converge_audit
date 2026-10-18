import assert from "node:assert/strict";
import test from "node:test";
import { advanceGame, createInitialGame, type Axis } from "../game/kernel.ts";
import { publicEncounterPreview } from "../game/encounter/preview.ts";

test("public combat preview is independent of the hidden reward seed through all encounter ticks", () => {
  for (const pattern of [0, 1, 2]) {
    const games = [0, 1, 0xffffffff, 0x87654321].map((seed) => createInitialGame({ seed, playerId: "alice" }));
    let sawRewardDifference = false;
    for (let tick = 1; tick <= 60; tick++) {
      const horizontal: Axis = pattern === 0 ? 0 : tick > 30 && tick <= 40 ? 1 : 0;
      const vertical: Axis = pattern === 2 && tick > 40 ? 1 : 0;
      for (let index = 0; index < games.length; index++) {
        const result = advanceGame(games[index], { tick, horizontal, vertical });
        assert.equal(result.ok, true); games[index] = result.state;
      }
      const expected = publicEncounterPreview(games[0]);
      for (const game of games.slice(1)) assert.deepEqual(publicEncounterPreview(game), expected);
      if (JSON.stringify(games[0].drops) !== JSON.stringify(games[1].drops) || JSON.stringify(games[0].inventory) !== JSON.stringify(games[1].inventory)) sawRewardDifference = true;
      assert.deepEqual(Object.keys(expected).sort(), ["drops", "enemies", "player", "telegraphs", "tick"]);
    }
    assert.equal(sawRewardDifference, true, "the projection test must exercise differing hidden rewards");
  }
});
