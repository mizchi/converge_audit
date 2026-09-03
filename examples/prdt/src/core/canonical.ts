/**
 * Canonical serialization.
 *
 * Every hash in the framework is computed over this encoding so that all
 * replicas, regardless of language runtime, key insertion order, or Map
 * iteration order, hash the same logical value to the same digest.
 *
 * Encoding rules:
 * - objects: keys sorted by UTF-16 code unit order, `undefined` values omitted
 * - arrays: element order preserved
 * - Map: `{"$map":[[k,v],...]}` sorted by the canonical encoding of the key
 * - Set: `{"$set":[...]}` sorted by canonical encoding of the element
 * - Uint8Array: `{"$bytes":"<lower-case hex>"}`
 * - bigint: `{"$bigint":"<decimal>"}`
 * - numbers must be finite; NaN and Infinity are rejected
 */

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

export function canonicalize(value: unknown): string {
  return JSON.stringify(toCanonicalJson(value));
}

export function toCanonicalJson(value: unknown): JsonValue {
  if (value === null) return null;
  switch (typeof value) {
    case "boolean":
    case "string":
      return value;
    case "number":
      if (!Number.isFinite(value)) {
        throw new TypeError(`canonicalize: non-finite number ${value}`);
      }
      return Object.is(value, -0) ? 0 : value;
    case "bigint":
      return { $bigint: value.toString(10) };
    case "undefined":
      throw new TypeError("canonicalize: undefined is not representable");
    case "object":
      break;
    default:
      throw new TypeError(`canonicalize: unsupported type ${typeof value}`);
  }
  if (value instanceof Uint8Array) {
    return { $bytes: bytesToHex(value) };
  }
  if (Array.isArray(value)) {
    return value.map((item) => toCanonicalJson(item));
  }
  if (value instanceof Map) {
    const entries = [...value.entries()].map(([k, v]) => {
      const key = toCanonicalJson(k);
      return { sortKey: JSON.stringify(key), key, val: toCanonicalJson(v) };
    });
    entries.sort((a, b) => compareStrings(a.sortKey, b.sortKey));
    for (let i = 1; i < entries.length; i += 1) {
      if (entries[i]!.sortKey === entries[i - 1]!.sortKey) {
        throw new TypeError(`canonicalize: duplicate canonical map key ${entries[i]!.sortKey}`);
      }
    }
    return { $map: entries.map((e) => [e.key, e.val]) };
  }
  if (value instanceof Set) {
    const items = [...value].map((item) => {
      const val = toCanonicalJson(item);
      return { sortKey: JSON.stringify(val), val };
    });
    items.sort((a, b) => compareStrings(a.sortKey, b.sortKey));
    return { $set: items.map((i) => i.val) };
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort(compareStrings);
  const out: Record<string, JsonValue> = {};
  for (const key of keys) {
    const item = record[key];
    if (item === undefined) continue;
    out[key] = toCanonicalJson(item);
  }
  return out;
}

export function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function compareNumbers(a: number, b: number): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

const HEX = "0123456789abcdef";

export function bytesToHex(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += 1) {
    const b = bytes[i]!;
    out += HEX[b >> 4]! + HEX[b & 0x0f]!;
  }
  return out;
}

export function hexToBytes(hex: string): Uint8Array {
  if (hex.length % 2 !== 0 || !/^[0-9a-f]*$/.test(hex)) {
    throw new TypeError(`hexToBytes: invalid hex string`);
  }
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i += 1) {
    out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}

export function utf8Encode(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

export function utf8Decode(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}
