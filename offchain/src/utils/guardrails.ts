/**
 * Conway constitution guardrails-script witnessing.
 *
 * The ledger runs the enacted constitution's guardrails script as a
 * *proposing-purpose* Plutus script for every TreasuryWithdrawal and
 * ParameterChange proposal: the tx must supply the script (witness or
 * reference input) plus a Proposing-tag redeemer, or the whole submission is
 * rejected. Blaze has no governance support, so the propose builder patches
 * the redeemer in after `complete()` — which stales the body's
 * `script_data_hash` (field 11); {@link appendProposingRedeemer} therefore
 * recomputes it with Blaze's own `computeScriptData`, self-checking against
 * the pre-patch hash first so a cost-model wiring mistake can never produce
 * a silently doomed transaction.
 *
 * Facts (verified on preview 2026-07-06):
 * - guardrails = PlutusV3, 2132 bytes, hash `fa24fb30…` — identical on
 *   preview/preprod/mainnet (baked into Conway genesis).
 * - The validator IGNORES its redeemer (any value passes; unit is used here).
 *   It auto-succeeds on TreasuryWithdrawals and only bounds-checks
 *   ParameterChange values.
 * - Preview has a long-lived reference-script UTxO for it (below), used by
 *   real parameter-change submissions since 2024.
 * - Real executions: ~402k mem / ~89.5M steps typical, ~892k/190M max
 *   observed → the fixed 1M/250M budget below covers everything seen.
 */

import { computeScriptData, Core, type Provider } from "@blaze-cardano/sdk";

/** Long-lived preview reference-script UTxO carrying the guardrails script. */
export const PREVIEW_GUARDRAILS_REFERENCE_UTXO = {
  txHash: "f3f61635034140e6cec495a1c69ce85b22690e65ab9553ef408d524f58183649",
  index: 0n,
} as const;

/**
 * Padded execution budget for the guardrails redeemer. Never re-evaluated
 * (the redeemers must not change after the fixed point), so it must cover
 * the worst observed real usage with margin; the fee pays for the padding.
 */
export const GUARDRAILS_EX_UNITS = {
  mem: 1_000_000n,
  steps: 250_000_000n,
} as const;

/**
 * Extra fee headroom a guardrails redeemer needs on top of the builder's
 * standard freeze pad: exUnit pricing (~58k mem + ~18k steps on preview)
 * plus the redeemer bytes.
 */
export const GUARDRAILS_FEE_PAD = 100_000n;

/** True when the ledger will demand the guardrails witness for this action. */
export const actionNeedsGuardrails = (action: { kind: string }): boolean =>
  action.kind === "TreasuryWithdrawal" || action.kind === "ProtocolParameters";

/**
 * Resolve the reference-script UTxO carrying the guardrails script.
 * Precedence: `GUARDRAILS_REF_UTXO` env ("txHash#index") → the known preview
 * UTxO (testnet only — mainnet callers must configure explicitly). The
 * resolved output is verified to actually carry a script whose hash matches
 * `expectedHash` (when given) before it is trusted.
 */
export const resolveGuardrailsReference = async (
  provider: Provider,
  expectedHash?: string,
): Promise<Core.TransactionUnspentOutput> => {
  const env = typeof process !== "undefined" ? process.env : undefined;
  let txHash: string;
  let index: bigint;
  const override = env?.GUARDRAILS_REF_UTXO;
  if (override) {
    const [hash, ix] = override.split("#");
    if (!hash || hash.length !== 64 || ix === undefined) {
      throw new Error(
        `resolveGuardrailsReference: bad GUARDRAILS_REF_UTXO "${override}" (want txHash#index)`,
      );
    }
    txHash = hash;
    index = BigInt(ix);
  } else if (Number(provider.network) !== 1) {
    txHash = PREVIEW_GUARDRAILS_REFERENCE_UTXO.txHash;
    index = PREVIEW_GUARDRAILS_REFERENCE_UTXO.index;
  } else {
    throw new Error(
      "resolveGuardrailsReference: no known mainnet guardrails reference " +
        "UTxO baked in — set GUARDRAILS_REF_UTXO=txHash#index",
    );
  }

  const [utxo] = await provider.resolveUnspentOutputs([
    new Core.TransactionInput(Core.TransactionId(txHash), index),
  ]);
  if (!utxo) {
    throw new Error(
      `resolveGuardrailsReference: UTxO ${txHash}#${index} not found (spent?)`,
    );
  }
  const scriptRef = utxo.output().scriptRef();
  if (!scriptRef) {
    throw new Error(
      `resolveGuardrailsReference: UTxO ${txHash}#${index} carries no reference script`,
    );
  }
  if (expectedHash && String(scriptRef.hash()) !== expectedHash) {
    throw new Error(
      `resolveGuardrailsReference: reference script hash ${scriptRef.hash()} ` +
        `!= expected guardrails hash ${expectedHash}`,
    );
  }
  return utxo;
};

/**
 * Build the used-cost-models view for {@link appendProposingRedeemer} from
 * the provider's protocol parameters. Every script in a propose tx
 * (cosponsor, state, AlwaysTrue, guardrails) is PlutusV3, so only the V3
 * model enters the language views — asserted against the pre-patch body
 * hash inside appendProposingRedeemer.
 */
export const usedCostModelsV3 = async (
  provider: Provider,
): Promise<Core.Costmdls> => {
  const params = await provider.getParameters();
  const v3 = params.costModels.get(Core.PlutusLanguageVersion.V3);
  if (!v3) {
    throw new Error("usedCostModelsV3: provider has no PlutusV3 cost model");
  }
  const costmdls = new Core.Costmdls();
  costmdls.insert(new Core.CostModel(Core.PlutusLanguageVersion.V3, v3));
  return costmdls;
};

/**
 * Append the guardrails Proposing redeemer (index 0 — the spliced
 * `proposal_procedures` holds exactly one procedure) to a completed
 * transaction and refresh body field 11.
 *
 * Self-verifying: first recomputes the script data hash over the UNPATCHED
 * redeemers and requires it to equal the body's current field 11 (proving
 * the cost-model/datum wiring reproduces Blaze byte-for-byte), only then
 * swaps in the patched redeemer list and the new hash.
 */
export const appendProposingRedeemer = (
  transaction: Core.Transaction,
  usedCostModels: Core.Costmdls,
): Core.Transaction => {
  const witnessSet = transaction.witnessSet();
  const body = transaction.body();
  const redeemers = witnessSet.redeemers();
  if (!redeemers) {
    throw new Error("appendProposingRedeemer: transaction has no redeemers");
  }
  const values = [...redeemers.values()];
  if (values.some((r) => r.tag() === Core.RedeemerTag.Proposing)) {
    throw new Error(
      "appendProposingRedeemer: a Proposing redeemer is already present",
    );
  }

  const currentSdh = body.scriptDataHash();
  const check = computeScriptData(
    redeemers,
    witnessSet.plutusData(),
    usedCostModels,
  );
  if (
    !check ||
    !currentSdh ||
    String(check.scriptDataHash) !== String(currentSdh)
  ) {
    throw new Error(
      "appendProposingRedeemer: pre-patch script_data_hash mismatch " +
        `(recomputed ${check?.scriptDataHash}, body ${currentSdh}) — ` +
        "cost-model wiring does not reproduce Blaze's; refusing to patch",
    );
  }

  const unit = Core.PlutusData.newConstrPlutusData(
    new Core.ConstrPlutusData(0n, new Core.PlutusList()),
  );
  const proposing = new Core.Redeemer(
    Core.RedeemerTag.Proposing,
    0n,
    unit,
    new Core.ExUnits(GUARDRAILS_EX_UNITS.mem, GUARDRAILS_EX_UNITS.steps),
  );
  const patched = Core.Redeemers.fromCore([
    ...values.map((r) => r.toCore()),
    proposing.toCore(),
  ]);

  const next = computeScriptData(
    patched,
    witnessSet.plutusData(),
    usedCostModels,
  );
  if (!next) {
    throw new Error(
      "appendProposingRedeemer: patched script data unexpectedly empty",
    );
  }
  witnessSet.setRedeemers(patched);
  body.setScriptDataHash(next.scriptDataHash);
  return new Core.Transaction(body, witnessSet);
};
