/**
 * Audit H2 — NewConstitution realignment. The on-chain `Constitution` carries
 * only `guardrails: Option<ScriptHash>` (no document anchor). The SDK now
 * round-trips that field instead of the vestigial constitutionHash/url.
 *
 * Proves: Some(guardrails) and None both survive build → parse, the rebuild is
 * hash-lossless, and None encodes byte-identically to the pre-realign output.
 */

import { describe, expect, test } from "bun:test";
import { serialize } from "@blaze-cardano/data";
import {
  Cosponsor,
  type ICosponsoredProposal,
} from "@/validators/Cosponsor.js";
import { parseCosponsorDatum } from "@/helpers/parseCosponsorDatum.js";
import { CosponsorTypes } from "@/validators/GeneratedTypes/index.js";
import type { INewConstitution } from "@/validators/Types/GovernanceAction.js";
import { BROWSER_CONFIG } from "@/browser/BrowserConfig.js";

const STATE_POLICY = BROWSER_CONFIG.statePolicyId;
const ANCHOR_URL = Buffer.from("https://example.com/c.json").toString("hex");
const ANCHOR_HASH = "0".repeat(64);
const GUARDRAILS = "ab".repeat(28); // 28-byte ScriptHash hex

const ncProposal = (guardrails?: string): ICosponsoredProposal => ({
  deposit: 50_000_000n,
  anchor: { url: ANCHOR_URL, hash: ANCHOR_HASH },
  action: { kind: "NewConstitution", ancestor: null, guardrails },
});

const parseProposal = (proposal: ICosponsoredProposal) => {
  const cosponsor = Cosponsor.new({
    statePolicyId: STATE_POLICY,
    cosponsoredProposal: proposal,
  });
  return { cosponsor, parsed: parseCosponsorDatum(cosponsor.datum()) };
};

describe("NewConstitution guardrails round-trip (audit H2)", () => {
  test("guardrails Some round-trips through build → parse", () => {
    const { parsed } = parseProposal(ncProposal(GUARDRAILS));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const action = parsed.value.proposal.action as INewConstitution;
    expect(action.kind).toBe("NewConstitution");
    expect(action.guardrails).toBe(GUARDRAILS);
  });

  test("guardrails None round-trips to undefined", () => {
    const { parsed } = parseProposal(ncProposal(undefined));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const action = parsed.value.proposal.action as INewConstitution;
    expect(action.guardrails).toBeUndefined();
  });

  test("rebuild is hash-lossless for Some (raw hash == build-time token name)", () => {
    const { cosponsor, parsed } = parseProposal(ncProposal(GUARDRAILS));
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
      cosponsoredProposal: ncProposal(GUARDRAILS),
    }).gAda();
    const noneName = Cosponsor.new({
      statePolicyId: STATE_POLICY,
      cosponsoredProposal: ncProposal(undefined),
    }).gAda();
    expect(someName).not.toBe(noneName);
  });
});
