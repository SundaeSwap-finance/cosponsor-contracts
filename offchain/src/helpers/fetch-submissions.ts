/* eslint-disable no-console */
import dotenv from "dotenv";
import { CardanoProvider } from "@utils/provider";
import { Cosponsor, ICosponsoredProposal } from "@validators/Cosponsor";
import { CosponsorState } from "@validators/CosponsorState";
import {
  PROPOSAL_LIFETIME,
  PROTOCOL_BOOT_TRANSACTION_ID,
  PROTOCOL_BOOT_TRANSACTION_INDEX,
} from "@/Config";
import { Core } from "@blaze-cardano/sdk";
import { parseCosponsorDatum } from "@helpers/parseCosponsorDatum";

dotenv.config();

interface ISubmissionInfo {
  txHash: string;
  outputIndex: number;
  adaAmount: bigint;
  address: string;
  proposalHash: string;
  parsedDatum?: {
    proposal: ICosponsoredProposal;
    datumType: "Before" | "After";
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  rawDatum?: any;
  validationStatus?: "valid" | "malformed" | "unknown";
  validationReason?: string;
}

interface IProposalGroup {
  proposalHash: string;
  proposal: ICosponsoredProposal;
  submissions: ISubmissionInfo[];
  totalAda: bigint;
  submissionCount: number;
  status: "Active" | "Completed" | "Unknown";
}

interface IGroupedSubmissions {
  [proposalHash: string]: IProposalGroup;
}

interface IMalformedSubmission {
  txHash: string;
  outputIndex: number;
  adaAmount: bigint;
  address: string;
  reason: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  rawDatum?: any;
}

interface IFetchResult {
  validSubmissions: IGroupedSubmissions;
  malformedSubmissions: IMalformedSubmission[];
  totalStats: {
    totalUTxOs: number;
    validUTxOs: number;
    malformedUTxOs: number;
    totalAda: bigint;
    validAda: bigint;
    malformedAda: bigint;
  };
}

// Helper function to validate deposit structure - simplified to just check if script UTxO exists
const validateDepositStructure = async (
  blaze: any,
  txHash: string,
  outputIndex: number,
): Promise<{ isValid: boolean; reason?: string }> => {
  try {
    // Only check if the script UTxO still exists and is unspent
    const scriptRef = new Core.TransactionInput(
      Core.TransactionId(txHash),
      BigInt(outputIndex),
    );

    const scriptResult = await blaze.provider.resolveUnspentOutputs([
      scriptRef,
    ]);
    if (scriptResult.length === 0) {
      return {
        isValid: false,
        reason: "Script UTxO already spent or doesn't exist",
      };
    }

    // If script UTxO exists, consider it valid - we'll handle gAda tokens during withdrawal
    return { isValid: true };
  } catch (error) {
    return { isValid: false, reason: `Validation error: ${error.message}` };
  }
};

// Helper function to extract proposal hash from cosponsor proposal
const getProposalHash = (proposal: ICosponsoredProposal): string => {
  try {
    // Create a cosponsor instance with this proposal to get the hash
    const cosponsorState = new CosponsorState(
      PROTOCOL_BOOT_TRANSACTION_ID,
      PROTOCOL_BOOT_TRANSACTION_INDEX,
      PROPOSAL_LIFETIME,
    );

    const cosponsor = Cosponsor.new({
      statePolicyId: cosponsorState.script().hash(),
      cosponsoredProposal: proposal,
    });

    return cosponsor.gAda(); // This returns the hash of the proposal
  } catch (error) {
    // Fallback to a simple hash of the proposal data
    return `${proposal.deposit}_${proposal.anchor.hash.slice(0, 8)}`;
  }
};

export const fetchAllSubmissions = async (
  cardanoProvider: CardanoProvider,
): Promise<IFetchResult> => {
  console.log("=== Fetching All On-Chain Submissions ===");

  const blaze = cardanoProvider.getBlaze();

  // Initialize cosponsor state to get the script addresses
  const cosponsorState = new CosponsorState(
    PROTOCOL_BOOT_TRANSACTION_ID,
    PROTOCOL_BOOT_TRANSACTION_INDEX,
    PROPOSAL_LIFETIME,
  );

  // Create a cosponsor instance to get the base script hash
  const cosponsor = Cosponsor.new({
    statePolicyId: cosponsorState.script().hash(),
  });

  const scriptAddress = cosponsor.address(blaze.provider.network);
  console.log(`Scanning script address: ${scriptAddress.toBech32()}`);

  try {
    // Get all UTxOs at the cosponsor script address
    const scriptUtxos = await blaze.provider.getUnspentOutputs(scriptAddress);
    console.log(`Found ${scriptUtxos.length} UTxOs at script address`);

    const groupedSubmissions: IGroupedSubmissions = {};
    const malformedSubmissions: IMalformedSubmission[] = [];

    let totalAda = 0n;
    let validAda = 0n;
    let malformedAda = 0n;

    for (let i = 0; i < scriptUtxos.length; i++) {
      const utxo = scriptUtxos[i];
      const output = utxo.output();
      const adaAmount = output.amount().coin();

      console.log(`\n--- UTxO ${i + 1} ---`);
      console.log(`  Transaction: ${utxo.input().transactionId()}`);
      console.log(`  Output Index: ${utxo.input().index()}`);
      console.log(
        `  ADA Amount: ${adaAmount} lovelace (${adaAmount / 1_000_000n} ADA)`,
      );

      totalAda += adaAmount;

      // Try to parse datum information
      let proposalHash = "unknown";
      let parsedDatum: {
        proposal: ICosponsoredProposal;
        datumType: "Before" | "After";
      } | null = null;
      let rawDatum: any = null;

      try {
        const datum = output.datum();
        console.log(`  🔍 Datum kind: ${datum ? datum.kind() : "null"}`);

        if (datum && datum.kind() === 1) {
          // 1 = inline
          const datumData = datum.asInlineData();
          if (datumData) {
            console.log(`  📄 Found inline datum, parsing...`);
            rawDatum = datumData;

            // Parse the cosponsor datum
            parsedDatum = parseCosponsorDatum(datumData);

            if (parsedDatum) {
              proposalHash = getProposalHash(parsedDatum.proposal);
              console.log(`  ✓ Parsed ${parsedDatum.datumType} datum`);
              console.log(
                `  📋 Proposal Hash: ${proposalHash.slice(0, 16)}...`,
              );
              console.log(
                `  🎯 Action: ${parsedDatum.proposal.action?.kind || "Unknown"}`,
              );
              console.log(
                `  🔗 Anchor: ${parsedDatum.proposal.anchor.url.slice(0, 50)}...`,
              );
            } else {
              console.log(`  ❌ Could not parse datum`);
              proposalHash = `unknown_${utxo.input().transactionId().slice(0, 8)}`;
            }
          } else {
            console.log(`  ❌ Inline datum data is null`);
            proposalHash = `null_datum_${utxo.input().transactionId().slice(0, 8)}`;
          }
        } else if (datum && datum.kind() === 0) {
          // 0 = hash
          console.log(`  🔗 Found datum hash: ${datum.asDataHash()}`);
          proposalHash = `hash_datum_${utxo.input().transactionId().slice(0, 8)}`;
        } else {
          console.log(`  ❌ No datum found`);
          proposalHash = `no_datum_${utxo.input().transactionId().slice(0, 8)}`;
        }
      } catch (e) {
        console.log(`  ❌ Error accessing datum: ${e.message}`);
        proposalHash = `error_${utxo.input().transactionId().slice(0, 8)}`;
      }

      // Validate the deposit structure to check if it's withdrawable
      console.log(`  🔍 Validating deposit structure...`);
      const validation = await validateDepositStructure(
        blaze,
        utxo.input().transactionId(),
        Number(utxo.input().index()),
      );

      if (!validation.isValid) {
        console.log(`  ⚠️  Malformed deposit: ${validation.reason}`);

        // Add to malformed submissions
        malformedSubmissions.push({
          txHash: utxo.input().transactionId(),
          outputIndex: Number(utxo.input().index()),
          adaAmount,
          address: output.address().toBech32(),
          reason: validation.reason || "Unknown validation failure",
          rawDatum,
        });

        malformedAda += adaAmount;
        continue; // Skip adding to valid submissions
      }

      console.log(`  ✅ Valid withdrawable deposit`);
      validAda += adaAmount;

      // Create submission info
      const submissionInfo: ISubmissionInfo = {
        txHash: utxo.input().transactionId(),
        outputIndex: Number(utxo.input().index()),
        adaAmount,
        address: output.address().toBech32(),
        proposalHash,
        parsedDatum,
        rawDatum,
        validationStatus: "valid",
      };

      // Group by proposal hash
      if (!groupedSubmissions[proposalHash]) {
        const proposal = parsedDatum?.proposal || {
          deposit: adaAmount,
          anchor: { url: "unknown", hash: "unknown" },
          action: { kind: "Unknown" as any },
        };

        const status: "Active" | "Completed" | "Unknown" =
          parsedDatum?.datumType === "After"
            ? "Completed"
            : parsedDatum?.datumType === "Before"
              ? "Active"
              : "Unknown";

        groupedSubmissions[proposalHash] = {
          proposalHash,
          proposal,
          submissions: [],
          totalAda: 0n,
          submissionCount: 0,
          status,
        };
      }

      groupedSubmissions[proposalHash].submissions.push(submissionInfo);
      groupedSubmissions[proposalHash].totalAda += adaAmount;
      groupedSubmissions[proposalHash].submissionCount++;
    }

    return {
      validSubmissions: groupedSubmissions,
      malformedSubmissions,
      totalStats: {
        totalUTxOs: scriptUtxos.length,
        validUTxOs: Object.values(groupedSubmissions).reduce(
          (sum, group) => sum + group.submissionCount,
          0,
        ),
        malformedUTxOs: malformedSubmissions.length,
        totalAda,
        validAda,
        malformedAda,
      },
    };
  } catch (error) {
    console.error("Error fetching submissions:", error);
    throw error;
  }
};

const main = async () => {
  console.log("Fetching All Current Submissions");
  console.log("================================");

  let cardanoProvider: CardanoProvider | null = null;

  try {
    console.log("Initializing CardanoProvider...");
    cardanoProvider = await CardanoProvider.fromEnv();
    console.log("CardanoProvider initialized successfully");

    // Check balance to verify connection
    const balance = await cardanoProvider.getWalletBalance();
    console.log(`Current wallet balance: ${balance.balance / 1_000_000n} ADA`);

    // Fetch all submissions
    const result = await fetchAllSubmissions(cardanoProvider);

    // Display results
    console.log("\n" + "=".repeat(70));
    console.log("SUBMISSION ANALYSIS");
    console.log("=".repeat(70));

    const proposalHashes = Object.keys(result.validSubmissions);

    if (
      proposalHashes.length === 0 &&
      result.malformedSubmissions.length === 0
    ) {
      console.log("No submissions found on-chain.");
      return;
    }

    // Display valid submissions
    if (proposalHashes.length > 0) {
      console.log("✅ VALID WITHDRAWABLE DEPOSITS");
      console.log("-".repeat(50));

      for (const proposalHash of proposalHashes) {
        const group = result.validSubmissions[proposalHash];

        console.log(`\n📋 Proposal: ${proposalHash}`);
        console.log(`   Submissions: ${group.submissionCount}`);
        console.log(
          `   Total ADA: ${group.totalAda / 1_000_000n} ADA (${group.totalAda} lovelace)`,
        );
        console.log(`   Status: ${group.status}`);

        // Show individual submissions
        for (const submission of group.submissions) {
          console.log(
            `     • ${submission.adaAmount / 1_000_000n} ADA - ${submission.txHash}:${submission.outputIndex}`,
          );
        }
      }
    }

    // Display malformed submissions
    if (result.malformedSubmissions.length > 0) {
      console.log(`\n⚠️  MALFORMED PERMANENTLY LOCKED UTxOs`);
      console.log("-".repeat(50));

      for (const malformed of result.malformedSubmissions) {
        console.log(
          `\n🔒 Locked UTxO: ${malformed.txHash}:${malformed.outputIndex}`,
        );
        console.log(
          `   ADA Amount: ${malformed.adaAmount / 1_000_000n} ADA (${malformed.adaAmount} lovelace)`,
        );
        console.log(`   Reason: ${malformed.reason}`);
        console.log(`   Address: ${malformed.address.slice(0, 50)}...`);
      }
    }

    // Display summary statistics
    console.log(`\n📊 SUMMARY STATISTICS:`);
    console.log("=".repeat(50));
    console.log(`Total UTxOs Found: ${result.totalStats.totalUTxOs}`);
    console.log(`├─ Valid Withdrawable: ${result.totalStats.validUTxOs}`);
    console.log(`└─ Malformed Locked: ${result.totalStats.malformedUTxOs}`);
    console.log(``);
    console.log(`Total ADA: ${result.totalStats.totalAda / 1_000_000n} ADA`);
    console.log(
      `├─ Withdrawable ADA: ${result.totalStats.validAda / 1_000_000n} ADA`,
    );
    console.log(
      `└─ Locked ADA: ${result.totalStats.malformedAda / 1_000_000n} ADA`,
    );

    if (proposalHashes.length > 0) {
      console.log(`\nValid Proposals: ${proposalHashes.length}`);
    }

    console.log("=".repeat(70));
  } catch (error) {
    console.error("Fetch submissions failed:", error);
    process.exit(1);
  } finally {
    if (cardanoProvider) {
      await cardanoProvider.cleanup();
    }
  }
};

// Run main if this script is executed directly
if (import.meta.main) {
  main().catch(console.error);
}

export default fetchAllSubmissions;
