import { Core } from "@blaze-cardano/sdk";

import { logger } from "../logger.js";
/**
 * Tracks pending UTxO changes from submitted transactions
 * This enables transaction chaining by knowing which UTxOs are spent
 * and which new UTxOs exist before they're visible on-chain
 */

interface TrackedUtxo {
  txHash: string;
  outputIndex: number;
  utxo: Core.TransactionUnspentOutput;
}

interface SpentUtxo {
  txHash: string;
  outputIndex: number;
}

class PendingUtxoTracker {
  private spentUtxos: SpentUtxo[] = [];
  private createdUtxos: TrackedUtxo[] = [];

  /**
   * Record a transaction's effects on UTxOs
   * Call this after a transaction is successfully submitted
   */
  recordTransaction(
    submittedTxHash: string,
    spentInputs: { txHash: string; outputIndex: number }[],
    createdOutputs: {
      outputIndex: number;
      utxo: Core.TransactionUnspentOutput;
    }[],
  ) {
    logger.debug(`📝 Recording tx ${submittedTxHash.slice(0, 16)}... effects:`);
    logger.debug(`   - ${spentInputs.length} UTxO(s) spent`);
    logger.debug(`   - ${createdOutputs.length} script UTxO(s) created`);

    // Track spent UTxOs AND remove them from createdUtxos if they were pending
    // This handles the case where TX2 spends a pending UTxO from TX1
    for (const input of spentInputs) {
      this.spentUtxos.push({
        txHash: input.txHash,
        outputIndex: input.outputIndex,
      });

      // Remove from createdUtxos if this was a pending UTxO we were tracking
      const beforeCount = this.createdUtxos.length;
      this.createdUtxos = this.createdUtxos.filter(
        (c) =>
          !(c.txHash === input.txHash && c.outputIndex === input.outputIndex),
      );
      if (this.createdUtxos.length < beforeCount) {
        logger.debug(
          `   🔄 Removed spent pending UTxO: ${input.txHash.slice(0, 16)}...#${input.outputIndex}`,
        );
      }
    }

    // Track created UTxOs (with the new txHash)
    // Avoid duplicates (can happen with React strict mode double-invoke)
    for (const output of createdOutputs) {
      const alreadyTracked = this.createdUtxos.some(
        (c) =>
          c.txHash === submittedTxHash && c.outputIndex === output.outputIndex,
      );
      if (!alreadyTracked) {
        this.createdUtxos.push({
          txHash: submittedTxHash,
          outputIndex: output.outputIndex,
          utxo: output.utxo,
        });
      }
    }
  }

  /**
   * Check if a UTxO has been spent in a pending transaction
   */
  isSpent(txHash: string, outputIndex: number): boolean {
    return this.spentUtxos.some(
      (s) => s.txHash === txHash && s.outputIndex === outputIndex,
    );
  }

  /**
   * Get all pending (created but not yet confirmed) UTxOs
   */
  getPendingUtxos(): TrackedUtxo[] {
    return [...this.createdUtxos];
  }

  /**
   * Filter a list of UTxOs to exclude spent ones and include pending ones
   */
  applyToUtxoList(
    utxos: Core.TransactionUnspentOutput[],
  ): Core.TransactionUnspentOutput[] {
    // Filter out spent UTxOs
    const filtered = utxos.filter((utxo) => {
      const txHash = utxo.input().transactionId();
      const outputIndex = Number(utxo.input().index());
      const spent = this.isSpent(txHash, outputIndex);
      if (spent) {
        logger.debug(
          `   🔄 Excluding spent UTxO: ${txHash.slice(0, 16)}...#${outputIndex}`,
        );
      }
      return !spent;
    });

    // Build a set of existing UTxO IDs to avoid duplicates
    const existingIds = new Set(
      filtered.map((utxo) => {
        const txHash = utxo.input().transactionId();
        const outputIndex = Number(utxo.input().index());
        return `${txHash}#${outputIndex}`;
      }),
    );

    // Add pending UTxOs that aren't already in the filtered list
    // (they might already be there if the pending tx was confirmed)
    const newPending: Core.TransactionUnspentOutput[] = [];
    for (const tracked of this.createdUtxos) {
      const id = `${tracked.txHash}#${tracked.outputIndex}`;
      if (!existingIds.has(id)) {
        newPending.push(tracked.utxo);
        existingIds.add(id); // Prevent duplicates within pending list too
        logger.debug(
          `   🔄 Adding pending UTxO: ${tracked.txHash.slice(0, 16)}...#${tracked.outputIndex}`,
        );
      } else {
        // UTxO is already in the list (tx was confirmed), remove from tracking
        logger.debug(
          `   ✅ Pending UTxO already confirmed: ${tracked.txHash.slice(0, 16)}...#${tracked.outputIndex}`,
        );
      }
    }

    const result = [...filtered, ...newPending];
    logger.debug(
      `   📋 Final UTxO count: ${result.length} (${filtered.length} from provider + ${newPending.length} pending)`,
    );
    return result;
  }

  /**
   * Clear tracking for a specific transaction (e.g., when confirmed)
   */
  clearTransaction(txHash: string) {
    this.spentUtxos = this.spentUtxos.filter(
      (s) => !this.createdUtxos.some((c) => c.txHash === txHash),
    );
    this.createdUtxos = this.createdUtxos.filter((c) => c.txHash !== txHash);
    logger.debug(`🧹 Cleared tracking for tx ${txHash.slice(0, 16)}...`);
  }

  /**
   * Clear all tracking (e.g., on page refresh or after confirmations)
   */
  clearAll() {
    this.spentUtxos = [];
    this.createdUtxos = [];
    logger.debug("🧹 Cleared all UTxO tracking");
  }

  /**
   * Get count of tracked items (for debugging)
   */
  getStats() {
    return {
      spentCount: this.spentUtxos.length,
      pendingCount: this.createdUtxos.length,
    };
  }
}

// Singleton instance for the session
export const pendingUtxoTracker = new PendingUtxoTracker();

/**
 * Helper to extract transaction effects from a completed transaction
 * Returns the inputs that were spent and outputs that were created
 *
 * IMPORTANT: Only tracks outputs at SCRIPT addresses (with datums).
 * Wallet outputs are NOT tracked because they can't be spent with redeemers.
 */
export function extractTransactionEffects(
  completedTx: Core.Transaction,
  submittedTxHash: string,
) {
  const body = completedTx.body();

  // Get spent inputs
  const inputs = body.inputs().values();
  const spentInputs = inputs.map((input: Core.TransactionInput) => ({
    txHash: input.transactionId(),
    outputIndex: Number(input.index()),
  }));

  // Get created outputs - ONLY track script outputs (those with datums)
  // Wallet outputs should not be tracked as they can't be spent with redeemers
  const outputs = body.outputs();
  const createdOutputs: {
    outputIndex: number;
    utxo: Core.TransactionUnspentOutput;
  }[] = [];

  for (let i = 0; i < outputs.length; i++) {
    const output = outputs[i];

    // Only track outputs that have a datum (script outputs)
    // Wallet change outputs don't have datums
    const datum = output.datum();
    if (!datum) {
      continue; // Skip wallet outputs
    }

    const input = new Core.TransactionInput(
      Core.TransactionId(submittedTxHash),
      BigInt(i),
    );
    const utxo = new Core.TransactionUnspentOutput(input, output);
    createdOutputs.push({ outputIndex: i, utxo });

    logger.debug(`   📦 Tracking script output #${i} (has datum)`);
  }

  return { spentInputs, createdOutputs };
}
