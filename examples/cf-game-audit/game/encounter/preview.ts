import type { GameState } from "../contracts.ts";
/** Render only combat facts. Preview seed, item IDs, rolls and inventory are
never presented as the authoritative reward or persisted as an input proof. */
export function publicEncounterPreview(game: GameState) {
  return { tick: game.tick, player: game.player, enemies: game.enemies, telegraphs: game.telegraphs,
    drops: game.drops.map((drop) => ({ x: drop.x, y: drop.y })) };
}
