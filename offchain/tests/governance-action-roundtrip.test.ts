/**
 * Audit L13 — one round-trip case per governance-action variant. For each:
 * build the datum, parse it back, re-serialize the preserved raw procedure, and
 * assert its hash equals the build-time gADA token name. This is the
 * load-bearing invariant (token name = procedure-CBOR hash) the on-chain
 * validator enforces, exercised across all 7 variants incl. ones carrying data
 * (TreasuryWithdrawal beneficiaries, ConstitutionalCommittee members,
 * NewConstitution guardrails).
 */

import { describe, expect, test } from "bun:test";
import { serialize } from "@blaze-cardano/data";
import {
  Cosponsor,
  type ICosponsoredProposal,
} from "@/validators/Cosponsor.js";
import { parseCosponsorDatum } from "@/helpers/parseCosponsorDatum.js";
import { CosponsorTypes } from "@/validators/GeneratedTypes/index.js";
import type { TGovernanceAction } from "@/validators/Types/GovernanceAction.js";
import { BROWSER_CONFIG } from "@/browser/BrowserConfig.js";

const STATE_POLICY = BROWSER_CONFIG.statePolicyId;
const ANCHOR = {
  url: Buffer.from("https://example.com/p.json").toString("hex"),
  hash: "0".repeat(64),
};
const H28 = "ab".repeat(28);

const VARIANTS: Array<[string, TGovernanceAction]> = [
  ["NicePoll", { kind: "NicePoll" }],
  ["NoConfidence", { kind: "NoConfidence", ancestor: null }],
  ["ProtocolParameters", { kind: "ProtocolParameters", ancestor: null }],
  [
    "HardFork",
    { kind: "HardFork", ancestor: null, version: { major: 10, minor: 0 } },
  ],
  [
    "TreasuryWithdrawal",
    {
      kind: "TreasuryWithdrawal",
      beneficiaries: new Map([[{ script: H28 }, 5_000_000n]]),
      guardRails: undefined,
    },
  ],
  [
    "ConstitutionalCommittee",
    {
      kind: "ConstitutionalCommittee",
      ancestor: null,
      membersToRemove: [{ vkey: "cd".repeat(28) }],
      membersToAdd: new Map([[{ script: H28 }, 100n]]),
      quorum: { numerator: 1n, denominator: 2n },
    },
  ],
  [
    "NewConstitution",
    { kind: "NewConstitution", ancestor: null, guardrails: H28 },
  ],
];

describe("governance-action datum round-trip (audit L13)", () => {
  for (const [name, action] of VARIANTS) {
    test(`${name}: raw procedure re-hash equals build-time token name`, () => {
      const proposal: ICosponsoredProposal = {
        deposit: 10_000_000n,
        anchor: ANCHOR,
        action,
      };
      const cosponsor = Cosponsor.new({
        statePolicyId: STATE_POLICY,
        cosponsoredProposal: proposal,
      });
      const buildTime = cosponsor.gAda();

      const parsed = parseCosponsorDatum(cosponsor.datum());
      expect(parsed.ok).toBe(true);
      if (!parsed.ok) return;
      expect(parsed.value.datumType).toBe("Before");

      const rawHash = serialize(
        CosponsorTypes.CosponsoredProposalProcedure,

        parsed.value.rawCosponsoredProposal as any,
      ).hash();
      expect(String(rawHash)).toBe(buildTime);
    });
  }
});
