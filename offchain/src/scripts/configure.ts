import dotenv from 'dotenv'
import { CardanoProvider } from '../utils/provider.js'
import { Core } from "@blaze-cardano/sdk";
import { makeValue } from "@blaze-cardano/sdk";
import { PROPOSAL_LIFETIME } from "../Config.js";

dotenv.config()

export const createConfigurationTransaction = async (
  cardanoProvider: CardanoProvider
): Promise<string> => {
  console.log("=== Creating Protocol Configuration Transaction ===")
  
  const blaze = cardanoProvider.getBlaze();
  const tx = blaze.newTransaction();

  // Create a configuration UTxO that contains the proposal lifetime
  // This will serve as the protocol's bootstrap/genesis transaction
  const configAddress = await blaze.wallet.getChangeAddress();
  
  console.log(`Configuration details:`);
  console.log(`  Proposal Lifetime: ${PROPOSAL_LIFETIME} milliseconds (${PROPOSAL_LIFETIME / (1000n * 60n * 60n * 24n)} days)`);
  console.log(`  Configuration Address: ${configAddress.toBech32()}`);

  // Create a simple UTxO that will serve as our configuration/genesis transaction
  // The important part is having a real transaction ID that the scripts can reference
  // The actual proposal lifetime is compiled into the scripts via parameters
  tx.payAssets(configAddress, makeValue(5_000_000n)); // 5 ADA

  tx.setChangeAddress(configAddress);

  console.log("Building configuration transaction...");
  const completed = await tx.complete();
  
  console.log("✓ Configuration transaction built successfully");
  
  const signed = await blaze.signTransaction(completed);
  console.log("✓ Configuration transaction signed");
  
  const txId = await blaze.provider.postTransactionToChain(signed);
  console.log(`✓ Configuration transaction submitted!`);
  console.log(`Configuration Transaction ID: ${txId}`);
  console.log(`This transaction ID should be used as PROTOCOL_BOOT_TRANSACTION_ID`);
  
  return txId;
}

const main = async () => {
  console.log("Starting Protocol Configuration");
  console.log("==============================");
  
  let cardanoProvider: CardanoProvider | null = null;
  
  try {
    console.log("Initializing CardanoProvider...");
    cardanoProvider = await CardanoProvider.fromEnv();
    console.log("CardanoProvider initialized successfully");
    
    // Check balance
    const balance = await cardanoProvider.getWalletBalance();
    if (balance.balance < 10_000_000n) {
      throw new Error(`Insufficient balance. Need at least 10 ADA, have ${balance.balance / 1_000_000n} ADA`);
    }
    
    // Create configuration transaction
    const configTxId = await createConfigurationTransaction(cardanoProvider);
    
    console.log("\n" + "=".repeat(60));
    console.log("NEXT STEPS:");
    console.log("1. Update Config.ts with:");
    console.log(`   PROTOCOL_BOOT_TRANSACTION_ID = "${configTxId}"`);
    console.log("2. Redeploy the scripts with: bun run deploy");
    console.log("3. Try the deposit transaction again");
    console.log("=".repeat(60));
    
  } catch (error) {
    console.error("Configuration failed:", error);
    process.exit(1);
  } finally {
    if (cardanoProvider) {
      await cardanoProvider.cleanup();
    }
  }
}

// Run main if this script is executed directly
if (process.argv[1] && import.meta.url.includes(process.argv[1].replace(/\\/g, '/'))) {
  main().catch(console.error);
}

export default createConfigurationTransaction;