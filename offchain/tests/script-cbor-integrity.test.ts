/**
 * Audit H9 — `verifyCosponsorScriptCbor` recomputes the script hash from the
 * pre-computed CBOR and throws on mismatch, so a stale blob fails fast.
 */

import { describe, expect, test } from "bun:test";
import {
  BROWSER_CONFIG,
  verifyCosponsorScriptCbor,
} from "@/browser/BrowserConfig.js";

describe("verifyCosponsorScriptCbor (audit H9)", () => {
  test("the shipped CBOR matches its recorded hash (no throw)", () => {
    expect(() => verifyCosponsorScriptCbor()).not.toThrow();
  });

  test("a tampered expected hash throws a clear mismatch error", () => {
    expect(() =>
      verifyCosponsorScriptCbor(
        BROWSER_CONFIG.scripts.cosponsor.cbor,
        "00".repeat(28),
      ),
    ).toThrow(/CBOR\/hash mismatch/);
  });

  test("the recomputed hash equals BROWSER_CONFIG's recorded hash", () => {
    // Indirectly asserts the self-check is meaningful: defaults validate clean.
    expect(BROWSER_CONFIG.scripts.cosponsor.hash).toMatch(/^[0-9a-f]{56}$/);
    expect(() =>
      verifyCosponsorScriptCbor(
        BROWSER_CONFIG.scripts.cosponsor.cbor,
        BROWSER_CONFIG.scripts.cosponsor.hash,
      ),
    ).not.toThrow();
  });
});
