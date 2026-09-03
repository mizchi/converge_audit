/**
 * Codecs convert domain values to plain JSON for checkpoints and transport.
 * Hashing does not go through codecs; it uses canonical serialization of the
 * in-memory value, which understands Map/Set/Uint8Array directly.
 */
import { bytesToHex, compareStrings, hexToBytes, type JsonValue } from "./canonical.ts";

export interface Codec<T> {
  encode(value: T): JsonValue;
  decode(json: JsonValue): T;
}

/** For types that are already plain JSON (commands, events, reasons in the MMO sample). */
export function jsonCodec<T extends JsonValue>(): Codec<T> {
  return {
    encode: (value) => value,
    decode: (json) => json as T,
  };
}

export function mapCodec<K, V>(key: Codec<K>, value: Codec<V>): Codec<ReadonlyMap<K, V>> {
  return {
    encode: (map) => {
      const entries = [...map.entries()].map(([k, v]) => {
        const encodedKey = key.encode(k);
        return { sortKey: JSON.stringify(encodedKey), pair: [encodedKey, value.encode(v)] as const };
      });
      entries.sort((a, b) => compareStrings(a.sortKey, b.sortKey));
      return entries.map((e) => [e.pair[0], e.pair[1]]);
    },
    decode: (json) => {
      if (!Array.isArray(json)) throw new TypeError("mapCodec: expected array of entries");
      const out = new Map<K, V>();
      for (const entry of json) {
        if (!Array.isArray(entry) || entry.length !== 2) throw new TypeError("mapCodec: bad entry");
        out.set(key.decode(entry[0]!), value.decode(entry[1]!));
      }
      return out;
    },
  };
}

export function arrayCodec<T>(item: Codec<T>): Codec<readonly T[]> {
  return {
    encode: (items) => items.map((i) => item.encode(i)),
    decode: (json) => {
      if (!Array.isArray(json)) throw new TypeError("arrayCodec: expected array");
      return json.map((i) => item.decode(i));
    },
  };
}

export const bytesCodec: Codec<Uint8Array> = {
  encode: (bytes) => bytesToHex(bytes),
  decode: (json) => {
    if (typeof json !== "string") throw new TypeError("bytesCodec: expected hex string");
    return hexToBytes(json);
  },
};

export function expectRecord(json: JsonValue | undefined, what: string): { readonly [key: string]: JsonValue } {
  if (json === null || json === undefined || typeof json !== "object" || Array.isArray(json)) {
    throw new TypeError(`${what}: expected object`);
  }
  return json as { readonly [key: string]: JsonValue };
}

export function expectNumber(json: JsonValue | undefined, what: string): number {
  if (typeof json !== "number") throw new TypeError(`${what}: expected number`);
  return json;
}

export function expectString(json: JsonValue | undefined, what: string): string {
  if (typeof json !== "string") throw new TypeError(`${what}: expected string`);
  return json;
}

export function expectArray(json: JsonValue | undefined, what: string): readonly JsonValue[] {
  if (!Array.isArray(json)) throw new TypeError(`${what}: expected array`);
  return json;
}
