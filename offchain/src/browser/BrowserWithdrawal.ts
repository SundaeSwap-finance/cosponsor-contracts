
import { Core, makeValue, Blaze, Provider, Wallet } from "@blaze-cardano/sdk";
import { serialize } from "@blaze-cardano/data";
import { CosponsorTypes } from "@validators/GeneratedTypes/index.js";
import { BROWSER_CONFIG } from "./BrowserConfig.js";
import {
  IWithdrawalPlan,
  IScriptUtxo,
  selectUtxosForWithdrawal,
  fetchWithdrawalPlan,
} from "./fetchUserDeposits.js";

import { logger } from "../logger.js";
/**
 * Browser-compatible withdrawal function
 *
 * Uses biggest-first UTxO selection strategy. The on-chain validator
 * groups all non-expired UTxOs under the same key, so we can spend
 * any UTxOs as long as: burned_tokens = withdrawn_ada
 */
export const browserWithdraw = async ({
  blaze,
  withdrawalPlan,
  withdrawAmount,
}: {
  blaze: Blaze<Provider, Wallet>;
  withdrawalPlan: IWithdrawalPlan;
  /** Amount to withdraw in lovelace (must be <= availableToWithdraw) */
  withdrawAmount: bigint;
}) => {
  if (withdrawAmount <= 0n) {
    throw new Error("Withdrawal amount must be positive");
  }

  if (withdrawAmount > withdrawalPlan.availableToWithdraw) {
    throw new Error(
      `Cannot withdraw ${withdrawAmount / 1_000_000n} ADA - only ${withdrawalPlan.availableToWithdraw / 1_000_000n} ADA available`,
    );
  }

  logger.debug(`🔄 Starting withdrawal of ${withdrawAmount / 1_000_000n} ADA`);

  let tx = blaze.newTransaction();

  const cosponsorHash = BROWSER_CONFIG.scripts.cosponsor.hash;
  const scriptAddress = Core.Address.fromBech32(
    BROWSER_CONFIG.scriptReferenceAddress,
  );
  const cosponsorUtxoRef = BROWSER_CONFIG.scriptReferenceUtxos.cosponsor;

  // Resolve script reference (Kupo+Ogmios or Blockfrost fallback)
  let cosponsorReference = await blaze.provider.resolveScriptRef(
    Core.Hash28ByteBase16(cosponsorHash),
    scriptAddress,
  );

  if (cosponsorReference) {
    logger.debug("✅ Script reference resolved via provider");
  } else {
    logger.debug("⚠️ Using Blockfrost fallback for script reference...");

    const scriptCbor = BROWSER_CONFIG.scripts.cosponsor.cbor;
    if (!scriptCbor) {
      throw new Error("Cannot resolve script reference - no CBOR in config");
    }

    const plutusScript = Core.PlutusV3Script.fromCbor(Core.HexBlob(scriptCbor));
    const script = Core.Script.newPlutusV3Script(plutusScript);

    const computedHash = script.hash();
    if (computedHash !== cosponsorHash) {
      throw new Error(
        `Script hash mismatch: expected ${cosponsorHash}, got ${computedHash}`,
      );
    }

    const txInput = new Core.TransactionInput(
      Core.TransactionId(cosponsorUtxoRef.txHash),
      BigInt(cosponsorUtxoRef.outputIndex),
    );

    const resolvedUtxos = await blaze.provider.resolveUnspentOutputs([txInput]);
    if (resolvedUtxos.length === 0) {
      throw new Error(
        `Could not resolve reference UTxO: ${cosponsorUtxoRef.txHash}#${cosponsorUtxoRef.outputIndex}`,
      );
    }

    const resolvedUtxo = resolvedUtxos[0];
    const originalOutput = resolvedUtxo.output();
    const outputWithScript = new Core.TransactionOutput(
      originalOutput.address(),
      originalOutput.amount(),
    );
    const datum = originalOutput.datum();
    if (datum) outputWithScript.setDatum(datum);
    outputWithScript.setScriptRef(script);
    cosponsorReference = new Core.TransactionUnspentOutput(
      resolvedUtxo.input(),
      outputWithScript,
    );

    logger.debug("✅ Using pre-computed script CBOR");
  }

  tx = tx.addReferenceInput(cosponsorReference);

  // Add CosponsorState reference (required for validation)
  const stateHash = BROWSER_CONFIG.scripts.cosponsorState.hash;
  const stateNft = BROWSER_CONFIG.statePolicyId;
  const stateScriptAddress = Core.addressFromCredential(
    blaze.provider.network,
    Core.Credential.fromCore({
      hash: Core.Hash28ByteBase16(stateHash),
      type: Core.CredentialType.ScriptHash,
    }),
  );

  let stateReference = await blaze.provider.resolveScriptRef(
    Core.Hash28ByteBase16(stateHash),
    stateScriptAddress,
  );

  if (!stateReference) {
    const stateScriptUtxos =
      await blaze.provider.getUnspentOutputs(stateScriptAddress);
    const stateNftAssetId = stateNft + BROWSER_CONFIG.stateNftAssetName;

    for (const utxo of stateScriptUtxos) {
      const multiasset = utxo.output().amount().multiasset();
      if (!multiasset) continue;

      for (const [assetId] of multiasset.entries()) {
        if (assetId === stateNftAssetId) {
          stateReference = utxo;
          break;
        }
      }
      if (stateReference) break;
    }

    if (!stateReference) {
      throw new Error(
        "Could not find CosponsorState reference UTxO with state NFT",
      );
    }
  }

  tx = tx.addReferenceInput(stateReference);
  logger.debug("✅ Added CosponsorState reference input");

  // Select script UTxOs biggest-first to cover withdrawal amount
  const { selected: selectedUtxos, totalSelected } = selectUtxosForWithdrawal(
    withdrawalPlan.scriptUtxos,
    withdrawAmount,
  );

  if (totalSelected < withdrawAmount) {
    throw new Error(
      `Not enough ADA at script address: need ${withdrawAmount / 1_000_000n} ADA, only ${totalSelected / 1_000_000n} ADA available`,
    );
  }

  logger.debug(
    `📦 Selected ${selectedUtxos.length} UTxO(s) with ${totalSelected / 1_000_000n} ADA`,
  );

  // Add each selected UTxO as input
  const withdrawRedeemer = serialize(
    CosponsorTypes.CosponsorWithdrawRedeemer,
    "WWithdraw",
  );

  for (const scriptUtxo of selectedUtxos) {
    tx = tx.addInput(scriptUtxo.utxo, withdrawRedeemer);
    logger.debug(
      `  ✅ Added UTxO: ${scriptUtxo.txHash.slice(0, 16)}...#${scriptUtxo.outputIndex} (${scriptUtxo.lockedAmount / 1_000_000n} ADA)`,
    );
  }

  // Find wallet UTxOs with gADA tokens to burn
  const walletUtxos = await blaze.wallet.getUnspentOutputs();
  const selectedWalletUtxos: Core.TransactionUnspentOutput[] = [];
  const gAdaPolicyId = Core.PolicyId(cosponsorHash);

  // Collect tokens to burn (need to burn exactly withdrawAmount worth)
  let remainingToBurn = withdrawAmount;
  const tokensToBurn = new Map<string, bigint>(); // assetName -> amount to burn

  logger.debug(
    `🔍 Looking for ${withdrawAmount / 1_000_000n} ADA worth of gADA tokens to burn...`,
  );

  for (const utxo of walletUtxos) {
    if (remainingToBurn <= 0n) break;

    const multiasset = utxo.output().amount().multiasset();
    if (!multiasset) continue;

    let utxoHasTokens = false;

    for (const [assetId, amount] of multiasset.entries()) {
      if (!assetId.startsWith(cosponsorHash)) continue;

      const assetName = assetId.substring(56);
      const tokenAmount = typeof amount === "bigint" ? amount : BigInt(amount);

      if (tokenAmount > 0n && remainingToBurn > 0n) {
        const burnAmount =
          tokenAmount < remainingToBurn ? tokenAmount : remainingToBurn;
        const current = tokensToBurn.get(assetName) || 0n;
        tokensToBurn.set(assetName, current + burnAmount);
        remainingToBurn -= burnAmount;
        utxoHasTokens = true;
        logger.debug(
          `  📦 Found ${burnAmount / 1_000_000n} ADA worth of token ${assetName.slice(0, 16)}...`,
        );
      }
    }

    if (utxoHasTokens) {
      selectedWalletUtxos.push(utxo);
    }
  }

  if (remainingToBurn > 0n) {
    throw new Error(
      `Insufficient gADA tokens: need ${withdrawAmount / 1_000_000n} ADA worth, missing ${remainingToBurn / 1_000_000n} ADA worth`,
    );
  }

  // Add wallet UTxOs containing gADA tokens
  for (const utxo of selectedWalletUtxos) {
    tx = tx.addInput(utxo);
  }

  // Create burn redeemer and burn tokens
  const burnRedeemer = serialize(CosponsorTypes.CosponsorMintRedeemer, {
    MRedeem: {
      proof: [],
      expiredProposals: {},
    },
  });

  const burnAmounts = new Map<Core.AssetName, bigint>();
  for (const [assetName, amount] of tokensToBurn) {
    burnAmounts.set(Core.AssetName(assetName), -amount); // Negative for burning
    logger.debug(
      `🔥 Burning ${amount / 1_000_000n} gADA of token ${assetName.slice(0, 16)}...`,
    );
  }

  tx = tx.addMint(gAdaPolicyId, burnAmounts, burnRedeemer);

  // Get wallet address
  const changeAddress = await blaze.wallet.getChangeAddress();

  // Add required signer
  const paymentCredential = changeAddress.getProps().paymentPart;
  if (
    paymentCredential &&
    paymentCredential.type === Core.CredentialType.KeyHash
  ) {
    tx = tx.addRequiredSigner(
      Core.Ed25519KeyHashHex(paymentCredential.hash),
    );
    logger.debug(
      `✍️ Added required signer: ${paymentCredential.hash.slice(0, 16)}...`,
    );
  } else {
    throw new Error("Cannot extract payment key hash from wallet address");
  }

  // Handle change if we selected more ADA than we're withdrawing
  // The excess MUST go back to the script address with the original datum
  // to satisfy the no_ada_leak validator check
  const excessAda = totalSelected - withdrawAmount;
  if (excessAda > 0n) {
    logger.debug(
      `💫 Returning ${excessAda / 1_000_000n} ADA back to script address`,
    );

    // Calculate cosponsor script address
    const cosponsorScriptAddress = Core.addressFromCredential(
      blaze.provider.network,
      Core.Credential.fromCore({
        hash: Core.Hash28ByteBase16(cosponsorHash),
        type: Core.CredentialType.ScriptHash,
      }),
    );

    // Get the datum from the first selected UTxO (they all have the same proposal key)
    const firstUtxoDatum = selectedUtxos[0].utxo.output().datum();
    if (!firstUtxoDatum) {
      throw new Error("Selected UTxO has no datum - cannot create change output");
    }

    // Send excess back to script with original datum.
    // Cast bridges Blaze's Datum type and the equivalent from @cardano-sdk/core
    // that surfaces here via transitive types; they are structurally the same.
    tx = tx.lockAssets(
      cosponsorScriptAddress,
      makeValue(excessAda),
      firstUtxoDatum as unknown as Core.Datum,
    );
  }

  // Send withdrawn ADA to wallet
  tx = tx.payAssets(changeAddress, makeValue(withdrawAmount));
  tx = tx.setChangeAddress(changeAddress);

  logger.debug(`💰 Withdrawing ${withdrawAmount / 1_000_000n} ADA to wallet`);
  logger.debug("✅ Withdrawal transaction built successfully");

  return tx;
};

// Legacy wrapper for backward compatibility
export const browserWithdrawLegacy = async ({
  blaze,
  deposits,
}: {
  blaze: Blaze<Provider, Wallet>;
  deposits: { depositAmount: bigint; tokenAssetName: string }[];
}) => {
  // Use the new approach
  const plan = await fetchWithdrawalPlan(blaze);

  const totalAmount = deposits.reduce((sum, d) => sum + d.depositAmount, 0n);

  return browserWithdraw({
    blaze,
    withdrawalPlan: plan,
    withdrawAmount: totalAmount,
  });
};

// Re-export types for convenience
export type { IWithdrawalPlan, IScriptUtxo };
