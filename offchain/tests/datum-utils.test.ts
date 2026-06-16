/**
 * Audit H3 — `extractInlineDatum` standardises the inline-datum check that was
 * implemented three slightly-different ways. The helper only calls `kind()` and
 * `asInlineData()`, so fakes suffice.
 */

import { describe, expect, test } from "bun:test";
import { extractInlineDatum } from "@/helpers/datumUtils.js";

const fakeInline = { _tag: "plutus-data" };

describe("extractInlineDatum", () => {
  test("inline datum (kind 1) → returns the inline PlutusData", () => {
    const datum = { kind: () => 1, asInlineData: () => fakeInline };
    expect(extractInlineDatum(datum as never)).toBe(fakeInline as never);
  });

  test("hash-only datum (kind 0) → null", () => {
    const datum = { kind: () => 0, asDataHash: () => "abcd" };
    expect(extractInlineDatum(datum as never)).toBeNull();
  });

  test("null / undefined datum → null", () => {
    expect(extractInlineDatum(null)).toBeNull();
    expect(extractInlineDatum(undefined)).toBeNull();
  });

  test("datum object without a kind() method → null (defensive)", () => {
    expect(extractInlineDatum({} as never)).toBeNull();
  });

  test("kind 1 but asInlineData() returns undefined → null", () => {
    const datum = { kind: () => 1, asInlineData: () => undefined };
    expect(extractInlineDatum(datum as never)).toBeNull();
  });

  test("kind 1 but no asInlineData method → null (optional chain)", () => {
    const datum = { kind: () => 1 };
    expect(extractInlineDatum(datum as never)).toBeNull();
  });
});
