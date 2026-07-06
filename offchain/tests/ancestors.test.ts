/**
 * resolveAncestor / assertAncestorCurrent (utils/ancestors.ts).
 *
 * Fixtures mirror the REAL Koios preview `/proposal_list` response of
 * 2026-07-06, so the expected values double as a lock on the live-verified
 * ancestors (committee ancestor ac993231…#0 was proven correct on-chain; a
 * null committee ancestor was proven WRONG — burned deposit 454d1c79…).
 */

import { describe, expect, test } from "bun:test";
import {
  assertAncestorCurrent,
  resolveAncestor,
} from "@/utils/ancestors.js";

const KOIOS_ENACTED = [
  // Latest enacted per type, plus older ones that must NOT win.
  { proposal_tx_hash: "2a2dc37b22939d3ae7395c8a409d4d0625201c88926d641d6f4441c3287e39ba", proposal_index: 0, proposal_type: "ParameterChange", enacted_epoch: 1330 },
  { proposal_tx_hash: "fa2b252c9d645b376ee68f94ea87764dad6510e201726921e0cb733161ca6ef8", proposal_index: 0, proposal_type: "HardForkInitiation", enacted_epoch: 1291 },
  { proposal_tx_hash: "014c32e57347d114744210e1934a2084c5d0052a2312170d93758bfd566f3956", proposal_index: 0, proposal_type: "ParameterChange", enacted_epoch: 1270 },
  { proposal_tx_hash: "ac993231c39a4ee13bcf888e971e099809c4c08d96a7572aa3611a5ed42fa7d4", proposal_index: 0, proposal_type: "NewCommittee", enacted_epoch: 1013 },
  { proposal_tx_hash: "6214314b6d6a30118d259c9597c0e0120b76aa521e322044c4290fcaac86e27a", proposal_index: 0, proposal_type: "NewCommittee", enacted_epoch: 998 },
  { proposal_tx_hash: "049ae5d612b2fa825655809133b023d60c7f8cac683c278cf95de1622e4592f3", proposal_index: 0, proposal_type: "HardForkInitiation", enacted_epoch: 743 },
];

const mockFetch = (payload: unknown, ok = true): typeof fetch =>
  (async () =>
    ({
      ok,
      status: ok ? 200 : 500,
      json: async () => payload,
    }) as Response) as unknown as typeof fetch;

const OPTS = { fetchFn: mockFetch(KOIOS_ENACTED) };

describe("resolveAncestor", () => {
  test("Committee → latest enacted NewCommittee (the live-verified ancestor)", async () => {
    expect(await resolveAncestor("Committee", OPTS)).toEqual({
      txHash:
        "ac993231c39a4ee13bcf888e971e099809c4c08d96a7572aa3611a5ed42fa7d4",
      index: 0,
    });
  });

  test("PParamUpdate → highest enacted_epoch ParameterChange, not an older one", async () => {
    expect(await resolveAncestor("PParamUpdate", OPTS)).toEqual({
      txHash:
        "2a2dc37b22939d3ae7395c8a409d4d0625201c88926d641d6f4441c3287e39ba",
      index: 0,
    });
  });

  test("HardFork → latest enacted HardForkInitiation", async () => {
    expect(await resolveAncestor("HardFork", OPTS)).toEqual({
      txHash:
        "fa2b252c9d645b376ee68f94ea87764dad6510e201726921e0cb733161ca6ef8",
      index: 0,
    });
  });

  test("Constitution → null when the purpose was never enacted", async () => {
    expect(await resolveAncestor("Constitution", OPTS)).toBeNull();
  });

  test("Committee purpose also accepts an enacted NoConfidence", async () => {
    const withNoConfidence = [
      ...KOIOS_ENACTED,
      { proposal_tx_hash: "ab".repeat(32), proposal_index: 1, proposal_type: "NoConfidence", enacted_epoch: 1400 },
    ];
    expect(
      await resolveAncestor("Committee", {
        fetchFn: mockFetch(withNoConfidence),
      }),
    ).toEqual({ txHash: "ab".repeat(32), index: 1 });
  });

  test("throws on a non-OK Koios response", async () => {
    await expect(
      resolveAncestor("Committee", { fetchFn: mockFetch([], false) }),
    ).rejects.toThrow("proposal_list failed");
  });
});

describe("assertAncestorCurrent", () => {
  test("passes when the fixture matches the live ancestor", async () => {
    await assertAncestorCurrent(
      "NoConfidence",
      {
        txHash:
          "ac993231c39a4ee13bcf888e971e099809c4c08d96a7572aa3611a5ed42fa7d4",
        index: 0,
      },
      OPTS,
    );
  });

  test("throws on mismatch (the 454d1c79 burn scenario: fixture null, live set)", async () => {
    await expect(
      assertAncestorCurrent("NoConfidence", null, OPTS),
    ).rejects.toThrow("would burn");
  });

  test("no-ancestor kinds (TreasuryWithdrawal, NicePoll) never query", async () => {
    const explode = (async () => {
      throw new Error("must not fetch");
    }) as unknown as typeof fetch;
    await assertAncestorCurrent("TreasuryWithdrawal", undefined, {
      fetchFn: explode,
    });
    await assertAncestorCurrent("NicePoll", undefined, { fetchFn: explode });
  });
});
