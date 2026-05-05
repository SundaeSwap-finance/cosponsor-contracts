import dotenv from "dotenv";
import { CardanoProvider } from "@utils/provider";
import { Core } from "@blaze-cardano/sdk";
import { makeValue } from "@blaze-cardano/sdk";
import {
  PROPOSAL_LIFETIME,
  PROTOCOL_BOOT_TRANSACTION_ID,
  PROTOCOL_BOOT_TRANSACTION_INDEX,
  SCRIPT_REFERENCE_ADDRESS,
  MIN_WALLET_BALANCE,
} from "@/Config";
import { CosponsorState } from "@validators/CosponsorState";
import { CosponsorTypes } from "@validators/GeneratedTypes";
import { serialize } from "@blaze-cardano/data";
import { Address } from "@blaze-cardano/core";
import { PlutusData } from "@blaze-cardano/core";

dotenv.config();

export const mintStateNft = async (
  cardanoProvider: CardanoProvider,
): Promise<string> => {
  console.log("=== Minting State NFT ===");

  const blaze = cardanoProvider.getBlaze();
  const tx = blaze.newTransaction();

  // Create the CosponsorState instance
  const cosponsorState = new CosponsorState(
    PROTOCOL_BOOT_TRANSACTION_ID,
    PROTOCOL_BOOT_TRANSACTION_INDEX,
    PROPOSAL_LIFETIME,
  );

  const statePolicy = cosponsorState.script().hash();
  const stateNftName = Buffer.from("cosponsor_state_nft").toString("hex");

  console.log(`State Policy ID: ${statePolicy}`);
  console.log(`State NFT Name: ${stateNftName}`);
  console.log(
    `Protocol Boot UTxO: ${PROTOCOL_BOOT_TRANSACTION_ID}:${PROTOCOL_BOOT_TRANSACTION_INDEX}`,
  );

  // Find and spend the protocol boot UTxO
  const bootUtxoRef = new Core.TransactionInput(
    Core.TransactionId(PROTOCOL_BOOT_TRANSACTION_ID),
    BigInt(PROTOCOL_BOOT_TRANSACTION_INDEX),
  );

  const bootUtxoResult = await blaze.provider.resolveUnspentOutputs([
    bootUtxoRef,
  ]);
  if (bootUtxoResult.length === 0) {
    throw new Error(
      `Protocol boot UTxO not found: ${PROTOCOL_BOOT_TRANSACTION_ID}:${PROTOCOL_BOOT_TRANSACTION_INDEX}`,
    );
  }

  const bootUtxo = bootUtxoResult[0];
  console.log(
    `✓ Found protocol boot UTxO with ${bootUtxo.output().amount().coin()} lovelace`,
  );

  // Add the boot UTxO as input (required by the minting policy)
  tx.addInput(bootUtxo);

  // Get script reference for the CosponsorState minting policy
  const scriptAddress = Address.fromBech32(SCRIPT_REFERENCE_ADDRESS);

  const stateScriptRef = await blaze.provider.resolveScriptRef(
    statePolicy,
    scriptAddress,
  );

  if (!stateScriptRef) {
    throw new Error(
      "CosponsorState script reference not found - make sure scripts are deployed",
    );
  }

  tx.addReferenceInput(stateScriptRef);

  // Mint exactly one state NFT (no redeemer needed for CosponsorState minting - it validates based on inputs)
  tx.addMint(
    Core.PolicyId(statePolicy),
    new Map<Core.AssetName, bigint>([[Core.AssetName(stateNftName), 1n]]),
    PlutusData.newBytes(new Uint8Array([])), // Empty redeemer as PlutusData
  );

  // Create an empty state datum
  const stateDatum = serialize(CosponsorTypes.CosponsorStateDatum, {
    expiredProposalsMpfRoot: "0".repeat(64), // Empty MPF root - 32 bytes of zeros as hex
  });

  // Create a single output with ADA + NFT + datum using the treasury-contracts pattern
  const stateScriptAddress = cosponsorState.address(blaze.provider.network);

  console.log(
    "Using treasury-contracts pattern: policy + assetName concatenation with makeValue spread syntax",
  );

  // Use the treasury-contracts pattern: concatenate policy + asset name and use makeValue with spread syntax
  const assetId = statePolicy + stateNftName;
  const stateValueWithNft = makeValue(2_000_000n, [assetId, 1n]);

  console.log(`Asset ID: ${assetId}`);
  console.log(`Creating value with 2 ADA and 1 ${assetId}`);

  // Send this combined value (ADA + NFT) with the datum to the script address
  tx.lockAssets(stateScriptAddress, stateValueWithNft, stateDatum);

  console.log(`State script address: ${stateScriptAddress.toBech32()}`);

  tx.setChangeAddress(await blaze.wallet.getChangeAddress());

  console.log("Building state NFT minting transaction...");
  const completed = await tx.complete();

  console.log("✓ State NFT minting transaction built successfully");

  const signed = await blaze.signTransaction(completed);
  console.log("✓ State NFT minting transaction signed");

  const txId = await blaze.provider.postTransactionToChain(signed);
  console.log(`✓ State NFT minting transaction submitted!`);
  console.log(`Transaction ID: ${txId}`);

  return txId;
};

const main = async () => {
  console.log("Minting State NFT");
  console.log("=================");

  let cardanoProvider: CardanoProvider | null = null;

  try {
    console.log("Initializing CardanoProvider...");
    cardanoProvider = await CardanoProvider.fromEnv();
    console.log("CardanoProvider initialized successfully");

    // Check balance
    const balance = await cardanoProvider.getWalletBalance();
    console.log(`Current wallet balance: ${balance.balance / 1_000_000n} ADA`);

    if (balance.balance < MIN_WALLET_BALANCE) {
      throw new Error(
        `Insufficient balance. Need at least ${MIN_WALLET_BALANCE / 1_000_000n} ADA, have ${balance.balance / 1_000_000n} ADA`,
      );
    }

    // Mint state NFT
    const txId = await mintStateNft(cardanoProvider);

    console.log("\n" + "=".repeat(60));
    console.log("SUCCESS!");
    console.log(`State NFT minted in transaction: ${txId}`);
    console.log("The protocol is now properly configured for withdrawals.");
    console.log("=".repeat(60));
  } catch (error) {
    console.error("State NFT minting failed:", error);
    process.exit(1);
  } finally {
    if (cardanoProvider) {
      await cardanoProvider.cleanup();
    }
  }
};

// Run main if this script is executed directly
if (
  process.argv[1] &&
  import.meta.url.includes(process.argv[1].replace(/\\/g, "/"))
) {
  main().catch(console.error);
}

export default mintStateNft;
