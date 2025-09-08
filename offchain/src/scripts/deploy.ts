import { Core } from "@blaze-cardano/sdk";
import { PlutusV3Script } from "@blaze-cardano/core";
import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";
import { dirname } from "path";
import { CardanoProvider } from "../utils/provider.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

interface PlutusContract {
  preamble: {
    title: string;
    description: string;
    version: string;
    plutusVersion: string;
  };
  validators: Array<{
    title: string;
    compiledCode: string;
    hash: string;
    parameters?: Array<{
      title: string;
      schema: any;
    }>;
  }>;
}

export const deployContracts = async (
  cardanoProvider: CardanoProvider
): Promise<Map<string, Core.TransactionId>> => {
  const blaze = cardanoProvider.getBlaze();
  const deployedContracts = new Map<string, Core.TransactionId>();
  
  const plutusJsonPath = path.join(__dirname, "../../../plutus.json");
  const plutusData = JSON.parse(fs.readFileSync(plutusJsonPath, "utf-8")) as PlutusContract;
  
  console.log(`Deploying contracts from ${plutusData.preamble.title}`);
  console.log(`Version: ${plutusData.preamble.version}`);
  console.log(`Total validators: ${plutusData.validators.length}`);
  console.log("");

  const changeAddress = await cardanoProvider.getWalletAddress();
  
  // Get unique validators (based on hash)
  const uniqueValidators = new Map();
  plutusData.validators.forEach(v => {
    if (!uniqueValidators.has(v.hash)) {
      uniqueValidators.set(v.hash, v);
    }
  });
  
  console.log(`Unique validators to deploy: ${uniqueValidators.size}`);
  console.log("");
  
  let count = 1;
  for (const [hash, validator] of uniqueValidators) {
    console.log(`Deploying ${count}/${uniqueValidators.size}: ${validator.title}`);
    console.log(`Hash: ${hash}`);
    
    let txHashForWait: string | null = null;
    
    try {
      // Check if script is already deployed by querying Blockfrost directly
      try {
        const response = await fetch(`https://cardano-preview.blockfrost.io/api/v0/scripts/${validator.hash}`, {
          headers: { 'project_id': process.env.BLOCKFROST_API_KEY || '' }
        });
        
        if (response.ok) {
          console.log(`Script already deployed with hash: ${validator.hash}`);
          deployedContracts.set(validator.title, validator.hash as Core.TransactionId);
          continue;
        }
      } catch (e) {
        console.log(`Script not found on-chain, proceeding with deployment`);
      }

      const plutusScript = new PlutusV3Script(validator.compiledCode as any);
      const script = Core.Script.newPlutusV3Script(plutusScript);

      const tx = blaze.newTransaction();
      tx.deployScript(script, changeAddress);
      tx.setChangeAddress(changeAddress);

      console.log('Building transaction...');
      const builtTx = await tx.complete();
      
      const body = builtTx.body();
      console.log(`Transaction has ${body.inputs().size()} inputs and ${body.outputs().length} outputs`);
      console.log(`Fee: ${body.fee()} lovelace`);

      console.log('Signing and submitting transaction...');
      const signedTx = await blaze.signTransaction(builtTx);
      const txHash = await blaze.provider.postTransactionToChain(signedTx);

      console.log(`Transaction submitted successfully!`);
      console.log(`Transaction Hash: ${txHash}`);
      console.log(`View on Cardanoscan: https://preview.cardanoscan.io/transaction/${txHash}`);
      
      deployedContracts.set(validator.title, txHash);
      txHashForWait = txHash;
      
    } catch (error) {
      console.error(`Failed to deploy: ${error}`);
    }
    
    // Wait for confirmation and refresh UTxOs between deployments to avoid UTxO conflicts
    if (count < uniqueValidators.size) {
      if (txHashForWait) {
        console.log('Waiting for transaction confirmation...');
        await blaze.provider.awaitTransactionConfirmation(txHashForWait);
        console.log('Transaction confirmed');
        
        // Refresh wallet UTxOs for next deployment
        console.log('Refreshing wallet UTxOs for next deployment...');
        await blaze.wallet.getUnspentOutputs();
        console.log('UTxOs refreshed');
      } else {
        console.log('Waiting 5 seconds before next deployment...');
        await new Promise(resolve => setTimeout(resolve, 5000));
      }
    }
    
    count++;
  }
  
  console.log("\n" + "=".repeat(70));
  console.log("DEPLOYMENT COMPLETE");
  console.log("=".repeat(70));
  console.log(`Total contracts processed: ${deployedContracts.size}/${uniqueValidators.size} contracts`);
  
  if (deployedContracts.size > 0) {
    console.log("\n📝 All contracts (deployed + existing):");
    for (const [name, hashOrTxId] of deployedContracts) {
      const validator = Array.from(uniqueValidators.values()).find(v => v.title === name);
      console.log(`- ${name}`);
      console.log(`Script Hash: ${validator?.hash}`);
      console.log(`Deployment ID: ${hashOrTxId}`);
    }
    
    console.log("\nView on Cardano Preview Testnet Explorer:");
    for (const [name, hashOrTxId] of deployedContracts) {
      const validator = Array.from(uniqueValidators.values()).find(v => v.title === name);
      console.log(`Script: https://preview.cardanoscan.io/script/${validator?.hash}`);
    }
  }
  
  console.log("=".repeat(70));
  
  // Save deployed contracts to JSON file
  const deploymentInfo = {
    timestamp: new Date().toISOString(),
    network: "cardano-preview",
    projectTitle: plutusData.preamble.title,
    projectVersion: plutusData.preamble.version,
    plutusVersion: plutusData.preamble.plutusVersion,
    totalValidators: uniqueValidators.size,
    deployedCount: deployedContracts.size,
    walletAddress: changeAddress.toBech32(),
    contracts: Array.from(deployedContracts.entries()).map(([name, txHashOrScriptHash]) => {
      const validator = Array.from(uniqueValidators.values()).find(v => v.title === name);
      return {
        name: name,
        scriptHash: validator?.hash || '',
        compiledCode: validator?.compiledCode || '',
        deploymentId: txHashOrScriptHash,
        explorerUrl: `https://preview.cardanoscan.io/transaction/${txHashOrScriptHash}`,
        scriptUrl: `https://preview.cardanoscan.io/script/${validator?.hash}`
      };
    })
  };
  
  const outputPath = path.join(__dirname, "../../../deployed-contracts.json");
  fs.writeFileSync(outputPath, JSON.stringify(deploymentInfo, null, 2));
  console.log(`\nDeployment info saved to: deployed-contracts.json`);
  
  return deployedContracts;
}

const main = async () => {
  console.log("Starting Smart Contract Deployment");
  console.log("=====================================");
  
  let cardanoProvider: CardanoProvider | null = null;
  
  try {
    // Initialize provider from environment
    cardanoProvider = await CardanoProvider.fromEnv();
    
    // Deploy contracts
    await deployContracts(cardanoProvider);
    
  } catch (error) {
    console.error("Deploy script failed:", error);
    process.exit(1);
  } finally {
    // Cleanup
    if (cardanoProvider) {
      await cardanoProvider.cleanup();
    }
  }
}

// Run main if this script is executed directly
if (process.argv[1] && import.meta.url.includes(process.argv[1].replace(/\\/g, '/'))) {
  console.log("Executing deploy script...");
  main().catch(error => {
    console.error("Deploy script failed:", error);
    process.exit(1);
  });
}

export default deployContracts;