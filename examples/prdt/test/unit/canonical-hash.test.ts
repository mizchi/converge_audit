import { describe, expect, it } from "vitest";
import { bytesToHex, canonicalize, hexToBytes, utf8Encode } from "../../src/core/canonical.ts";
import { sha256, sha256Hasher } from "../../src/core/hash.ts";

describe("canonical serialization", () => {
  it("sorts object keys and Map entries independently of insertion order", () => {
    const a = canonicalize({ b: 1, a: new Map([["y", 2], ["x", 1]]) });
    const b = canonicalize({ a: new Map([["x", 1], ["y", 2]]), b: 1 });
    expect(a).toBe(b);
    expect(a).toBe('{"a":{"$map":[["x",1],["y",2]]},"b":1}');
  });

  it("encodes Set, bytes, and drops undefined", () => {
    expect(canonicalize({ s: new Set([3, 1, 2]), u: undefined, b: new Uint8Array([0, 255]) })).toBe(
      '{"b":{"$bytes":"00ff"},"s":{"$set":[1,2,3]}}',
    );
  });

  it("rejects non-finite numbers", () => {
    expect(() => canonicalize({ x: Number.NaN })).toThrow(TypeError);
    expect(() => canonicalize([Number.POSITIVE_INFINITY])).toThrow(TypeError);
  });

  it("round-trips hex", () => {
    expect(hexToBytes(bytesToHex(new Uint8Array([1, 2, 254])))).toEqual(new Uint8Array([1, 2, 254]));
    expect(() => hexToBytes("abc")).toThrow(TypeError);
  });
});

describe("sha256", () => {
  it("matches FIPS test vectors", () => {
    expect(bytesToHex(sha256(utf8Encode("")))).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    expect(bytesToHex(sha256(utf8Encode("abc")))).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    expect(
      bytesToHex(sha256(utf8Encode("abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq"))),
    ).toBe("248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1");
  });

  it("handles messages that span the padding boundary", () => {
    // 55, 56, 63, 64 byte messages exercise the one-block/two-block padding edge.
    const expected: Record<number, string> = {
      55: "9f4390f8d30c2dd92ec9f095b65e2b9ae9b0a925a5258e241c9f1e910f734318",
      56: "b35439a4ac6f0948b6d6f9e3c6af0f5f590ce20f1bde7090ef7970686ec6738a",
      64: "ffe054fe7ae0cb6dc65c3af9b61d5209f439851db43d0ba5997337df154668eb",
    };
    for (const [length, digest] of Object.entries(expected)) {
      expect(bytesToHex(sha256(utf8Encode("a".repeat(Number(length)))))).toBe(digest);
    }
  });

  it("hasher is a function of the canonical string only", () => {
    expect(sha256Hasher("x")).toBe(sha256Hasher("x"));
    expect(sha256Hasher("x")).not.toBe(sha256Hasher("y"));
  });
});
