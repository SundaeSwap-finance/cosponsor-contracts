/**
 * Audit H10 / L10 — the shared CIP-25 chunker (`chunkUtf8`) must never split a
 * Unicode code point, must keep every chunk ≤ 64 UTF-8 bytes, and must
 * reassemble to the original. The old `i -= shrink` loops indexed by UTF-16
 * code unit and could cut a 4-byte emoji's surrogate pair in half.
 */

import { describe, expect, test } from "bun:test";
import { chunkUtf8, chunkCip25Text } from "@/utils/cip25.js";

const bytes = (s: string) => Buffer.byteLength(s, "utf8");
// A chunk that split a surrogate pair would not survive a UTF-8 round-trip.
const isCleanUtf8 = (s: string) =>
  Buffer.from(s, "utf8").toString("utf8") === s;

const assertValidChunks = (value: string, chunks: string[]) => {
  expect(chunks.join("")).toBe(value); // lossless reassembly
  for (const c of chunks) {
    expect(bytes(c)).toBeLessThanOrEqual(64);
    expect(isCleanUtf8(c)).toBe(true); // no split code point
  }
};

describe("chunkUtf8 — expected behaviour", () => {
  test("a ≤64-byte string is a single chunk", () => {
    expect(chunkUtf8("hello")).toEqual(["hello"]);
  });

  test("long ASCII splits into ≤64-byte chunks that reassemble", () => {
    const value = "a".repeat(200);
    const chunks = chunkUtf8(value);
    expect(chunks.length).toBe(Math.ceil(200 / 64));
    assertValidChunks(value, chunks);
  });
});

describe("chunkUtf8 — multibyte / emoji (the regression)", () => {
  test("a 4-byte emoji straddling the 64-byte boundary is not split", () => {
    // 63 ASCII bytes + a 4-byte emoji: the emoji can't fit in chunk 0 (63+4>64),
    // so it must move whole to chunk 1 — never cut.
    const value = `${"a".repeat(63)}\u{1F600}`;
    const chunks = chunkUtf8(value);
    expect(chunks[0]).toBe("a".repeat(63));
    expect(chunks[1]).toBe("\u{1F600}");
    assertValidChunks(value, chunks);
  });

  test("a long run of 4-byte emoji stays intact and bounded", () => {
    const value = "\u{1F600}".repeat(40); // 160 UTF-8 bytes, 80 UTF-16 units
    const chunks = chunkUtf8(value);
    assertValidChunks(value, chunks);
    // 16 emoji = exactly 64 bytes per chunk.
    expect(chunks.length).toBe(Math.ceil(40 / 16));
  });

  test("mixed ASCII + emoji reassembles losslessly", () => {
    const value = "hello \u{1F680} world \u{1F44D} ".repeat(10).trim();
    assertValidChunks(value, chunkUtf8(value));
  });
});

describe("chunkCip25Text — Metadatum shape", () => {
  test("short value → single text Metadatum (no throw)", () => {
    expect(() => chunkCip25Text("short")).not.toThrow();
  });

  test("long value → list Metadatum (no throw)", () => {
    expect(() => chunkCip25Text("a".repeat(500))).not.toThrow();
  });
});
