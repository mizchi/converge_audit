import { expectNumber, expectRecord, jsonCodec, mapCodec, type Codec } from "../../core/codec.ts";

export type PlayerId = string;

export interface Player {
  readonly hp: number;
  readonly maxHp: number;
  readonly mp: number;
}

export interface World {
  readonly players: ReadonlyMap<PlayerId, Player>;
}

const playerCodec: Codec<Player> = {
  encode: (player) => ({ hp: player.hp, maxHp: player.maxHp, mp: player.mp }),
  decode: (json) => {
    const record = expectRecord(json, "player");
    return {
      hp: expectNumber(record.hp, "player.hp"),
      maxHp: expectNumber(record.maxHp, "player.maxHp"),
      mp: expectNumber(record.mp, "player.mp"),
    };
  },
};

const playersCodec = mapCodec(jsonCodec<string>(), playerCodec);

export const worldCodec: Codec<World> = {
  encode: (world) => ({ players: playersCodec.encode(world.players) }),
  decode: (json) => ({ players: playersCodec.decode(expectRecord(json, "world").players ?? null) }),
};

export function worldWith(players: Readonly<Record<PlayerId, Player>>): World {
  return { players: new Map(Object.entries(players)) };
}

export function isAlive(world: World, id: PlayerId): boolean {
  const player = world.players.get(id);
  return player !== undefined && player.hp > 0;
}

export function playerOf(world: World, id: PlayerId): Player | undefined {
  return world.players.get(id);
}
