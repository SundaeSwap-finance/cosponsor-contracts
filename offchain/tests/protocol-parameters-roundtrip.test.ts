/**
 * ProtocolParameters end-to-end representation (D7).
 *
 * Three things must agree for a ParameterChange to validate on-chain:
 *  1. the datum's `new_parameters` Data (schema + manual builders) —
 *     `Map [(I id, value)]` ascending, ints as I, rationals as List [I,I],
 *     exactly the ledger's ToPlutusData translation of the update;
 *  2. the field-20 CBOR (`encodeGovernanceAction`) — the Conway
 *     `parameter_change_action` the ledger translates back into (1) for the
 *     script context (`list.has` compares structurally);
 *  3. the parse path — hash-lossless round-trip (same bug class as the
 *     TreasuryWithdrawal guardrails asymmetry).
 */

import { describe, expect, test } from "bun:test";
import { serialize } from "@blaze-cardano/data";
import {
  Cosponsor,
  type ICosponsoredProposal,
} from "@/validators/Cosponsor.js";
import { parseCosponsorDatum } from "@/helpers/parseCosponsorDatum.js";
import { CosponsorTypes } from "@/validators/GeneratedTypes/index.js";
import type { IProtocolParameters } from "@/validators/Types/GovernanceAction.js";
import { computeProposalAssetName } from "@/validators/Types/GovernanceAction.js";
import { encodeGovernanceAction } from "@/utils/proposeBody.js";
import { BROWSER_CONFIG } from "@/browser/BrowserConfig.js";

const STATE_POLICY = BROWSER_CONFIG.statePolicyId;
const ANCHOR_URL = Buffer.from("https://example.com/pp.json").toString("hex");
const ANCHOR_HASH = "0".repeat(64);
const GUARDRAILS = "fa24fb305126805cf2164c161d852a0e7330cf988f1fe558cf7d4a64";
const ANCESTOR = {
  txHash: "2a2dc37b22939d3ae7395c8a409d4d0625201c88926d641d6f4441c3287e39ba",
  index: 0,
};

const ppProposal = (
  action: Partial<IProtocolParameters>,
): ICosponsoredProposal => ({
  deposit: 1_000_000_000n,
  anchor: { url: ANCHOR_URL, hash: ANCHOR_HASH },
  action: {
    kind: "ProtocolParameters",
    ancestor: ANCESTOR,
    ...action,
  } as IProtocolParameters,
});

const parseProposal = (proposal: ICosponsoredProposal) => {
  const cosponsor = Cosponsor.new({
    statePolicyId: STATE_POLICY,
    cosponsoredProposal: proposal,
  });
  return { cosponsor, parsed: parseCosponsorDatum(cosponsor.datum()) };
};

const gAdaOf = (proposal: ICosponsoredProposal) =>
  Cosponsor.new({
    statePolicyId: STATE_POLICY,
    cosponsoredProposal: proposal,
  }).gAda();

describe("ProtocolParameters datum round-trip", () => {
  const FIXTURE: Partial<IProtocolParameters> = {
    newParameters: [[3n, 16400n]],
    guardRails: GUARDRAILS,
  };

  test("newParameters + guardrails round-trip through build → parse", () => {
    const { parsed } = parseProposal(ppProposal(FIXTURE));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const action = parsed.value.proposal.action as IProtocolParameters;
    expect(action.kind).toBe("ProtocolParameters");
    expect(action.newParameters).toEqual([[3n, 16400n]]);
    expect(action.guardRails).toBe(GUARDRAILS);
    expect(action.ancestor).toEqual(ANCESTOR);
  });

  test("rational param values round-trip", () => {
    const { parsed } = parseProposal(
      ppProposal({
        newParameters: [[10n, { numerator: 51n, denominator: 100n }]],
      }),
    );
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const action = parsed.value.proposal.action as IProtocolParameters;
    expect(action.newParameters).toEqual([
      [10n, { numerator: 51n, denominator: 100n }],
    ]);
  });

  test("manual builder agrees with schema path (gADA token name)", () => {
    const proposal = ppProposal(FIXTURE);
    const builderName = computeProposalAssetName(
      {
        deposit: proposal.deposit,
        anchor: proposal.anchor,
        action: proposal.action,
      },
      BROWSER_CONFIG.scripts.cosponsor.hash,
    );
    expect(builderName).toBe(gAdaOf(proposal));
  });

  test("manual builder agrees with schema path for the EMPTY update (hash stability)", () => {
    // No-newParameters proposals must keep their pre-change token names.
    const proposal = ppProposal({});
    const builderName = computeProposalAssetName(
      {
        deposit: proposal.deposit,
        anchor: proposal.anchor,
        action: proposal.action,
      },
      BROWSER_CONFIG.scripts.cosponsor.hash,
    );
    expect(builderName).toBe(gAdaOf(proposal));
  });

  test("rebuild is hash-lossless (raw hash == build-time token name)", () => {
    const { cosponsor, parsed } = parseProposal(ppProposal(FIXTURE));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const rawHash = serialize(
      CosponsorTypes.CosponsoredProposalProcedure,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      parsed.value.rawCosponsoredProposal as any,
    ).hash();
    expect(String(rawHash)).toBe(cosponsor.gAda());
  });

  test("entries are sorted ascending regardless of input order; duplicates throw", () => {
    const unsorted = ppProposal({ newParameters: [[10n, 1n], [3n, 16400n]] });
    const sorted = ppProposal({ newParameters: [[3n, 16400n], [10n, 1n]] });
    expect(gAdaOf(unsorted)).toBe(gAdaOf(sorted));
    expect(() =>
      gAdaOf(ppProposal({ newParameters: [[3n, 1n], [3n, 2n]] })),
    ).toThrow("duplicate param id");
  });
});

describe("ProtocolParameters field-20 encoding", () => {
  test("golden: maxTxSize 16400 with ancestor + guardrails", () => {
    const hex = encodeGovernanceAction({
      kind: "ProtocolParameters",
      ancestor: ANCESTOR,
      newParameters: [[3n, 16400n]],
      guardRails: GUARDRAILS,
    });
    expect(hex).toBe(
      "8400" + // parameter_change_action, tag 0 (4-element array)
        "825820" + ANCESTOR.txHash + "00" + // prev gov action id
        "a103194010" + // {3: 16400}
        "581c" + GUARDRAILS, // policy hash
    );
  });

  test("rational values encode as tag-30 rationals", () => {
    const hex = encodeGovernanceAction({
      kind: "ProtocolParameters",
      ancestor: null,
      newParameters: [[10n, { numerator: 51n, denominator: 100n }]],
    });
    expect(hex).toBe("8400" + "f6" + "a10ad81e8218331864" + "f6");
  });

  test("empty update is refused (ledger MalformedProposal)", () => {
    expect(() =>
      encodeGovernanceAction({
        kind: "ProtocolParameters",
        ancestor: null,
      }),
    ).toThrow("NON-empty");
  });
});
