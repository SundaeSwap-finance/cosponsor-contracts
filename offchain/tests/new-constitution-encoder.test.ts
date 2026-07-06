/**
 * NewConstitution field-20 encoding + constitutionAnchor invariance (D6).
 *
 * The constitution DOCUMENT anchor is an encoder-only input: the V3 script
 * context drops it, so it has no datum slot and MUST NOT perturb the gADA
 * token name (deposits pledged before the anchor is chosen must still fund
 * the propose). The field-20 encoding is the Conway
 * `new_constitution = (5, gov_action_id / null, [anchor, script_hash / null])`.
 */

import { describe, expect, test } from "bun:test";
import { Cosponsor } from "@/validators/Cosponsor.js";
import type { INewConstitution } from "@/validators/Types/GovernanceAction.js";
import { computeProposalAssetName } from "@/validators/Types/GovernanceAction.js";
import { encodeGovernanceAction } from "@/utils/proposeBody.js";
import { BROWSER_CONFIG } from "@/browser/BrowserConfig.js";

const GUARDRAILS = "fa24fb305126805cf2164c161d852a0e7330cf988f1fe558cf7d4a64";
const DOC_URL =
  "https://cosponsor.preview.sundae.fi/proposals/test-constitution.txt";
const DOC_HASH =
  "18075c0bc7c6f23481739c78921ca6c74124d676be19680f90bee4857102b534";

const ncAction = (extra: Partial<INewConstitution> = {}): INewConstitution => ({
  kind: "NewConstitution",
  ancestor: null,
  guardrails: GUARDRAILS,
  ...extra,
});

const proposalWith = (action: INewConstitution) => ({
  deposit: 1_000_000_000n,
  anchor: {
    url: Buffer.from("https://example.com/nc.json").toString("hex"),
    hash: "0".repeat(64),
  },
  action,
});

describe("NewConstitution constitutionAnchor", () => {
  test("does NOT change the gADA token name (encoder-only input)", () => {
    const bare = Cosponsor.new({
      statePolicyId: BROWSER_CONFIG.statePolicyId,
      cosponsoredProposal: proposalWith(ncAction()),
    }).gAda();
    const withAnchor = Cosponsor.new({
      statePolicyId: BROWSER_CONFIG.statePolicyId,
      cosponsoredProposal: proposalWith(
        ncAction({ constitutionAnchor: { url: DOC_URL, hash: DOC_HASH } }),
      ),
    }).gAda();
    expect(withAnchor).toBe(bare);

    // Manual (browser) builder agrees too.
    const manual = computeProposalAssetName(
      proposalWith(
        ncAction({ constitutionAnchor: { url: DOC_URL, hash: DOC_HASH } }),
      ),
      BROWSER_CONFIG.scripts.cosponsor.hash,
    );
    expect(manual).toBe(bare);
  });

  test("field-20 golden: null ancestor + document anchor + guardrails", () => {
    const hex = encodeGovernanceAction(
      ncAction({ constitutionAnchor: { url: DOC_URL, hash: DOC_HASH } }),
    );
    const urlHex = Buffer.from(DOC_URL).toString("hex");
    expect(hex).toBe(
      "8305" + // new_constitution, tag 5
        "f6" + // ancestor: null (Constitution purpose never enacted on preview)
        "82" + // constitution = [anchor, script_hash]
        ("82" + "78" + (urlHex.length / 2).toString(16) + urlHex + "5820" + DOC_HASH) +
        "581c" + GUARDRAILS,
    );
  });

  test("refuses to encode without the constitution document anchor", () => {
    expect(() => encodeGovernanceAction(ncAction())).toThrow(
      "constitutionAnchor",
    );
  });
});
