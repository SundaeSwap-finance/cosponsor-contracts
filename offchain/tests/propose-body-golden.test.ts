/**
 * Golden-vector lock between the off-chain propose-body encoders
 * (src/utils/proposeBody.ts) and the on-chain reconstruction
 * (lib/calculation/conversion.ak, pinned by validators/tests/propose_proof.ak).
 *
 * The hex literals here are the SAME vectors the Aiken proof tests assert.
 * If either side drifts, one of the two suites breaks.
 */
import { describe, expect, it } from "bun:test";
import {
  cborUint,
  encodeGovernanceAction,
  encodeProposalProcedures,
  encodeRewardAccount,
  spliceProposalProcedures,
  transactionIdFromBody,
} from "../src/utils/proposeBody.js";
import type { ICosponsoredProposal } from "../src/validators/Cosponsor.js";

// Fixture constants — identical to validators/tests/propose_proof.ak
const COSPONSOR_HASH =
  "ffffffffffffffffffffffffffffffffffffffffffffffffffffffdd";
const TRUE_POLICY = "ffffffffffffffffffffffffffffffffffffffffffffffffffffffee";
const USER_KEY = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const SIGNER_KEY = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const TXID_COS =
  "1111111111111111111111111111111111111111111111111111111111111111";
const TXID_USER =
  "3333333333333333333333333333333333333333333333333333333333333333";
const TXID_COL =
  "5555555555555555555555555555555555555555555555555555555555555555";
const SDH = "4444444444444444444444444444444444444444444444444444444444444444";
const ANCHOR_HASH =
  "2222222222222222222222222222222222222222222222222222222222222222";

const fixtureProposal: ICosponsoredProposal = {
  deposit: 1_000_000n,
  anchor: { url: "https://x", hash: ANCHOR_HASH },
  action: { kind: "NicePoll" },
};

const scriptReturnAddress = { ScriptCredential: [COSPONSOR_HASH] as [string] };

describe("proposal_procedures field encoding (golden, shared with Aiken)", () => {
  it("encodes an info-action proposal exactly as propose_proof.ak expects", () => {
    const expected =
      "d9010281" +
      "84" +
      "1a000f4240" +
      "581df0" +
      COSPONSOR_HASH +
      "8106" +
      "82" +
      "6968747470733a2f2f78" +
      "5820" +
      ANCHOR_HASH;
    expect(
      encodeProposalProcedures([
        { proposal: fixtureProposal, returnAddress: scriptReturnAddress },
      ]),
    ).toBe(expected);
  });

  it("encodes reward accounts with testnet script/key headers", () => {
    expect(encodeRewardAccount(scriptReturnAddress)).toBe(
      "581df0" + COSPONSOR_HASH,
    );
    expect(
      encodeRewardAccount({ VerificationKeyCredential: [USER_KEY] }),
    ).toBe("581de0" + USER_KEY);
  });

  it("encodes mainnet reward-account headers when networkId = 1", () => {
    expect(encodeRewardAccount(scriptReturnAddress, 1)).toBe(
      "581df1" + COSPONSOR_HASH,
    );
    expect(
      encodeRewardAccount({ VerificationKeyCredential: [USER_KEY] }, 1),
    ).toBe("581de1" + USER_KEY);
    expect(() => encodeRewardAccount(scriptReturnAddress, 2)).toThrow(
      "bad networkId",
    );
  });

  it("refuses ledger-malformed encodings (missing constitution anchor / empty PParam update)", () => {
    // Both kinds are SUPPORTED since 2026-07-06 (see
    // new-constitution-encoder.test.ts / protocol-parameters-roundtrip.test.ts);
    // only the inputs the node would reject as malformed are refused.
    expect(() =>
      encodeGovernanceAction({ kind: "NewConstitution", ancestor: null }),
    ).toThrow(/constitutionAnchor/);
    expect(() =>
      encodeGovernanceAction({ kind: "ProtocolParameters", ancestor: null }),
    ).toThrow(/NON-empty/);
  });
});

describe("canonical body splice + id (mirrors proof_propose_accepts_canonical_conway_body)", () => {
  // The Blaze-side body: everything EXCEPT proposal_procedures — 11 fields.
  const bodyWithoutProposals =
    "ab" +
    "00d9010282" +
    ("825820" + TXID_COS + "00") +
    ("825820" + TXID_USER + "00") +
    ("018182581d60" + USER_KEY + "1a004c4b40") +
    "021a00030d40" +
    "031903e8" +
    ("05a1581df0" + COSPONSOR_HASH + "00") +
    ("09a1581c" + TRUE_POLICY + "a15820" + SDH + "01") +
    ("0b5820" + SDH) +
    ("0dd9010281825820" + TXID_COL + "00") +
    ("0ed9010281581c" + SIGNER_KEY) +
    ("1082581d60" + USER_KEY + "1a001e8480") +
    "111a000f4240";

  const proposalsField =
    "d9010281841a000f4240581df0" +
    COSPONSOR_HASH +
    "8106826968747470733a2f2f785820" +
    ANCHOR_HASH;

  // The full canonical body the Aiken integrated test hashes (map of 12).
  const canonicalBody =
    "ac" + bodyWithoutProposals.slice(2) + "14" + proposalsField;

  it("splicing field 20 into the Blaze body yields the canonical body", () => {
    expect(spliceProposalProcedures(bodyWithoutProposals, proposalsField)).toBe(
      canonicalBody,
    );
  });

  it("field 20 bytes come from encodeProposalProcedures", () => {
    expect(
      encodeProposalProcedures([
        { proposal: fixtureProposal, returnAddress: scriptReturnAddress },
      ]),
    ).toBe(proposalsField);
  });

  it("computes a stable 32-byte transaction id from the body", () => {
    const id = transactionIdFromBody(canonicalBody);
    expect(id).toMatch(/^[0-9a-f]{64}$/);
    // Splice must change the id (field 20 is part of the signed body).
    expect(id).not.toBe(transactionIdFromBody(bodyWithoutProposals));
  });

  it("handles map-of-24+ body headers when splicing", () => {
    const body24 = "b818" + "00d901028182582000".repeat(0); // header-only probe
    expect(() => spliceProposalProcedures("b818" + "0001", "d9010280")).not.toThrow();
    expect(spliceProposalProcedures("b8180001", "d9010280").startsWith("b819")).toBe(
      true,
    );
    void body24;
  });
});

describe("cborUint parity with Aiken serialise", () => {
  it("matches known encodings", () => {
    expect(cborUint(0)).toBe("00");
    expect(cborUint(23)).toBe("17");
    expect(cborUint(999)).toBe("1903e7");
    expect(cborUint(1_000_000)).toBe("1a000f4240");
    expect(cborUint(100_000_000_000n)).toBe("1b000000174876e800");
  });
});

describe("TreasuryWithdrawal encoding (golden, shared with Aiken golden_treasury_withdrawal_matches_sdk)", () => {
  it("encodes TEST_WITHDRAWAL_1's action + procedure exactly as the validator expects", () => {
    // Friendly {vkey} beneficiary (the SDK's TCredential form) must encode
    // identically to the on-chain reward account — this is the credential-form
    // fix (proposeBody credentialParts accepting both forms).
    const action = {
      kind: "TreasuryWithdrawal" as const,
      beneficiaries: [[{ vkey: "aa".repeat(28) }, 10_000_000n]] as Array<
        [{ vkey: string }, bigint]
      >,
      guardRails: undefined,
    };
    expect(encodeGovernanceAction(action)).toBe(
      "8302a1581de0" + "aa".repeat(28) + "1a00989680f6",
    );
    const proposal = {
      deposit: 1_000_000n,
      anchor: { url: "https://x", hash: ANCHOR_HASH },
      action,
    };
    const expected =
      "d9010281841a000f4240581df0" +
      COSPONSOR_HASH +
      "8302a1581de0" +
      "aa".repeat(28) +
      "1a00989680f6826968747470733a2f2f785820" +
      ANCHOR_HASH;
    expect(
      encodeProposalProcedures([
        { proposal, returnAddress: scriptReturnAddress },
      ]),
    ).toBe(expected);
  });
});
