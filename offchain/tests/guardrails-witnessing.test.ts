/**
 * appendProposingRedeemer (utils/guardrails.ts).
 *
 * Verifies the post-complete() patch: the guardrails Proposing redeemer is
 * appended to the witness set and body field 11 (script_data_hash) is
 * recomputed with Blaze's own computeScriptData — and the self-check refuses
 * to patch when the supplied cost models can't reproduce the body's current
 * hash (which would otherwise build a ledger-doomed transaction).
 */

import { describe, expect, test } from "bun:test";
import { computeScriptData, Core } from "@blaze-cardano/sdk";
import {
  actionNeedsGuardrails,
  appendProposingRedeemer,
  GUARDRAILS_EX_UNITS,
} from "@/utils/guardrails.js";

const unit = (): Core.PlutusData =>
  Core.PlutusData.newConstrPlutusData(
    new Core.ConstrPlutusData(0n, new Core.PlutusList()),
  );

const costModels = (costs: number[]): Core.Costmdls => {
  const mdls = new Core.Costmdls();
  mdls.insert(new Core.CostModel(Core.PlutusLanguageVersion.V3, costs));
  return mdls;
};

/** Minimal body (inputs/outputs/fee) + one spend redeemer, sdh set by Blaze's
 * own computeScriptData so the patch's pre-check has something real to hit. */
const makeTransaction = (mdls: Core.Costmdls) => {
  const body = Core.TransactionBody.fromCbor(
    Core.HexBlob("a300d90102800180020a"),
  );
  const witnessSet = new Core.TransactionWitnessSet();
  const spend = new Core.Redeemer(
    Core.RedeemerTag.Spend,
    0n,
    unit(),
    new Core.ExUnits(1000n, 2000n),
  );
  const redeemers = Core.Redeemers.fromCore([spend.toCore()]);
  witnessSet.setRedeemers(redeemers);
  const scriptData = computeScriptData(
    redeemers,
    witnessSet.plutusData(),
    mdls,
  );
  if (!scriptData) throw new Error("test setup: no script data");
  body.setScriptDataHash(scriptData.scriptDataHash);
  return new Core.Transaction(body, witnessSet);
};

const V3_COSTS = [100, 200, 300];

describe("appendProposingRedeemer", () => {
  test("appends the Proposing redeemer and refreshes field 11", () => {
    const mdls = costModels(V3_COSTS);
    const patched = appendProposingRedeemer(makeTransaction(mdls), mdls);

    const values = [...patched.witnessSet().redeemers()!.values()];
    expect(values).toHaveLength(2);
    const proposing = values.find(
      (r) => r.tag() === Core.RedeemerTag.Proposing,
    );
    expect(proposing).toBeDefined();
    expect(proposing!.index()).toBe(0n);
    expect(proposing!.exUnits().mem()).toBe(GUARDRAILS_EX_UNITS.mem);
    expect(proposing!.exUnits().steps()).toBe(GUARDRAILS_EX_UNITS.steps);

    // Field 11 must equal Blaze's computation over the PATCHED redeemers.
    const expected = computeScriptData(
      patched.witnessSet().redeemers()!,
      patched.witnessSet().plutusData(),
      mdls,
    );
    expect(String(patched.body().scriptDataHash())).toBe(
      String(expected!.scriptDataHash),
    );
    // And it must have CHANGED from the pre-patch hash.
    const original = makeTransaction(mdls);
    expect(String(patched.body().scriptDataHash())).not.toBe(
      String(original.body().scriptDataHash()),
    );
  });

  test("refuses to patch when cost models can't reproduce the body hash", () => {
    const tx = makeTransaction(costModels(V3_COSTS));
    expect(() =>
      appendProposingRedeemer(tx, costModels([999, 999, 999])),
    ).toThrow("refusing to patch");
  });

  test("refuses to double-patch", () => {
    const mdls = costModels(V3_COSTS);
    const patched = appendProposingRedeemer(makeTransaction(mdls), mdls);
    expect(() => appendProposingRedeemer(patched, mdls)).toThrow(
      "already present",
    );
  });
});

describe("actionNeedsGuardrails", () => {
  test("only TreasuryWithdrawal and ProtocolParameters", () => {
    expect(actionNeedsGuardrails({ kind: "TreasuryWithdrawal" })).toBe(true);
    expect(actionNeedsGuardrails({ kind: "ProtocolParameters" })).toBe(true);
    for (const kind of [
      "NicePoll",
      "NoConfidence",
      "HardFork",
      "ConstitutionalCommittee",
      "NewConstitution",
    ]) {
      expect(actionNeedsGuardrails({ kind })).toBe(false);
    }
  });
});
