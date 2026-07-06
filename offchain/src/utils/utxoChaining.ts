import { Core } from "@blaze-cardano/sdk";

const utxoKey = (input: Core.TransactionInput): string =>
  `${input.transactionId()}#${input.index()}`;

/**
 * Enable local UTxO chaining on a Blaze instance for a sequence of wallet-funded
 * transactions submitted faster than the chain indexer reindexes.
 *
 * THE BUG THIS FIXES: the deploy/register/mint chain builds each tx by asking
 * the provider for the wallet's current UTxO set and trusting it to already
 * reflect the previous tx's spend. Blockfrost's *address* index lags a beat
 * behind each spend (its tx index is faster), so the running change output —
 * always the largest UTxO, hence always reselected by largest-first coin
 * selection — still looks unspent to the very next tx, which then fails with
 * `ConwayMempoolFailure "All inputs are spent"`. (Kupo reindexes fast enough
 * not to hit this; Blockfrost does.)
 *
 * THE FIX (per Mark): don't trust the API to be current between chained txs —
 * keep the expected set locally. Seed it from the provider once, then after each
 * submit drop the spent inputs and add the tx's own wallet-owned outputs (the
 * change). Coin selection then always sees the true post-chain state without
 * waiting on the indexer.
 *
 * Call once, before the chain. Transparent to deploy/register/mint — it patches
 * the shared Blaze singleton's `wallet.getUnspentOutputs` (read) and
 * `provider.postTransactionToChain` (update).
 */
export function enableLocalUtxoChaining(
  blaze: { wallet: unknown; provider: unknown },
  walletAddressBech32: string,
): void {
  let local: Core.TransactionUnspentOutput[] | null = null;

  const wallet = blaze.wallet as {
    getUnspentOutputs: () => Promise<Core.TransactionUnspentOutput[]>;
  };
  const provider = blaze.provider as {
    postTransactionToChain: (
      tx: Core.Transaction,
    ) => Promise<Core.TransactionId>;
  };

  const origGetUtxos = wallet.getUnspentOutputs.bind(wallet);
  const origPost = provider.postTransactionToChain.bind(provider);

  wallet.getUnspentOutputs = async () => {
    if (local === null) {
      local = await origGetUtxos();
    }
    return local;
  };

  provider.postTransactionToChain = async (tx: Core.Transaction) => {
    const txId = await origPost(tx);
    if (local !== null) {
      const spent = new Set<string>();
      for (const input of tx.body().inputs().values()) {
        spent.add(utxoKey(input));
      }
      const next = local.filter((u) => !spent.has(utxoKey(u.input())));
      // Add this tx's own wallet-owned outputs (change) as freshly available
      // UTxOs so the next tx in the chain can spend them immediately.
      tx.body()
        .outputs()
        .forEach((out, idx) => {
          if (out.address().toBech32() === walletAddressBech32) {
            const ref = new Core.TransactionInput(
              Core.TransactionId(txId),
              BigInt(idx),
            );
            next.push(new Core.TransactionUnspentOutput(ref, out));
          }
        });
      local = next;
    }
    return txId;
  };
}
