import { CardanoProvider } from "@utils/provider.js";
import { Cosponsor } from "@validators/Cosponsor.js";
import { CosponsorState } from "@validators/CosponsorState.js";
import { AlwaysTrue } from "@validators/AlwaysTrue.js";
import { Core } from "@blaze-cardano/sdk";
import {
  PROPOSAL_LIFETIME,
  PROTOCOL_BOOT_TRANSACTION_ID,
  PROTOCOL_BOOT_TRANSACTION_INDEX,
} from "@/Config.js";

interface ScriptDeployment {
  name: string;
  script: any;
  hash: string;
}

export const deployContracts = async (
  cardanoProvider: CardanoProvider,
  deployToAddress?: string,
  // Optional bootstrap overrides. Default to the Config baked-in values so
  // running `bun run deploy` standalone is unchanged. The redeploy orchestrator
  // passes a freshly-created boot UTxO explicitly so the deployed scripts are
  // parameterized on the NEW boot id rather than Config's module-level default
  // (which is frozen at import time and cannot be swapped afterwards).
  bootId: string = PROTOCOL_BOOT_TRANSACTION_ID,
  bootIndex: bigint = PROTOCOL_BOOT_TRANSACTION_INDEX,
  lifetime: bigint = PROPOSAL_LIFETIME,
): Promise<Map<string, Core.TransactionId>> => {
  console.log("=== Deploying Parameterized Scripts ===");

  const blaze = cardanoProvider.getBlaze();
  const deployedContracts = new Map<string, Core.TransactionId>();

  const changeAddress = await cardanoProvider.getWalletAddress();

  // Determine deployment target address
  const deploymentAddress = deployToAddress
    ? Core.Address.fromBech32(deployToAddress)
    : changeAddress;

  console.log(`Deploying to: ${deploymentAddress.toBech32()}`);
  console.log(`Boot UTxO: ${bootId}:${bootIndex}`);
  console.log("");

  // Create the parameterized scripts that transactions actually need
  const cosponsorState = new CosponsorState(bootId, bootIndex, lifetime);

  const cosponsor = Cosponsor.new({
    statePolicyId: cosponsorState.script().hash(),
  });

  const alwaysTrueScript = AlwaysTrue.script();

  const scriptsToDeployArray: ScriptDeployment[] = [
    {
      name: "CosponsorState",
      script: cosponsorState.script(),
      hash: cosponsorState.script().hash(),
    },
    {
      name: "Cosponsor (Parameterized)",
      script: cosponsor.script(),
      hash: cosponsor.script().hash(),
    },
    {
      name: "AlwaysTrue",
      script: alwaysTrueScript,
      hash: alwaysTrueScript.hash(),
    },
  ];

  console.log(`Scripts to deploy: ${scriptsToDeployArray.length}`);
  scriptsToDeployArray.forEach((s) => {
    console.log(`  - ${s.name}: ${s.hash}`);
  });
  console.log("");

  let count = 1;
  for (const scriptDeployment of scriptsToDeployArray) {
    console.log(
      `Deploying ${count}/${scriptsToDeployArray.length}: ${scriptDeployment.name}`,
    );
    console.log(`Hash: ${scriptDeployment.hash}`);

    let txHashForWait: string | null = null;

    try {
      // Check if script already exists at target address
      if (deployToAddress) {
        try {
          const utxoResponse = await fetch(
            `https://cardano-preview.blockfrost.io/api/v0/addresses/${deployToAddress}/utxos`,
            {
              headers: { project_id: process.env.BLOCKFROST_API_KEY || "" },
            },
          );

          if (utxoResponse.ok) {
            const utxos = await utxoResponse.json();
            const scriptExists = utxos.some(
              (utxo: any) =>
                utxo.reference_script_hash === scriptDeployment.hash,
            );

            if (scriptExists) {
              console.log(`✓ Script already deployed to address`);
              deployedContracts.set(
                scriptDeployment.name,
                scriptDeployment.hash as Core.TransactionId,
              );
              continue;
            } else {
              console.log(`Script not found at address, deploying...`);
            }
          }
        } catch (e) {
          console.log(
            `Error checking address UTxOs, proceeding with deployment: ${e}`,
          );
        }
      }

      const tx = blaze.newTransaction();
      tx.deployScript(
        Core.Script.newPlutusV3Script(scriptDeployment.script),
        deploymentAddress,
      );
      tx.setChangeAddress(changeAddress);

      console.log("Building transaction...");
      const builtTx = await tx.complete();

      const body = builtTx.body();
      console.log(
        `Transaction has ${body.inputs().size()} inputs and ${body.outputs().length} outputs`,
      );
      console.log(`Fee: ${body.fee()} lovelace`);

      console.log("Signing and submitting transaction...");
      const signedTx = await blaze.signTransaction(builtTx);
      const txHash = await blaze.provider.postTransactionToChain(signedTx);

      console.log(`✓ Transaction submitted successfully!`);
      console.log(`Transaction Hash: ${txHash}`);
      console.log(
        `View on Cardanoscan: https://preview.cardanoscan.io/transaction/${txHash}`,
      );

      deployedContracts.set(scriptDeployment.name, txHash);
      txHashForWait = txHash;
    } catch (error) {
      console.error(`✗ Failed to deploy: ${error}`);
    }

    // Wait for confirmation and refresh UTxOs between deployments
    if (count < scriptsToDeployArray.length) {
      if (txHashForWait) {
        console.log("Waiting for transaction confirmation...");
        await blaze.provider.awaitTransactionConfirmation(txHashForWait);
        console.log("Transaction confirmed");

        console.log("Refreshing wallet UTxOs...");
        await blaze.wallet.getUnspentOutputs();
        console.log("UTxOs refreshed");

        if (deployToAddress) {
          console.log("Additional wait for UTxO settlement...");
          await new Promise((resolve) => setTimeout(resolve, 10000));
        }
      } else {
        console.log("Waiting 5 seconds before next deployment...");
        await new Promise((resolve) => setTimeout(resolve, 5000));
      }
    }

    count++;
  }

  console.log(`\n${"=".repeat(70)}`);
  console.log("DEPLOYMENT COMPLETE");
  console.log("=".repeat(70));
  console.log(
    `Total contracts processed: ${deployedContracts.size}/${scriptsToDeployArray.length} contracts`,
  );

  if (deployedContracts.size > 0) {
    console.log("\n📝 All contracts (deployed + existing):");
    for (const [name, hashOrTxId] of deployedContracts) {
      const script = scriptsToDeployArray.find((s) => s.name === name);
      console.log(`- ${name}`);
      console.log(`  Script Hash: ${script?.hash}`);
      console.log(`  Deployment ID: ${hashOrTxId}`);
    }

    console.log("\nView on Cardano Preview Testnet Explorer:");
    for (const [name] of deployedContracts) {
      const script = scriptsToDeployArray.find((s) => s.name === name);
      console.log(
        `${name}: https://preview.cardanoscan.io/script/${script?.hash}`,
      );
    }
  }

  console.log("=".repeat(70));

  // Save deployed contracts to JSON file
  const deploymentInfo = {
    timestamp: new Date().toISOString(),
    network: "cardano-preview",
    projectTitle: "cosponsor-parameterized",
    projectVersion: "1.0.0",
    plutusVersion: "v3",
    totalValidators: scriptsToDeployArray.length,
    deployedCount: deployedContracts.size,
    walletAddress: changeAddress.toBech32(),
    deploymentAddress: deploymentAddress.toBech32(),
    contracts: Array.from(deployedContracts.entries()).map(
      ([name, txHashOrScriptHash]) => {
        const script = scriptsToDeployArray.find((s) => s.name === name);
        return {
          name: name,
          scriptHash: script?.hash || "",
          deploymentId: txHashOrScriptHash,
          explorerUrl: `https://preview.cardanoscan.io/transaction/${txHashOrScriptHash}`,
          scriptUrl: `https://preview.cardanoscan.io/script/${script?.hash}`,
        };
      },
    ),
  };

  console.log(`\nDeployment info saved to: deployed-contracts.json`);

  try {
    const fs = await import("fs");
    const path = await import("path");
    const { fileURLToPath } = await import("url");
    const { dirname } = await import("path");

    const __filename = fileURLToPath(import.meta.url);
    const __dirname = dirname(__filename);
    const outputPath = path.join(__dirname, "../../../deployed-contracts.json");

    fs.writeFileSync(outputPath, JSON.stringify(deploymentInfo, null, 2));
  } catch (e) {
    console.log(`Error saving deployment info: ${e}`);
  }

  return deployedContracts;
};

const main = async () => {
  console.log("Starting Smart Contract Deployment");
  console.log("=====================================");

  let cardanoProvider: CardanoProvider | null = null;

  try {
    // Initialize provider from environment
    cardanoProvider = await CardanoProvider.fromEnv();

    // Check for deployment address argument
    const deployToAddress = process.argv
      .find((arg) => arg.startsWith("--deploy-to="))
      ?.split("=")[1];

    // Deploy contracts
    await deployContracts(cardanoProvider, deployToAddress);
  } catch (error) {
    console.error("Deploy script failed:", error);
    process.exit(1);
  } finally {
    // Cleanup
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
  console.log("Executing deploy script...");
  main().catch((error) => {
    console.error("Deploy script failed:", error);
    process.exit(1);
  });
}

export default deployContracts;
