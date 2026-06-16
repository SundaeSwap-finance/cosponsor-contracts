/**
 * TreasuryWithdrawal guardrails round-trip.
 *
 * The on-chain `TreasuryWithdrawal` carries `guardrails: Option<ScriptHash>`
 * (aiken-lang-stdlib `cardano/governance.ak`). The parse paths preserved it,
 * and `ToContractType` (schema path) encoded it — but the manual builder
 * `buildTreasuryWithdrawalAsPlutusData` hardcoded `None`, an asymmetric
 * round-trip: any TW datum with guardrails=Some failed the
 * `extractCosponsoredProposalFromDatum` hash check (→ null → UI rebuild
 * fallback), and the Node (schema) vs browser (builder) mint paths produced
 * DIFFERENT gADA tokens for the same proposal.
 *
 * Mirrors tests/new-constitution-guardrails.test.ts (audit H2).
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
import { computeProposalAssetName } from "@/validators/Types/GovernanceAction.js";
import type { TCredential } from "@/validators/Types/Credential.js";
import { BROWSER_CONFIG } from "@/browser/BrowserConfig.js";

const STATE_POLICY = BROWSER_CONFIG.statePolicyId;
const ANCHOR_URL = Buffer.from("https://example.com/tw.json").toString("hex");
const ANCHOR_HASH = "0".repeat(64);
const GUARDRAILS = "cd".repeat(28); // 28-byte ScriptHash hex

const BENEFICIARIES: Array<[TCredential, bigint]> = [
  [{ vkey: "11".repeat(28) }, 1_000_000n],
  [{ script: "22".repeat(28) }, 2_500_000n],
];

const twProposal = (guardRails?: string): ICosponsoredProposal => ({
  deposit: 50_000_000n,
  anchor: { url: ANCHOR_URL, hash: ANCHOR_HASH },
  action: {
    kind: "TreasuryWithdrawal",
    beneficiaries: BENEFICIARIES,
    guardRails,
  },
});

const parseProposal = (proposal: ICosponsoredProposal) => {
  const cosponsor = Cosponsor.new({
    statePolicyId: STATE_POLICY,
    cosponsoredProposal: proposal,
  });
  return { cosponsor, parsed: parseCosponsorDatum(cosponsor.datum()) };
};

describe("TreasuryWithdrawal guardrails round-trip", () => {
  test("guardrails Some round-trips through build → parse", () => {
    const { parsed } = parseProposal(twProposal(GUARDRAILS));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const action = parsed.value.proposal.action as ITreasuryWithdrawal;
    expect(action.kind).toBe("TreasuryWithdrawal");
    expect(action.guardRails).toBe(GUARDRAILS);
  });

  test("guardrails None round-trips to undefined", () => {
    const { parsed } = parseProposal(twProposal(undefined));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const action = parsed.value.proposal.action as ITreasuryWithdrawal;
    expect(action.guardRails).toBeUndefined();
  });

  test("manual builder agrees with schema path for guardrails Some (the bug)", () => {
    // Before the fix the builder hardcoded None → computeProposalAssetName
    // (manual path) and Cosponsor.gAda() (schema path) returned DIFFERENT
    // token names for the same Some-guardrails proposal.
    const proposal = twProposal(GUARDRAILS);
    const schemaName = Cosponsor.new({
      statePolicyId: STATE_POLICY,
      cosponsoredProposal: proposal,
    }).gAda();
    const builderName = computeProposalAssetName(
      {
        deposit: proposal.deposit,
        anchor: proposal.anchor,
        action: proposal.action,
      },
      BROWSER_CONFIG.scripts.cosponsor.hash,
    );
    expect(builderName).toBe(schemaName);
  });

  test("rebuild is hash-lossless for Some (raw hash == build-time token name)", () => {
    const { cosponsor, parsed } = parseProposal(twProposal(GUARDRAILS));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const rawHash = serialize(
      CosponsorTypes.CosponsoredProposalProcedure,

      parsed.value.rawCosponsoredProposal as any,
    ).hash();
    expect(String(rawHash)).toBe(cosponsor.gAda());
  });

  test("guardrails Some and None hash to DIFFERENT token names", () => {
    const someName = Cosponsor.new({
      statePolicyId: STATE_POLICY,
      cosponsoredProposal: twProposal(GUARDRAILS),
    }).gAda();
    const noneName = Cosponsor.new({
      statePolicyId: STATE_POLICY,
      cosponsoredProposal: twProposal(undefined),
    }).gAda();
    expect(someName).not.toBe(noneName);
  });

  test("None encoding unchanged: builder still matches schema with no guardrails", () => {
    // Hash-stability for every existing on-chain TW token (all None today).
    const proposal = twProposal(undefined);
    const schemaName = Cosponsor.new({
      statePolicyId: STATE_POLICY,
      cosponsoredProposal: proposal,
    }).gAda();
    const builderName = computeProposalAssetName(
      {
        deposit: proposal.deposit,
        anchor: proposal.anchor,
        action: proposal.action,
      },
      BROWSER_CONFIG.scripts.cosponsor.hash,
    );
    expect(builderName).toBe(schemaName);
  });
});
