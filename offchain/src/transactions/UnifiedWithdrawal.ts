import { Core, Wallet } from "@blaze-cardano/sdk";
import { Blaze } from "@blaze-cardano/sdk";
import { makeValue } from "@blaze-cardano/sdk";
import { Provider } from "@blaze-cardano/sdk";
import { TxBuilder } from "@blaze-cardano/sdk";
import {
  PROPOSAL_LIFETIME,
  PROTOCOL_BOOT_TRANSACTION_ID,
  PROTOCOL_BOOT_TRANSACTION_INDEX,
  SCRIPT_REFERENCE_ADDRESS,
} from "@/Config.js";
import { Cosponsor, ICosponsoredProposal } from "@validators/Cosponsor.js";
import { CosponsorState } from "@validators/CosponsorState.js";
import { CosponsorTypes } from "@validators/GeneratedTypes/index.js";
import { serialize } from "@blaze-cardano/data";
import { Address } from "@blaze-cardano/core";

export interface IDepositWithdrawal {
  /** The transaction hash where funds were deposited */
  depositTxHash: string;
  /** The output index of the UTxO to withdraw */
  depositOutputIndex: number;
  /** The amount that was deposited (for validation) */
  depositAmount: bigint;
  /** The cosponsored proposal this deposit was for */
  cosponsoredProposal: ICosponsoredProposal;
}

export interface IWithdrawalArgs<P extends Provider, W extends Wallet> {
  blaze: Blaze<P, W>;
  /** Array of deposits to withdraw - can be from same or different proposals */
  deposits: IDepositWithdrawal[];
  /** Enable debug logging */
  debugMode?: boolean;
}

/**
 * Unified withdrawal function that can handle:
 * - Single deposit withdrawal
 * - Multiple deposits from same proposal
 * - Multiple deposits from different proposals
 * - Mixed amounts of gAda tokens
 */
export const withdraw = async <P extends Provider, W extends Wallet>({
  blaze,
  deposits,
  debugMode = false,
}: IWithdrawalArgs<P, W>): Promise<TxBuilder> => {
  const log = (...args: any[]) => {
    if (debugMode) {
      console.log(...args);
    }
  };
  if (deposits.length === 0) {
    throw new Error("No deposits provided for withdrawal");
  }

  log(`🔄 Starting withdrawal for ${deposits.length} deposits`);

  const tx = blaze.newTransaction();

  // Initialize state using first proposal (all should use same state)
  const cosponsorState = new CosponsorState(
    PROTOCOL_BOOT_TRANSACTION_ID,
    PROTOCOL_BOOT_TRANSACTION_INDEX,
    PROPOSAL_LIFETIME,
  );

  // Get script references once
  const scriptAddress = Address.fromBech32(SCRIPT_REFERENCE_ADDRESS);

  // Group deposits by proposal to calculate total per token type
  const proposalGroups = new Map<
    string,
    {
      proposal: ICosponsoredProposal;
      deposits: IDepositWithdrawal[];
      totalAmount: bigint;
    }
  >();

  for (const deposit of deposits) {
    const proposalKey = `${deposit.cosponsoredProposal.action.kind}-${deposit.cosponsoredProposal.anchor.url}`;

    if (!proposalGroups.has(proposalKey)) {
      proposalGroups.set(proposalKey, {
        proposal: deposit.cosponsoredProposal,
        deposits: [],
        totalAmount: 0n,
      });
    }

    const group = proposalGroups.get(proposalKey)!;
    group.deposits.push(deposit);
    group.totalAmount += deposit.depositAmount;
  }

  log(`📊 Withdrawing from ${proposalGroups.size} different proposal(s)`);

  // Find and validate all deposit UTxOs
  const depositUtxos: Array<{
    utxo: any;
    amount: bigint;
    deposit: IDepositWithdrawal;
  }> = [];

  let totalWithdrawalAmount = 0n;

  for (const deposit of deposits) {
    log(
      `🔍 Looking for deposit ${deposit.depositTxHash.slice(0, 16)}:${deposit.depositOutputIndex}`,
    );

    try {
      const ref = new Core.TransactionInput(
        Core.TransactionId(deposit.depositTxHash),
        BigInt(deposit.depositOutputIndex),
      );

      const result = await blaze.provider.resolveUnspentOutputs([ref]);
      if (result.length > 0) {
        const utxo = result[0];
        const amount = utxo.output().amount().coin();

        // Validate amount matches expected
        if (amount !== deposit.depositAmount) {
          if (debugMode) {
            console.warn(
              `⚠️ Amount mismatch for ${deposit.depositTxHash}:${deposit.depositOutputIndex}: expected ${deposit.depositAmount}, found ${amount}`,
            );
          }
        }

        depositUtxos.push({ utxo, amount, deposit });
        totalWithdrawalAmount += amount;
        log(`  ✅ Found UTxO: ${amount / 1_000_000n} ADA`);
      } else {
        throw new Error(
          `UTxO ${deposit.depositTxHash}:${deposit.depositOutputIndex} not found or already spent`,
        );
      }
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to find deposit UTxO: ${errorMessage}`);
    }
  }

  log(`💰 Total withdrawal amount: ${totalWithdrawalAmount / 1_000_000n} ADA`);

  // Add script references for first proposal (they should all use same cosponsor script)
  const firstProposalGroup = proposalGroups.values().next().value;
  if (!firstProposalGroup) {
    throw new Error("No proposal groups found");
  }

  const firstCosponsor = Cosponsor.new({
    statePolicyId: cosponsorState.script().hash(),
    cosponsoredProposal: firstProposalGroup.proposal,
  });

  const cosponsorReference = await blaze.provider.resolveScriptRef(
    firstCosponsor.script().hash(),
    scriptAddress,
  );

  if (!cosponsorReference) {
    throw new Error("Cosponsor script reference not found");
  }

  tx.addReferenceInput(cosponsorReference);

  const cosponsorStateReference = await blaze.provider.resolveScriptRef(
    cosponsorState.script().hash(),
    scriptAddress,
  );

  if (cosponsorStateReference) {
    tx.addReferenceInput(cosponsorStateReference);
  }

  // Add state UTxO as reference
  try {
    const stateNftAssetName = Buffer.from("cosponsor_state_nft").toString(
      "hex",
    );
    const statePolicy = cosponsorState.script().hash();
    const stateScriptAddress = cosponsorState.address(blaze.provider.network);

    const stateUtxos =
      await blaze.provider.getUnspentOutputs(stateScriptAddress);
    const stateAssetId = statePolicy + stateNftAssetName;

    for (const utxo of stateUtxos) {
      const multiasset = utxo.output().amount().multiasset();
      if (multiasset) {
        for (const [key] of multiasset.entries()) {
          if (key === stateAssetId) {
            tx.addReferenceInput(utxo);
            break;
          }
        }
      }
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    log(`⚠️ Could not find state UTxO: ${errorMessage}`);
  }

  // Create withdraw redeemer
  const withdrawRedeemer = serialize(
    CosponsorTypes.CosponsorWithdrawRedeemer,
    "WWithdraw",
  );

  // Add all deposit UTxOs as inputs
  for (const { utxo, deposit } of depositUtxos) {
    log(
      `📥 Adding deposit UTxO ${deposit.depositTxHash.slice(0, 16)}:${deposit.depositOutputIndex}`,
    );
    tx.addInput(utxo, withdrawRedeemer);
  }

  // Calculate required gAda tokens for each proposal type
  const requiredTokens = new Map<string, bigint>();
  const gAdaPolicyId = firstCosponsor.script().hash();

  for (const [proposalKey, group] of proposalGroups) {
    const cosponsor = Cosponsor.new({
      statePolicyId: cosponsorState.script().hash(),
      cosponsoredProposal: group.proposal,
    });

    const tokenAssetName = cosponsor.gAda();
    const assetId = gAdaPolicyId + tokenAssetName;
    requiredTokens.set(assetId, group.totalAmount);

    log(
      `🎯 Need ${group.totalAmount / 1_000_000n} gAda of token ${tokenAssetName.slice(0, 20)}... for ${group.deposits.length} deposits`,
    );
  }

  // Find wallet UTxOs with required gAda tokens
  const walletUtxos = await blaze.wallet.getUnspentOutputs();
  const selectedUtxos: any[] = [];
  const collectedTokens = new Map<string, bigint>();

  // Initialize collected amounts
  for (const assetId of requiredTokens.keys()) {
    collectedTokens.set(assetId, 0n);
  }

  log(
    `🔍 Scanning ${walletUtxos.length} wallet UTxOs for required gAda tokens...`,
  );

  for (let i = 0; i < walletUtxos.length; i++) {
    const utxo = walletUtxos[i];
    const multiasset = utxo.output().amount().multiasset();

    if (!multiasset) continue;

    let utxoIsUseful = false;

    for (const [assetId, amount] of multiasset.entries()) {
      if (requiredTokens.has(assetId)) {
        const tokenAmount =
          typeof amount === "bigint" ? amount : BigInt(amount);
        const currentCollected = collectedTokens.get(assetId)!;
        const needed = requiredTokens.get(assetId)!;

        if (currentCollected < needed) {
          collectedTokens.set(assetId, currentCollected + tokenAmount);
          utxoIsUseful = true;
          log(
            `  📦 UTxO ${i} has ${tokenAmount / 1_000_000n} gAda tokens we need`,
          );
        }
      }
    }

    if (utxoIsUseful) {
      selectedUtxos.push(utxo);
    }

    // Check if we have enough of all token types
    let allSatisfied = true;
    for (const [assetId, needed] of requiredTokens) {
      if (collectedTokens.get(assetId)! < needed) {
        allSatisfied = false;
        break;
      }
    }

    if (allSatisfied) {
      log(`✅ Found sufficient tokens after checking ${i + 1} UTxOs`);
      break;
    }
  }

  // Validate we have enough tokens
  for (const [assetId, needed] of requiredTokens) {
    const collected = collectedTokens.get(assetId)!;
    if (collected < needed) {
      const shortfall = needed - collected;
      throw new Error(
        `Insufficient gAda tokens: need ${needed / 1_000_000n}, have ${collected / 1_000_000n}, missing ${shortfall / 1_000_000n}`,
      );
    }
  }

  // Add selected UTxOs as inputs
  log(`📥 Adding ${selectedUtxos.length} wallet UTxOs containing gAda tokens`);
  for (const utxo of selectedUtxos) {
    tx.addInput(utxo);
  }

  // Create burn redeemer and burn tokens
  const burnRedeemer = serialize(CosponsorTypes.CosponsorMintRedeemer, {
    MRedeem: {
      proof: [],
      expiredProposals: {},
    },
  });

  // Burn all required gAda tokens
  const burnAmounts = new Map<Core.AssetName, bigint>();
  for (const [assetId, amount] of requiredTokens) {
    const assetName = assetId.substring(56); // Remove policy ID prefix
    burnAmounts.set(Core.AssetName(assetName), -amount); // Negative for burning
    log(
      `🔥 Burning ${amount / 1_000_000n} gAda of token ${assetName.slice(0, 20)}...`,
    );
  }

  tx.addMint(Core.PolicyId(gAdaPolicyId), burnAmounts, burnRedeemer);

  // Send recovered ADA to wallet
  const changeAddress = await blaze.wallet.getChangeAddress();
  tx.payAssets(changeAddress, makeValue(totalWithdrawalAmount));
  tx.setChangeAddress(changeAddress);

  log(`💰 Recovering ${totalWithdrawalAmount / 1_000_000n} ADA to wallet`);

  return tx;
};
