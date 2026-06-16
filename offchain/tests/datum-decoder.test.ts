/**
 * Datum decoder behaviour — covers AUDIT.md F9 (parseCosponsorDatum
 * discriminated result), F11 (After-check reachability), F12/F13 (helper
 * returns null on failure rather than empty-string sentinels), and F8
 * (legacy fetchUserDeposits' lying fallback is gone).
 *
 * Synthetic on-chain datums are built by passing JS-shape data through the
 * canonical serialize() path, then re-decoded by the helpers under test.
 */

import { describe, expect, test } from "bun:test";
import { serialize } from "@blaze-cardano/data";
import { PlutusData, PlutusList, ConstrPlutusData } from "@blaze-cardano/core";
import { CosponsorTypes } from "@/validators/GeneratedTypes/index.js";
import {
  computeProposalHashFromDatum,
  extractActionKindFromDatum,
  extractAnchorFromDatum,
  extractCosponsoredProposalFromDatum,
} from "@/browser/fetchUserDeposits.js";
import { parseCosponsorDatum } from "@/helpers/parseCosponsorDatum.js";
import { computeProposalAssetName } from "@/validators/Types/GovernanceAction.js";
import { BROWSER_CONFIG } from "@/browser/BrowserConfig.js";

const HASH28 = "00".repeat(28);
const ANCHOR_URL_HEX = Buffer.from(
  "https://cosponsor.app/proposal/probe",
).toString("hex");
const ANCHOR_HASH = "0".repeat(64);

const beforeDatumNicePoll = (): PlutusData =>
  serialize(CosponsorTypes.CosponsorDatum, {
    Before: {
      cosponsored: {
        procedure: {
          deposit: 100_000_000_000n,
          returnAddress: { ScriptCredential: [HASH28] },
          governanceAction: "NicePoll",
        },
        anchor: { url: ANCHOR_URL_HEX, hash: ANCHOR_HASH },
      },
    },
  });

const afterDatum = (): PlutusData =>
  serialize(CosponsorTypes.CosponsorDatum, "After");

const malformedDatum = (): PlutusData =>
  // Constr 99 with no fields — not a valid CosponsorDatum variant.
  PlutusData.newConstrPlutusData(new ConstrPlutusData(99n, new PlutusList()));

describe("Datum decoders return null on failure (F12, F13)", () => {
  test("computeProposalHashFromDatum: Before datum → real hash", () => {
    const hash = computeProposalHashFromDatum(beforeDatumNicePoll());
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  test("computeProposalHashFromDatum: After datum → null (was empty string)", () => {
    expect(computeProposalHashFromDatum(afterDatum())).toBeNull();
  });

  test("computeProposalHashFromDatum: malformed datum → null (was empty string)", () => {
    expect(computeProposalHashFromDatum(malformedDatum())).toBeNull();
  });

  test("extractActionKindFromDatum: Before NicePoll → 'NicePoll'", () => {
    expect(extractActionKindFromDatum(beforeDatumNicePoll())).toBe("NicePoll");
  });

  test("extractActionKindFromDatum: After datum → null (was 'Processed')", () => {
    expect(extractActionKindFromDatum(afterDatum())).toBeNull();
  });

  test("extractActionKindFromDatum: malformed datum → null (was 'Unknown')", () => {
    expect(extractActionKindFromDatum(malformedDatum())).toBeNull();
  });

  test("extractAnchorFromDatum: Before datum → real anchor", () => {
    const anchor = extractAnchorFromDatum(beforeDatumNicePoll());
    expect(anchor).toEqual({ url: ANCHOR_URL_HEX, hash: ANCHOR_HASH });
  });

  test("extractAnchorFromDatum: After datum → null (was {url:'',hash:''})", () => {
    expect(extractAnchorFromDatum(afterDatum())).toBeNull();
  });

  test("extractAnchorFromDatum: malformed datum → null (was {url:'',hash:''})", () => {
    expect(extractAnchorFromDatum(malformedDatum())).toBeNull();
  });
});

describe("parseCosponsorDatum discriminated result (F9, F11)", () => {
  test("F11: After datum is recognised (was unreachable inside typeof-object guard)", () => {
    const result = parseCosponsorDatum(afterDatum());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.datumType).toBe("After");
    }
  });

  test("Before NicePoll: discriminated result surfaces a real {kind: 'NicePoll'}", () => {
    const result = parseCosponsorDatum(beforeDatumNicePoll());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.datumType).toBe("Before");
      // Pre-audit: action was the bare string "NicePoll", so .kind was
      // undefined. fromContractType normalises it.
      expect(result.value.proposal.action.kind).toBe("NicePoll");
      expect(result.value.proposal.deposit).toBe(100_000_000_000n);
      expect(result.value.proposal.anchor.url).toBe(ANCHOR_URL_HEX);
    }
  });

  test("Malformed datum: result.ok=false with 'parse-threw' or 'unexpected-shape'", () => {
    const result = parseCosponsorDatum(malformedDatum());
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(["parse-threw", "unexpected-shape"]).toContain(result.reason);
    }
  });
});

describe("extractCosponsoredProposalFromDatum (full typed-procedure recovery)", () => {
  // Round-trip property under test: parsing an on-chain datum back to a
  // typed `ICosponsoredProposal` and feeding it back into the manual
  // builder must produce the SAME gADA token asset name. This is what lets
  // the UI's "Sponsor again from Your Pledges" flow mint into the existing
  // proposal token rather than a new one.
  const NICEPOLL_HASH = computeProposalAssetName(
    {
      deposit: 100_000_000_000n,
      anchor: { url: ANCHOR_URL_HEX, hash: ANCHOR_HASH },
      action: { kind: "NicePoll" },
    },
    BROWSER_CONFIG.scripts.cosponsor.hash,
  );

  test("NicePoll: round-trips through schema parse to typed action with matching hash", () => {
    const datum = beforeDatumNicePoll();
    const recovered = extractCosponsoredProposalFromDatum(datum, NICEPOLL_HASH);
    expect(recovered).not.toBeNull();
    if (recovered) {
      expect(recovered.action.kind).toBe("NicePoll");
      expect(recovered.deposit).toBe(100_000_000_000n);
      expect(recovered.anchor.url).toBe(ANCHOR_URL_HEX);
      expect(recovered.anchor.hash).toBe(ANCHOR_HASH);
      // Re-hashing the recovered procedure must match the expected hash.
      const reHash = computeProposalAssetName(
        recovered,
        BROWSER_CONFIG.scripts.cosponsor.hash,
      );
      expect(reHash).toBe(NICEPOLL_HASH);
    }
  });

  test("After datum: returns null", () => {
    expect(
      extractCosponsoredProposalFromDatum(afterDatum(), NICEPOLL_HASH),
    ).toBeNull();
  });

  test("Malformed datum: returns null", () => {
    expect(
      extractCosponsoredProposalFromDatum(malformedDatum(), NICEPOLL_HASH),
    ).toBeNull();
  });

  test("Hash mismatch: returns null (refuses lossy reuse)", () => {
    // Pass a deliberately wrong expected hash; the round-trip check should
    // catch the mismatch and return null rather than hand back a procedure
    // that would mint a different gADA token.
    const wrongHash = "f".repeat(64);
    expect(
      extractCosponsoredProposalFromDatum(beforeDatumNicePoll(), wrongHash),
    ).toBeNull();
  });
});
