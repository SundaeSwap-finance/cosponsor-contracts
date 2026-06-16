/**
 * Audit H4 — the shared `resolveCosponsorScriptReference` unifies the
 * deposit/withdrawal script-ref resolution. These tests pin the provider-path
 * hash check (AUDIT.md F26) that the withdrawal copy previously lacked, plus
 * the fallback guard. The provider is a tiny fake — the function only touches
 * `resolveScriptRef` / `output().scriptRef().hash()` on that path.
 */

import { describe, expect, test } from "bun:test";
import { resolveCosponsorScriptReference } from "@/browser/scriptRefResolver.js";
import { BROWSER_CONFIG } from "@/browser/BrowserConfig.js";

const HASH = BROWSER_CONFIG.scripts.cosponsor.hash;
const OTHER_HASH = "ab".repeat(28); // valid 28-byte hex, different from HASH
const ADDR = BROWSER_CONFIG.scriptReferenceAddress;
const REF_UTXO = BROWSER_CONFIG.scriptReferenceUtxos.cosponsor;

const fakeBlaze = (resolveScriptRef: () => Promise<any>): any => ({
  provider: {
    resolveScriptRef,
    resolveUnspentOutputs: async () => [],
  },
});

const refWithHash = (hash: string) => ({
  output: () => ({ scriptRef: () => ({ hash: () => hash }) }),
});

const baseConfig = {
  scriptHash: HASH,
  scriptReferenceAddress: ADDR,
  referenceUtxo: REF_UTXO,
  fallbackCbor: undefined,
};

describe("resolveCosponsorScriptReference — provider path (F26 hash check)", () => {
  test("returns the provider ref when its script hash matches", async () => {
    const ref = refWithHash(HASH);
    const out = await resolveCosponsorScriptReference(
      fakeBlaze(async () => ref),
      baseConfig,
    );
    expect(out).toBe(ref as never);
  });

  test("throws on hash mismatch (withdrawal path previously skipped this)", async () => {
    await expect(
      resolveCosponsorScriptReference(
        fakeBlaze(async () => refWithHash(OTHER_HASH)),
        baseConfig,
      ),
    ).rejects.toThrow(/hash mismatch/i);
  });

  test("throws when the resolved ref has no attached script", async () => {
    const ref = { output: () => ({ scriptRef: () => null }) };
    await expect(
      resolveCosponsorScriptReference(
        fakeBlaze(async () => ref),
        baseConfig,
      ),
    ).rejects.toThrow(/no attached script/i);
  });
});

describe("resolveCosponsorScriptReference — fallback guard", () => {
  test("throws a clear error when provider fails and no fallback CBOR is set", async () => {
    await expect(
      resolveCosponsorScriptReference(
        fakeBlaze(async () => undefined),
        {
          ...baseConfig,
          fallbackCbor: undefined,
        },
      ),
    ).rejects.toThrow(/Cannot resolve script reference/);
  });
});
