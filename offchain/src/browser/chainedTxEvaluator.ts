/**
 * Chained-transaction evaluator wrapper + deposit guard.
 *
 * `wrapEvaluatorWithWalletUtxos` merges the wallet's UTxOs into the evaluator's
 * additionalUtxoset so a transaction that chains onto a not-yet-indexed output
 * (e.g. the previous deposit's change) still resolves during evaluation.
 *
 * Deposit guard: a mint/deposit transaction must spend ZERO Cosponsor script
 * UTxOs — the on-chain validator enforces `cosponsor_inputs == 0`. If a stray
 * script input resolves into the spend set (e.g. blaze chaining onto a pending
 * deposit's script output), pass `rejectCosponsorInputHash` so the evaluator
 * throws an actionable error BEFORE submit instead of failing opaquely on-chain.
 * Withdrawals legitimately spend script UTxOs, so they leave it unset.
 */

import { Core } from "@blaze-cardano/sdk";

export interface IEvaluatorGuardOptions {
  /** Cosponsor script hash; when set, refuse any spend input at that address. */
  rejectCosponsorInputHash?: string;
}

type TChainedEvaluator = (
  tx: Core.Transaction,
  additionalUtxos?: Core.TransactionUnspentOutput[],
) => Promise<Core.Redeemers>;

interface IBlazeLike {
  wallet: { getUnspentOutputs: () => Promise<Core.TransactionUnspentOutput[]> };
  provider: { evaluateTransaction: TChainedEvaluator };
}

const utxoId = (u: Core.TransactionUnspentOutput) =>
  `${u.input().transactionId()}#${u.input().index()}`;

// `blaze`/`baseEvaluator` are `unknown` so consumers on a different
// @blaze-cardano/core version (the UI's pinned tree) can pass theirs without a
// type clash; the shapes are structurally identical at runtime.
export const wrapEvaluatorWithWalletUtxos = (
  blaze: unknown,
  baseEvaluator: unknown,
  opts?: IEvaluatorGuardOptions,
): TChainedEvaluator => {
  const b = blaze as IBlazeLike;
  const underlying = baseEvaluator as TChainedEvaluator;
  return async (tx, additionalUtxos) => {
    let walletUtxos: Core.TransactionUnspentOutput[] = [];
    try {
      walletUtxos = await b.wallet.getUnspentOutputs();
    } catch {
      /* evaluate without it */
    }

    // Union by `txhash#index`; blaze's additionalUtxos shadow the wallet copy.
    const byId = new Map<string, Core.TransactionUnspentOutput>();
    for (const u of walletUtxos) byId.set(utxoId(u), u);
    for (const u of additionalUtxos ?? []) byId.set(utxoId(u), u);

    if (opts?.rejectCosponsorInputHash) {
      for (const input of tx.body().inputs().values()) {
        const resolved = byId.get(`${input.transactionId()}#${input.index()}`);
        const paymentPart = resolved?.output().address().getProps().paymentPart;
        if (
          paymentPart?.type === Core.CredentialType.ScriptHash &&
          paymentPart.hash === opts.rejectCosponsorInputHash
        ) {
          throw new Error(
            "This deposit selected a Cosponsor script UTxO as an input, which the " +
              "on-chain validator rejects (cosponsor_inputs must be 0). This is a " +
              "transient wallet/chain state — refresh and try the pledge again.",
          );
        }
      }
    }

    return underlying(tx, Array.from(byId.values()));
  };
};

/** Wrap the blaze provider's own evaluator with the wallet-UTxO injection + guard. */
export const buildChainedTxEvaluator = (
  blaze: unknown,
  opts?: IEvaluatorGuardOptions,
): TChainedEvaluator => {
  const b = blaze as IBlazeLike;
  return wrapEvaluatorWithWalletUtxos(
    b,
    (tx: Core.Transaction, extra?: Core.TransactionUnspentOutput[]) =>
      b.provider.evaluateTransaction(tx, extra),
    opts,
  );
};
