/* eslint-disable no-console */
import dotenv from "dotenv";
import { Core } from "@blaze-cardano/sdk";
import { CardanoProvider } from "@utils/provider";
import { Cosponsor, ICosponsoredProposal } from "@validators/Cosponsor";
import { CosponsorState } from "@validators/CosponsorState";
import {
  PROPOSAL_LIFETIME,
  PROTOCOL_BOOT_TRANSACTION_ID,
  PROTOCOL_BOOT_TRANSACTION_INDEX,
} from "@/Config";
import { TGovernanceAction } from "@validators/Types/GovernanceAction";

dotenv.config();

// Same mock proposal as used in deposit
const mockProposal: ICosponsoredProposal = {
  deposit: 100_000_000n,
  anchor: {
    url: Buffer.from("https://example.com/proposal.json").toString("hex"),
    hash: "0000000000000000000000000000000000000000000000000000000000000000",
  },
  action: {
    kind: "NicePoll",
  } as TGovernanceAction,
};

const inspectDeposit = async (depositTxHash: string) => {
  console.log("=== Inspecting Deposit Transaction ===");
  console.log(`Transaction: ${depositTxHash}`);

  let cardanoProvider: CardanoProvider | null = null;

  try {
    // Initialize provider
    console.log("Initializing CardanoProvider...");
    cardanoProvider = await CardanoProvider.fromEnv();
    const blaze = cardanoProvider.getBlaze();

    // Set up the same script configuration as used in deposit
    const cosponsorState = new CosponsorState(
      PROTOCOL_BOOT_TRANSACTION_ID,
      PROTOCOL_BOOT_TRANSACTION_INDEX,
      PROPOSAL_LIFETIME,
    );

    const cosponsor = Cosponsor.new({
      statePolicyId: cosponsorState.script().hash(),
      cosponsoredProposal: mockProposal,
    });

    console.log(`\nExpected gAda token info:`);
    console.log(`  Policy ID: ${cosponsor.script().hash()}`);
    console.log(`  Asset Name: ${cosponsor.gAda()}`);
    console.log(
      `  Script Address: ${cosponsor.address(blaze.provider.network).toBech32()}`,
    );

    console.log(`\nChecking ALL transaction outputs...`);

    const maxOutputs = 5;
    let foundScriptUtxo = false;
    let totalTokensFound = 0;

    for (let i = 0; i < maxOutputs; i++) {
      try {
        const ref = new Core.TransactionInput(
          Core.TransactionId(depositTxHash),
          BigInt(i),
        );

        const result = await blaze.provider.resolveUnspentOutputs([ref]);
        if (result.length > 0) {
          const utxo = result[0];
          const address = utxo.output().address().toBech32();
          const adaAmount = utxo.output().amount().coin();
          const multiasset = utxo.output().amount().multiasset();

          console.log(`\n  Output ${i}:`);
          console.log(`    Address: ${address}`);
          console.log(`    ADA: ${adaAmount} lovelace`);

          const scriptAddress = cosponsor
            .address(blaze.provider.network)
            .toBech32();
          if (address === scriptAddress) {
            console.log(`    ✅ This is the SCRIPT UTxO`);
            foundScriptUtxo = true;
          }

          if (multiasset) {
            console.log(`    Native Assets:`);
            let assetsInThisOutput = 0;

            for (const [policyId, assets] of multiasset.entries()) {
              console.log(`      Policy: ${policyId}`);

              // Check if assets has entries method or try different access patterns
              if (assets && typeof assets.entries === "function") {
                for (const [assetName, amount] of assets.entries()) {
                  assetsInThisOutput++;
                  totalTokensFound++;
                  console.log(`        Asset: ${assetName}`);
                  console.log(`        Amount: ${amount}`);

                  // Check if this matches our expected gAda token
                  if (policyId === cosponsor.script().hash()) {
                    console.log(`        🎯 POLICY MATCH!`);
                    if (assetName === cosponsor.gAda()) {
                      console.log(
                        `        🎯 ASSET NAME MATCH! This is gAda token! Amount: ${amount}`,
                      );
                    } else {
                      console.log(
                        `        Asset name differs from expected: ${cosponsor.gAda()}`,
                      );
                    }
                  }
                }
              } else if (assets && typeof assets.keys === "function") {
                // Try alternative access method
                for (const assetName of assets.keys()) {
                  const amount = assets.get(assetName);
                  assetsInThisOutput++;
                  totalTokensFound++;
                  console.log(`        Asset (alt): ${assetName}`);
                  console.log(`        Amount (alt): ${amount}`);

                  if (
                    policyId === cosponsor.script().hash() &&
                    assetName === cosponsor.gAda()
                  ) {
                    console.log(
                      `        🎯 FOUND gAda token (alt method)! Amount: ${amount}`,
                    );
                  }
                }
              } else {
                console.log(`        Assets object type:`, typeof assets);
                console.log(`        Assets:`, assets);
              }
            }

            console.log(`    Assets in this output: ${assetsInThisOutput}`);
          } else {
            console.log(`    No native assets`);
          }
        } else {
          console.log(`  Output ${i}: Already spent or doesn't exist`);
          break;
        }
      } catch (e) {
        console.log(`  Output ${i}: Error - ${e.message}`);
        break;
      }
    }

    console.log(`\n📊 Summary:`);
    console.log(`  Script UTxO found: ${foundScriptUtxo}`);
    console.log(`  Total tokens found: ${totalTokensFound}`);
    console.log(`  Expected policy: ${cosponsor.script().hash()}`);
    console.log(`  Expected asset: ${cosponsor.gAda()}`);
  } catch (error) {
    console.error("Failed to inspect deposit:", error);
  } finally {
    if (cardanoProvider) {
      await cardanoProvider.cleanup();
    }
  }
};

const main = async () => {
  const depositTxHash =
    process.argv[2] ||
    "10386c278fd4eb72bbbe3bdaa2b52488ac0e43b69bb73025b15f8bab42bf3854";

  if (!depositTxHash) {
    console.error("Please provide deposit transaction hash:");
    console.error("  bun run inspect-deposit <tx_hash>");
    process.exit(1);
  }

  await inspectDeposit(depositTxHash);
};

// Run main if this script is executed directly
if (
  process.argv[1] &&
  import.meta.url.includes(process.argv[1].replace(/\\/g, "/"))
) {
  main().catch(console.error);
}
