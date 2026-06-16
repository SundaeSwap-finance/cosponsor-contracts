/**
 * Audit H1 — `fromContractType` is lossy for TreasuryWithdrawal `beneficiaries`
 * / ConstitutionalCommittee `addedMembers` (returns `[]`). The fix makes
 * `fetch-submissions.getProposalHash` hash the preserved
 * `rawCosponsoredProposal` instead of rebuilding from the typed action.
 *
 * These tests prove, for a TreasuryWithdrawal proposal WITH real beneficiaries:
 *   1. hashing the raw parsed procedure reproduces the build-time gADA token
 *      name (the fix is correct), and
 *   2. rebuilding from the typed action (the old code path) produces a
 *      DIFFERENT, wrong hash (the bug the fix avoids), and
 *   3. the typed action really does drop the beneficiaries.
 */

import { describe, expect, test } from "bun:test";
import { serialize } from "@blaze-cardano/data";
import {
  Cosponsor,
  type ICosponsoredProposal,
} from "@/validators/Cosponsor.js";
import { parseCosponsorDatum } from "@/helpers/parseCosponsorDatum.js";
import { CosponsorTypes } from "@/validators/GeneratedTypes/index.js";
import type { ITreasuryWithdrawal } from "@/validators/Types/GovernanceAction.js";
import { BROWSER_CONFIG } from "@/browser/BrowserConfig.js";

const STATE_POLICY = BROWSER_CONFIG.statePolicyId;
const ANCHOR_URL = Buffer.from("https://example.com/treasury.json").toString(
  "hex",
);
const ANCHOR_HASH = "0".repeat(64);

const treasuryProposal = (): ICosponsoredProposal => ({
  deposit: 100_000_000n,
  anchor: { url: ANCHOR_URL, hash: ANCHOR_HASH },
  action: {
    kind: "TreasuryWithdrawal",
    beneficiaries: new Map([
      [{ script: "ab".repeat(28) }, 5_000_000n],
      [{ vkey: "cd".repeat(28) }, 3_000_000n],
    ]),
    guardRails: undefined,
  },
});

describe("getProposalHash via rawCosponsoredProposal (audit H1)", () => {
  const cosponsor = Cosponsor.new({
    statePolicyId: STATE_POLICY,
    cosponsoredProposal: treasuryProposal(),
  });
  // Build-time gADA token name: the proposal serialized WITH its beneficiaries.
  const buildTimeTokenName = cosponsor.gAda();
  const datum = cosponsor.datum();
  const parsed = parseCosponsorDatum(datum);

  test("the datum round-trips through parseCosponsorDatum", () => {
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.value.datumType).toBe("Before");
  });

  test("hashing the RAW procedure reproduces the build-time token name (the fix)", () => {
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const rawHash = serialize(
      CosponsorTypes.CosponsoredProposalProcedure,

      parsed.value.rawCosponsoredProposal as any,
    ).hash();
    expect(String(rawHash)).toBe(buildTimeTokenName);
  });

  test("the typed action DROPS beneficiaries (why the raw path is required)", () => {
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const action = parsed.value.proposal.action as ITreasuryWithdrawal;
    expect(action.kind).toBe("TreasuryWithdrawal");
    expect(action.beneficiaries).toEqual([]);
  });

  test("rebuilding from the typed action gives a DIFFERENT (wrong) hash", () => {
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    // This mirrors the OLD getProposalHash: Cosponsor.new(typed).gAda().
    const rebuiltHash = Cosponsor.new({
      statePolicyId: STATE_POLICY,
      cosponsoredProposal: parsed.value.proposal,
    }).gAda();
    expect(rebuiltHash).not.toBe(buildTimeTokenName);
  });
});
