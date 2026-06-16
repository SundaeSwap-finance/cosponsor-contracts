/**
 * Audit H5 — the "two hand-coded variant tables" claim is refuted:
 * `extractActionKindFromDatum` is generic (`Object.keys(govAction)[0]`), not an
 * enumeration, and parse() already schema-validates the variant. There is no
 * shared table to introduce. These tests lock the extractor's behaviour across
 * every governance-action variant + After + malformed input so a future change
 * can't silently regress it.
 */

import { describe, expect, test } from "bun:test";
import { serialize } from "@blaze-cardano/data";
import { PlutusData, PlutusList, ConstrPlutusData } from "@blaze-cardano/core";
import {
  Cosponsor,
  type ICosponsoredProposal,
} from "@/validators/Cosponsor.js";
import { CosponsorTypes } from "@/validators/GeneratedTypes/index.js";
import type { TGovernanceAction } from "@/validators/Types/GovernanceAction.js";
import { extractActionKindFromDatum } from "@/browser/fetchUserDeposits.js";
import { BROWSER_CONFIG } from "@/browser/BrowserConfig.js";

const STATE_POLICY = BROWSER_CONFIG.statePolicyId;
const ANCHOR = {
  url: Buffer.from("https://example.com/p.json").toString("hex"),
  hash: "0".repeat(64),
};

const datumFor = (action: TGovernanceAction): PlutusData => {
  const proposal: ICosponsoredProposal = {
    deposit: 10_000_000n,
    anchor: ANCHOR,
    action,
  };
  return Cosponsor.new({
    statePolicyId: STATE_POLICY,
    cosponsoredProposal: proposal,
  }).datum() as unknown as PlutusData;
};

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
      beneficiaries: new Map(),
      guardRails: undefined,
    },
  ],
  [
    "ConstitutionalCommittee",
    {
      kind: "ConstitutionalCommittee",
      ancestor: null,
      membersToRemove: [],
      membersToAdd: new Map(),
      quorum: { numerator: 1n, denominator: 2n },
    },
  ],
  ["NewConstitution", { kind: "NewConstitution", ancestor: null }],
];

describe("extractActionKindFromDatum — every variant", () => {
  for (const [kind, action] of VARIANTS) {
    test(`${kind} → "${kind}"`, () => {
      expect(extractActionKindFromDatum(datumFor(action))).toBe(kind);
    });
  }
});

describe("extractActionKindFromDatum — non-Before / malformed", () => {
  test("After datum → null", () => {
    const afterDatum = serialize(
      CosponsorTypes.CosponsorDatum,
      "After",
    ) as unknown as PlutusData;
    expect(extractActionKindFromDatum(afterDatum)).toBeNull();
  });

  test("malformed datum (Constr 99) → null", () => {
    const malformed = PlutusData.newConstrPlutusData(
      new ConstrPlutusData(99n, new PlutusList()),
    );
    expect(extractActionKindFromDatum(malformed)).toBeNull();
  });
});
